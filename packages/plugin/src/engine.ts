// Synchronisation engine. Independent of Obsidian so it can be tested against the real server.
// See docs/design.md §8 and §9.
//
// A cycle has three steps:
//   1. pull      read the change feed and record which files changed remotely (`dirty`)
//   2. reconcile apply each dirty file to the vault, merging or keeping a conflict copy when both sides changed
//   3. push      upload local changes and queued deletions, each against the revision it was based on
//
// The cursor and `dirty` are saved together, so an interrupted cycle resumes without losing changes.

import {
    type Bytes,
    type FileMeta,
    type SyncConfig,
    type VaultKeys,
    DecryptError,
    PathFilter,
    conflictPath,
    effectiveConfig,
    fileId,
    fromB64,
    fromUtf8,
    isJson,
    isMergeableText,
    mergeJson,
    mergeText,
    normaliseConfig,
    open,
    aad,
    openContent,
    openMeta,
    sealContent,
    sealMeta,
    sha256Hex,
    toB64,
    utf8,
} from "@lite-sync/core";
import { type Api, ApiError, NetworkError, type WriteResult } from "./api.ts";

export interface LocalFile {
    path: string;
    mtime: number;
    size: number;
}

export interface VaultAdapter {
    list(): Promise<LocalFile[]>;
    stat(path: string): Promise<LocalFile | null>;
    read(path: string): Promise<Bytes>;
    // Creates missing folders. Returns the file's new stat.
    write(path: string, data: Bytes, mtime?: number): Promise<LocalFile>;
    trash(path: string): Promise<void>;
}

// Last synchronised state of one path. `hash` is null when the synchronised state is "deleted".
export interface IndexEntry {
    id: string;
    rev: number;
    hash: string | null;
    mtime: number;
    size: number;
}

export interface DirtyEntry {
    path: string;
    rev: number;
    deleted: boolean;
}

export interface SyncState {
    version: 1;
    cursor: number;
    index: Record<string, IndexEntry>;
    dirty: Record<string, DirtyEntry>; // by file ID
    pendingDeletes: Record<string, { renamedTo?: string }>; // by path
    config: { rev: number; json: unknown } | null;
}

export interface StateStore {
    load(): Promise<SyncState | null>;
    save(state: SyncState): Promise<void>;
}

export type SyncPhase = "idle" | "syncing" | "offline" | "error" | "needs-confirm" | "revoked";

export interface SyncStatus {
    phase: SyncPhase;
    pending: number;
    lastSyncAt: number | null;
    message: string | null;
    conflicts: string[]; // conflict copies created in this session
    guardCount: number; // destructive changes waiting for confirmation
}

export interface EngineOptions {
    api: Api;
    keys: VaultKeys;
    vault: VaultAdapter;
    store: StateStore;
    deviceName: string;
    clientVersion: string;
    mobile: boolean;
    isBusy?: (path: string) => boolean;
    log?: (message: string) => void;
    onStatus?: (status: SyncStatus) => void;
    now?: () => number;
}

const key = (path: string) => path.normalize("NFC");

export const emptyState = (): SyncState => ({ version: 1, cursor: 0, index: {}, dirty: {}, pendingDeletes: {}, config: null });

type Remote = { deleted: true; rev: number } | { deleted: false; rev: number; meta: FileMeta; data: Bytes };

export class SyncEngine {
    private o: EngineOptions;
    private state: SyncState = emptyState();
    private loaded = false;
    private running: Promise<void> | null = null;
    private again = false;
    private guardConfirmed = false;
    private hashCache = new Map<string, { mtime: number; size: number; hash: string }>();
    private filter = new PathFilter([]);
    private config: SyncConfig = normaliseConfig({});
    readonly status: SyncStatus = { phase: "idle", pending: 0, lastSyncAt: null, message: null, conflicts: [], guardCount: 0 };

    constructor(options: EngineOptions) {
        this.o = options;
    }

    get settings(): SyncConfig {
        return this.config;
    }

    get cursor(): number {
        return this.state.cursor;
    }

    private now() {
        return this.o.now ? this.o.now() : Date.now();
    }

    private log(msg: string) {
        this.o.log?.(msg);
    }

    private setStatus(patch: Partial<SyncStatus>) {
        Object.assign(this.status, patch);
        this.o.onStatus?.(this.status);
    }

    private async save() {
        await this.o.store.save(this.state);
    }

    private async ensureLoaded() {
        if (this.loaded) return;
        const s = await this.o.store.load();
        if (s && s.version === 1) this.state = { ...emptyState(), ...s };
        this.applyConfig();
        this.loaded = true;
    }

    private applyConfig() {
        this.config = effectiveConfig(normaliseConfig(this.state.config?.json ?? {}), this.o.mobile);
        this.filter = new PathFilter(this.config.exclude);
    }

    // ---- events from the host --------------------------------------------------------------

    async noteDeleted(path: string) {
        await this.ensureLoaded();
        const e = this.state.index[key(path)];
        // The engine marks a path as deleted before trashing it, so its own deletions are ignored here.
        if (!e || e.hash === null) return;
        this.state.pendingDeletes[key(path)] = {};
        await this.save();
    }

    async noteRenamed(oldPath: string, newPath: string) {
        await this.ensureLoaded();
        const e = this.state.index[key(oldPath)];
        if (e && e.hash !== null && this.filter.accepts(oldPath)) {
            this.state.pendingDeletes[key(oldPath)] = { renamedTo: key(newPath) };
            await this.save();
        }
    }

    confirmMassChange() {
        this.guardConfirmed = true;
    }

    // Forgets the cursor and re-checks every remote file against the vault. Never overwrites local edits.
    async rescan() {
        await this.ensureLoaded();
        this.state.cursor = 0;
        this.hashCache.clear();
        await this.save();
    }

    // ---- cycle -----------------------------------------------------------------------------

    sync(): Promise<void> {
        if (this.running) {
            this.again = true;
            return this.running;
        }
        this.running = (async () => {
            try {
                do {
                    this.again = false;
                    await this.cycle();
                } while (this.again);
            } finally {
                this.running = null;
            }
        })();
        return this.running;
    }

    private async cycle() {
        await this.ensureLoaded();
        this.setStatus({ phase: "syncing", message: null });
        try {
            await this.loadConfig();
            await this.pull();
            const guarded = await this.reconcile();
            const pending = await this.push();
            // Moves the cursor past our own uploads, so the reported progress includes them, and applies
            // files which a push conflict marked for download.
            await this.pull();
            if (guarded === 0 && Object.keys(this.state.dirty).length > 0) await this.reconcile();
            this.o.api.status({ pending, seq: this.state.cursor, clientVersion: this.o.clientVersion }).catch(() => {});
            this.setStatus({
                phase: guarded > 0 ? "needs-confirm" : "idle",
                pending,
                lastSyncAt: this.now(),
                guardCount: guarded,
                message: guarded > 0 ? `${guarded} 个文件将被删除或覆盖，等待确认` : null,
            });
        } catch (e) {
            if (e instanceof NetworkError || (e instanceof ApiError && (e.code === "server" || e.status === 429))) {
                this.setStatus({ phase: "offline", message: e.message });
            } else if (e instanceof ApiError && e.status === 401) {
                this.setStatus({ phase: "revoked", message: "设备已被吊销或令牌无效" });
            } else {
                this.setStatus({ phase: "error", message: e instanceof Error ? e.message : String(e) });
                this.log(`同步出错: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
            }
        } finally {
            await this.save();
        }
    }

    private async loadConfig() {
        const doc = await this.o.api.config();
        if (!doc.blob || doc.rev === this.state.config?.rev) return;
        try {
            const json = JSON.parse(fromUtf8(await open(this.o.keys.config, fromB64(doc.blob), aad.config(doc.rev)))) as unknown;
            this.state.config = { rev: doc.rev, json };
            this.applyConfig();
            this.log(`已加载统一配置 rev ${doc.rev}`);
        } catch (e) {
            this.log(`统一配置无法解密，继续使用缓存配置: ${String(e)}`);
        }
    }

    private idToPath(id: string): string | null {
        for (const [p, e] of Object.entries(this.state.index)) if (e.id === id) return p;
        return null;
    }

    private async pull() {
        for (;;) {
            const page = await this.o.api.changes(this.state.cursor);
            for (const c of page.changes) {
                let path: string | null;
                if (c.deleted || !c.meta) path = this.idToPath(c.id);
                else {
                    try {
                        path = key((await openMeta(this.o.keys, c.id, c.rev, c.meta)).path);
                    } catch (e) {
                        this.log(`跳过无法解密的变更 ${c.id.slice(0, 12)} rev ${c.rev}: ${String(e)}`);
                        continue;
                    }
                }
                if (!path) continue;
                const e = this.state.index[path];
                if (e && e.id === c.id && e.rev >= c.rev) continue; // already applied, usually our own write
                this.state.dirty[c.id] = { path, rev: c.rev, deleted: c.deleted };
            }
            this.state.cursor = page.next;
            await this.save();
            if (!page.more) break;
        }
    }

    private async localHash(path: string, st: LocalFile): Promise<string> {
        const e = this.state.index[key(path)];
        if (e && e.hash && e.mtime === st.mtime && e.size === st.size) return e.hash;
        const c = this.hashCache.get(key(path));
        if (c && c.mtime === st.mtime && c.size === st.size) return c.hash;
        const hash = await sha256Hex(await this.o.vault.read(path));
        this.hashCache.set(key(path), { mtime: st.mtime, size: st.size, hash });
        return hash;
    }

    private setIndex(path: string, id: string, rev: number, hash: string | null, st: LocalFile | null) {
        this.state.index[key(path)] = { id, rev, hash, mtime: st?.mtime ?? 0, size: st?.size ?? 0 };
    }

    private async fetchRemote(id: string, rev?: number): Promise<Remote | null> {
        const r = await this.o.api.get(id, rev);
        if (!r) return null;
        if (r.deleted) return r;
        const meta = await openMeta(this.o.keys, id, r.rev, r.meta);
        if ((await fileId(this.o.keys, meta.path)) !== id) throw new DecryptError("File ID does not match its path");
        const data = await openContent(this.o.keys, id, r.rev, r.data);
        if ((await sha256Hex(data)) !== meta.hash) throw new DecryptError("Content hash mismatch");
        return { deleted: false, rev: r.rev, meta, data };
    }

    // Returns the number of destructive changes held back by the mass-change guard.
    private async reconcile(): Promise<number> {
        const items = Object.entries(this.state.dirty);
        if (items.length === 0) return 0;

        // Count deletions and overwrites of differing local files before touching anything.
        const destructive = new Set<string>();
        for (const [id, d] of items) {
            const st = await this.o.vault.stat(d.path);
            const e = this.state.index[d.path];
            if (!st || !e?.hash) continue;
            if ((await this.localHash(d.path, st)) === e.hash) destructive.add(id);
        }
        const hold = destructive.size > this.config.sync.massChangeGuard && !this.guardConfirmed;
        if (!hold) this.guardConfirmed = false;

        for (const [id, d] of items) {
            if (hold && destructive.has(id)) continue;
            if (this.o.isBusy?.(d.path)) continue;
            try {
                await this.reconcileOne(id, d);
                delete this.state.dirty[id];
            } catch (e) {
                if (e instanceof DecryptError) {
                    this.log(`跳过无法解密或校验失败的文件 ${d.path}: ${e.message}`);
                    delete this.state.dirty[id];
                } else throw e;
            }
            await this.save();
        }
        return hold ? destructive.size : 0;
    }

    private async reconcileOne(id: string, d: DirtyEntry) {
        const path = d.path;
        const remote = await this.fetchRemote(id);
        if (!remote) return;
        const e = this.state.index[path];
        if (e && e.id === id && e.rev >= remote.rev) return;
        const st = await this.o.vault.stat(path);

        if (remote.deleted) {
            if (!st) return this.setIndex(path, id, remote.rev, null, null);
            const h = await this.localHash(path, st);
            if (e?.hash && h === e.hash) {
                this.setIndex(path, id, remote.rev, null, null); // before trashing, see noteDeleted()
                await this.save();
                await this.o.vault.trash(path);
                this.log(`已删除（来自其他设备）: ${path}`);
            } else {
                // Modified here or of unknown origin: keep it. Push re-uploads it on top of the deletion.
                this.state.index[path] = { id, rev: remote.rev, hash: null, mtime: 0, size: 0 };
                this.log(`保留本地修改，覆盖远端删除: ${path}`);
            }
            return;
        }

        if (!st) {
            if (this.state.pendingDeletes[path]) return; // push decides: delete, or keep the remote edit
            const written = await this.o.vault.write(remote.meta.path, remote.data, remote.meta.mtime);
            this.setIndex(path, id, remote.rev, remote.meta.hash, written);
            this.log(`已下载: ${path}`);
            return;
        }
        const h = await this.localHash(path, st);
        if (h === remote.meta.hash) return this.setIndex(path, id, remote.rev, h, st);
        if (e?.hash && h === e.hash) {
            const written = await this.o.vault.write(path, remote.data, remote.meta.mtime);
            this.setIndex(path, id, remote.rev, remote.meta.hash, written);
            this.log(`已更新: ${path}`);
            return;
        }
        await this.resolve(path, id, await this.o.vault.read(path), h, remote, e);
    }

    // Both sides changed. Merges text and JSON from the last synchronised version, otherwise keeps the
    // remote version at the path and the local version as a conflict copy. Never discards either side.
    private async resolve(
        path: string,
        id: string,
        local: Bytes,
        localHash: string,
        remote: Extract<Remote, { deleted: false }>,
        entry: IndexEntry | undefined
    ) {
        let merged: string | null = null;
        if (entry?.hash && entry.id === id && (isMergeableText(path) || isJson(path))) {
            try {
                const base = await this.fetchRemote(id, entry.rev);
                if (base && !base.deleted && base.meta.hash === entry.hash) {
                    const [b, l, r] = [fromUtf8(base.data), fromUtf8(local), fromUtf8(remote.data)];
                    const m = isJson(path) ? mergeJson(b, l, r) : mergeText(b, l, r);
                    if (m.ok) merged = m.text;
                }
            } catch (e) {
                // Binary content (invalid UTF-8) or an unreadable base: fall through to a conflict copy.
                if (!(e instanceof TypeError || e instanceof DecryptError)) throw e;
            }
        }

        if (merged !== null) {
            const data = utf8(merged);
            const hash = await sha256Hex(data);
            const written = await this.o.vault.write(path, data);
            if (hash === remote.meta.hash) return this.setIndex(path, id, remote.rev, hash, written);
            const w = await this.upload(path, data, hash, remote.rev, written);
            if (w.ok) this.setIndex(path, id, w.rev, hash, written);
            else this.state.dirty[id] = { path, rev: w.conflict.rev, deleted: w.conflict.deleted };
            this.log(`已自动合并: ${path}`);
            return;
        }

        const copy = conflictPath(remote.meta.path, this.o.deviceName, new Date(this.now()));
        await this.o.vault.write(copy, local); // keep the local version first
        const written = await this.o.vault.write(path, remote.data, remote.meta.mtime);
        this.setIndex(path, id, remote.rev, remote.meta.hash, written);
        this.hashCache.set(key(copy), { ...(await this.o.vault.stat(copy))!, hash: localHash });
        this.setStatus({ conflicts: [...this.status.conflicts, copy] });
        this.log(`冲突，已保留本地版本为: ${copy}`);
    }

    private async upload(path: string, data: Bytes, hash: string, baseRev: number, st: LocalFile): Promise<WriteResult> {
        const id = await fileId(this.o.keys, path);
        const rev = baseRev + 1;
        const meta = await sealMeta(this.o.keys, id, rev, { path, mtime: st.mtime, size: data.byteLength, hash });
        return this.o.api.put(id, baseRev, meta, await sealContent(this.o.keys, id, rev, data));
    }

    // Returns the number of local changes still waiting to be uploaded.
    private async push(): Promise<number> {
        let pending = 0;
        const maxBytes = this.config.sync.maxFileSizeMB * 1024 * 1024;
        const files = await this.o.vault.list();
        const present = new Set(files.map((f) => key(f.path)));

        await this.pushDeletes(present);

        for (const f of files) {
            const p = key(f.path);
            if (!this.filter.accepts(f.path) || f.size > maxBytes) continue;
            if (this.o.isBusy?.(f.path)) {
                pending++;
                continue;
            }
            const e = this.state.index[p];
            const id = e?.id ?? (await fileId(this.o.keys, f.path));
            if (this.state.dirty[id]) {
                pending++; // remote change waiting to be reconciled first
                continue;
            }
            const h = await this.localHash(f.path, f);
            if (e && e.hash === h) {
                if (e.mtime !== f.mtime || e.size !== f.size) this.setIndex(p, e.id, e.rev, h, f);
                continue;
            }
            const data = await this.o.vault.read(f.path);
            if ((await sha256Hex(data)) !== h) {
                pending++; // changed while reading; the next cycle picks it up
                continue;
            }
            const w = await this.upload(f.path, data, h, e?.rev ?? 0, f);
            if (w.ok) {
                this.setIndex(p, id, w.rev, h, f);
                this.log(`已上传: ${f.path}`);
            } else {
                const remote = await this.fetchRemote(id);
                if (remote && !remote.deleted) await this.resolve(p, id, data, h, remote, e);
                else if (remote?.deleted) {
                    // Deleted elsewhere but edited here: the edit wins.
                    const again = await this.upload(f.path, data, h, remote.rev, f);
                    if (again.ok) this.setIndex(p, id, again.rev, h, f);
                    else pending++;
                }
            }
            await this.save();
        }

        // A file the index knows but the vault lacks, without a deletion event, is restored rather than
        // deleted remotely. iCloud and external tools can remove files without the user deleting them.
        for (const [p, e] of Object.entries(this.state.index)) {
            if (e.hash === null || present.has(p) || this.state.pendingDeletes[p] || !this.filter.accepts(p)) continue;
            if (this.state.dirty[e.id]) continue;
            const remote = await this.fetchRemote(e.id).catch((err) => {
                if (err instanceof DecryptError) return null;
                throw err;
            });
            if (!remote || remote.deleted) {
                this.setIndex(p, e.id, remote?.rev ?? e.rev, null, null);
                continue;
            }
            const written = await this.o.vault.write(remote.meta.path, remote.data, remote.meta.mtime);
            this.setIndex(p, e.id, remote.rev, remote.meta.hash, written);
            this.log(`本地缺失，已从服务器恢复: ${p}`);
            await this.save();
        }

        return pending + Object.keys(this.state.pendingDeletes).length;
    }

    private async pushDeletes(present: Set<string>) {
        for (const [p, info] of Object.entries(this.state.pendingDeletes)) {
            const e = this.state.index[p];
            if (present.has(p) || !e || e.hash === null) {
                delete this.state.pendingDeletes[p]; // recreated, or nothing to delete
                continue;
            }
            const target = info.renamedTo;
            const st = target && present.has(target) ? await this.o.vault.stat(target) : null;
            if (target && st && !this.state.index[target]) {
                // Rename: create the new path and delete the old one in one atomic batch.
                const data = await this.o.vault.read(target);
                const hash = await sha256Hex(data);
                const newId = await fileId(this.o.keys, target);
                const meta = await sealMeta(this.o.keys, newId, 1, { path: target, mtime: st.mtime, size: data.byteLength, hash });
                const blob = await sealContent(this.o.keys, newId, 1, data);
                const r = await this.o.api.batch([
                    { op: "put", id: newId, baseRev: 0, meta, data: toB64(blob) },
                    { op: "delete", id: e.id, baseRev: e.rev },
                ]);
                if (r.ok) {
                    this.setIndex(target, newId, r.results[0]!.rev, hash, st);
                    this.setIndex(p, e.id, r.results[1]!.rev, null, null);
                    delete this.state.pendingDeletes[p];
                    this.log(`已重命名: ${p} → ${target}`);
                    await this.save();
                    continue;
                }
                // Fall back to separate operations below; the new path is uploaded by the scan.
            }
            const w = await this.o.api.remove(e.id, e.rev);
            delete this.state.pendingDeletes[p];
            if (w.ok) {
                this.setIndex(p, e.id, w.rev, null, null);
                this.log(`已删除: ${p}`);
            } else if (!w.conflict.deleted) {
                // Changed elsewhere after our last sync: keep that version instead of deleting it.
                this.state.dirty[e.id] = { path: p, rev: w.conflict.rev, deleted: false };
                this.log(`远端已修改，取消删除并重新下载: ${p}`);
            } else {
                this.setIndex(p, e.id, w.conflict.rev, null, null);
            }
            await this.save();
        }
    }
}
