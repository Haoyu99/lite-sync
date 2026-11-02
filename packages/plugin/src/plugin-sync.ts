import {
    type PluginBundle, type PluginPackageHead, type SyncConfig, type VaultKeys,
    fileId, fromUtf8, mergeJson, open, parsePluginBundle, pluginBundleAad, seal, sha256Hex, utf8,
} from "@lite-sync/core";
import type { Api } from "./api.ts";

export interface PluginIndex {
    rev: number;
    hash: string;
    data?: string;
    uninstalled?: boolean;
    localOnly?: boolean;
    unsupported?: boolean;
}
export interface PluginSyncState { version: 1; joined: boolean; index: Record<string, PluginIndex> }
export interface PluginHost {
    list(exclude?: readonly string[]): Promise<PluginBundle[]>;
    // Implementations preserve local backups, check for edits during apply, and roll back failed writes.
    apply(bundle: PluginBundle, expected: PluginBundle | null): Promise<void>;
    backup(bundle: PluginBundle): Promise<void>;
}
export interface PluginSyncOptions {
    api: Api;
    keys: VaultKeys;
    deviceId: string;
    mobile: boolean;
    host: PluginHost;
    load(): Promise<PluginSyncState | null>;
    save(state: PluginSyncState): Promise<void>;
    progress(message: string): void;
    log(message: string): void;
}
export interface PluginSyncResult { uploaded: number; applied: number; conflicts: number; waiting: boolean }
const serialise = (b: PluginBundle) => JSON.stringify({ id: b.id, files: Object.fromEntries(Object.entries(b.files).sort(([a], [b]) => a.localeCompare(b))) });
export const bundleHash = (b: PluginBundle) => sha256Hex(utf8(serialise(b)));
const withoutData = (b: PluginBundle): PluginBundle => ({ id: b.id, files: Object.fromEntries(Object.entries(b.files).filter(([name]) => name !== "data.json")) });

export class PluginSync {
    private o: PluginSyncOptions;
    private running: Promise<PluginSyncResult> | null = null;
    private syncData = true;
    constructor(options: PluginSyncOptions) { this.o = options; }
    sync(config: SyncConfig): Promise<PluginSyncResult> {
        if (this.running) return this.running;
        this.running = this.cycle(config).finally(() => { this.running = null; });
        return this.running;
    }
    private async cycle(config: SyncConfig): Promise<PluginSyncResult> {
        const result: PluginSyncResult = { uploaded: 0, applied: 0, conflicts: 0, waiting: false };
        if (!config.obsidian.enabled || !config.obsidian.communityPlugins) return result;
        const o = this.o;
        const state = await o.load() ?? { version: 1, joined: false, index: {} };
        const includesData = config.obsidian.pluginData;
        this.syncData = includesData;
        const allowed = (b: PluginBundle) => !config.obsidian.excludePlugins.includes(b.id);
        const prepare = (b: PluginBundle) => includesData ? b : withoutData(b);
        const rawLocal = (await o.host.list(config.obsidian.excludePlugins)).filter(allowed);
        const local = new Map(await Promise.all(rawLocal.map(async (b) => [await this.id(b.id), prepare(b)] as const)));
        const catalog = await o.api.pluginCatalog(true);
        const seededHere = catalog.seedDevice === o.deviceId && !catalog.ready;
        if (!catalog.ready && !seededHere) {
            o.progress("等待首台设备完成插件初始化");
            return { ...result, waiting: true };
        }
        const remoteHeads = new Map(catalog.packages.map((p) => [p.id, p]));
        if (seededHere) {
            let count = 0;
            for (const [id, bundle] of local) {
                o.progress(`首次上传插件 ${++count}/${local.size} · ${bundle.id}`);
                const hash = await bundleHash(bundle);
                const head = remoteHeads.get(id);
                if (head && state.index[id]?.hash === hash && state.index[id]?.rev === head.rev) continue;
                const rev = await this.upload(id, head?.rev ?? 0, bundle);
                if (rev === null) throw new Error("插件初始化版本发生变化，请重试");
                state.index[id] = { rev, hash, data: bundle.files["data.json"] };
                await o.save(state);
                result.uploaded++;
            }
            await o.api.completePluginSeed();
            state.joined = true;
            await o.save(state);
            return result;
        }

        // Existing local-only plugins remain local on a joining device. Later changes can be published.
        if (!state.joined) {
            for (const [id, bundle] of local) if (!remoteHeads.has(id))
                state.index[id] = { rev: 0, hash: await bundleHash(bundle), localOnly: true, data: bundle.files["data.json"] };
        }
        let processed = 0;
        for (const head of catalog.packages) {
            o.progress(`正在同步插件 ${++processed}/${catalog.packages.length}…`);
            const current = local.get(head.id) ?? null;
            const entry = state.index[head.id];
            // A disappearance after installation means local uninstall, never a remote deletion.
            if (!current && entry && !entry.unsupported) {
                entry.uninstalled = true;
                continue;
            }
            if (entry?.uninstalled && !current) continue;
            if (entry?.unsupported && entry.rev === head.rev) continue;
            const hash = current ? await bundleHash(current) : null;
            if (entry && !entry.unsupported && head.rev === entry.rev) {
                if (current && hash !== entry.hash) {
                    o.progress(`正在上传插件配置 · ${current.id}`);
                    const rev = await this.upload(head.id, entry.rev, current);
                    if (rev !== null) {
                        state.index[head.id] = { rev, hash: hash!, data: current.files["data.json"] };
                        result.uploaded++;
                    } else result.waiting = true;
                }
                await o.save(state);
                continue;
            }
            const downloaded = await this.download(head);
            if (!allowed(downloaded.bundle)) continue;
            const remote = prepare(downloaded.bundle);
            if (o.mobile && JSON.parse(remote.files["manifest.json"]!).isDesktopOnly === true) {
                state.index[head.id] = { rev: downloaded.rev, hash: "", unsupported: true };
                continue;
            }
            let chosen = remote;
            if (current && entry && !entry.unsupported && hash !== entry.hash) {
                await o.host.backup(current);
                const base = entry.data;
                const l = current.files["data.json"], r = remote.files["data.json"];
                if (includesData && base !== undefined && l !== undefined && r !== undefined) {
                    const merged = mergeJson(base, l, r);
                    if (merged.ok) {
                        chosen = { id: remote.id, files: { ...remote.files, "data.json": merged.text } };
                        result.conflicts += merged.conflicts;
                    } else result.conflicts++;
                } else result.conflicts++;
                o.log(`插件 ${remote.id} 两端均有修改，已备份本地版本并合并配置`);
            }
            o.progress(`正在安装 / 更新插件 · ${remote.id}`);
            const appliedHash = await bundleHash(chosen);
            if (hash !== appliedHash) {
                // Config opt-out preserves that device's data.json rather than deleting it.
                const original = rawLocal.find((b) => b.id === chosen.id) ?? null;
                const applyBundle = !includesData && original?.files["data.json"] !== undefined
                    ? { id: chosen.id, files: { ...chosen.files, "data.json": original.files["data.json"] } } : chosen;
                await o.host.apply(applyBundle, original);
                result.applied++;
            }
            state.index[head.id] = { rev: downloaded.rev, hash: appliedHash, data: chosen.files["data.json"] };
            // Record the remote baseline first. If publishing a merge races, the next scan retries safely.
            if (await bundleHash(remote) !== appliedHash) {
                const rev = await this.upload(head.id, downloaded.rev, chosen);
                if (rev !== null) state.index[head.id]!.rev = rev;
                else state.index[head.id] = { rev: downloaded.rev, hash: await bundleHash(remote), data: remote.files["data.json"] };
            }
            await o.save(state);
        }
        for (const [id, bundle] of local) {
            if (remoteHeads.has(id)) continue;
            const hash = await bundleHash(bundle);
            const entry = state.index[id];
            if (entry?.localOnly && entry.hash === hash) continue;
            o.progress(`正在上传新插件 · ${bundle.id}`);
            const rev = await this.upload(id, 0, bundle);
            if (rev !== null) {
                state.index[id] = { rev, hash, data: bundle.files["data.json"] };
                result.uploaded++;
            } else result.waiting = true;
        }
        state.joined = true;
        await o.save(state);
        return result;
    }
    private id(pluginId: string) { return fileId(this.o.keys, `lite-sync/plugin-packages/${pluginId}`); }
    private async upload(id: string, base: number, bundle: PluginBundle) {
        if (!this.syncData && base > 0) {
            const remote = await this.download({ id, rev: base, updatedAt: 0 });
            if (remote.rev !== base) return null;
            const data = remote.bundle.files["data.json"];
            if (data !== undefined) bundle = { id: bundle.id, files: { ...bundle.files, "data.json": data } };
        }
        const data = await seal(this.o.keys.config, utf8(serialise(bundle)), pluginBundleAad(id, base + 1));
        return this.o.api.putPluginPackage(id, base, data);
    }
    private async download(head: PluginPackageHead) {
        const res = await this.o.api.getPluginPackage(head.id);
        const bundle = parsePluginBundle(JSON.parse(fromUtf8(await open(this.o.keys.config, res.data, pluginBundleAad(head.id, res.rev)))));
        if (await this.id(bundle.id) !== head.id) throw new Error("插件包 ID 校验失败");
        return { bundle, rev: res.rev };
    }
}
