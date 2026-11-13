// Two simulated devices synchronising through the real server.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { type Bytes, type VaultKeys, deriveVaultKeys, fromUtf8, newMasterKey, utf8, windowsPathProblem } from "@lite-sync/core";
import { ServerKey, newToken, sha256Hex } from "../../server/src/auth.ts";
import { createApp } from "../../server/src/app.ts";
import { Db } from "../../server/src/db.ts";
import { Api, type Http } from "../src/api.ts";
import { type EngineOptions, type LocalFile, type StateStore, type SyncState, type SyncStatus, SyncEngine, type VaultAdapter } from "../src/engine.ts";

let clock = Date.UTC(2026, 9, 30, 12, 0, 0);
const tick = () => (clock += 1000);

class MemoryVault implements VaultAdapter {
    files = new Map<string, { data: Bytes; mtime: number }>();
    async exists(path: string) {
        return this.files.has(path) || [...this.files.keys()].some((p) => p.startsWith(path + "/"));
    }
    async list(): Promise<LocalFile[]> {
        return [...this.files].map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
    }
    async stat(path: string) {
        const f = this.files.get(path);
        return f ? { path, mtime: f.mtime, size: f.data.byteLength } : null;
    }
    async read(path: string) {
        const f = this.files.get(path);
        if (!f) throw new Error(`ENOENT ${path}`);
        return f.data;
    }
    async write(path: string, data: Bytes, mtime?: number) {
        this.files.set(path, { data, mtime: mtime ?? tick() });
        return (await this.stat(path))!;
    }
    async trash(path: string) {
        this.files.delete(path);
    }
    // User edits
    set(path: string, text: string) {
        this.files.set(path, { data: utf8(text), mtime: tick() });
    }
    text(path: string) {
        const f = this.files.get(path);
        return f ? fromUtf8(f.data) : undefined;
    }
    paths() {
        return [...this.files.keys()].sort();
    }
}

class MemoryStore implements StateStore {
    state: SyncState | null = null;
    async load() {
        return this.state ? structuredClone(this.state) : null;
    }
    async save(s: SyncState) {
        this.state = structuredClone(s);
    }
}

describe("sync engine", () => {
    let dir: string;
    let db: Db;
    let http: Http;
    let keys: VaultKeys;

    const device = (name: string, overrides: Partial<EngineOptions> = {}, timeoutMs = 30_000) => {
        const token = newToken();
        db.run(
            "INSERT INTO devices (id, name, platform, client_version, token_hash, created_at) VALUES (?, ?, 'macos', '0.1.0', ?, ?)",
            name, name, sha256Hex(token), clock
        );
        const vault = new MemoryVault();
        const logs: string[] = [];
        const statuses: SyncStatus[] = [];
        const store = new MemoryStore();
        const options: EngineOptions = {
            api: new Api(http, "http://test", token, timeoutMs),
            keys,
            vault,
            store,
            deviceName: name,
            clientVersion: "0.1.0",
            mobile: false,
            log: (m) => logs.push(m),
            onStatus: (status) => statuses.push(structuredClone(status)),
            now: () => clock,
            ...overrides,
        };
        const engine = new SyncEngine(options);
        return { engine, vault, store, logs, statuses, restart: () => new SyncEngine(options) };
    };

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), "lite-sync-engine-"));
        db = new Db(dir);
        const { app } = createApp({ db, serverKey: new ServerKey("x".repeat(40)), now: () => clock });
        http = async (req) => {
            const res = await app.request(req.url, { method: req.method, headers: req.headers, body: req.body });
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
            return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
        };
        keys = await deriveVaultKeys(newMasterKey());
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("reports file progress and counts only actual transfers", async () => {
        const a = device("Mac");
        const b = device("Phone");
        a.vault.set("notes/a.md", "hello");
        a.vault.set("notes/b.md", "world");
        await a.engine.sync();
        assert.equal(a.engine.status.uploaded, 2);
        assert.ok(a.statuses.some((s) => s.progress?.action === "正在上传" && s.progress.path === "notes/a.md" && s.progress.total === 2));
        assert.equal(a.engine.status.progress, null);
        await b.engine.sync();
        assert.equal(b.engine.status.downloaded, 2);
        assert.ok(b.statuses.some((s) => s.progress?.action === "正在下载 / 更新" && s.progress.total === 2));
        await a.engine.sync();
        assert.equal(a.engine.status.uploaded, 0, "an unchanged scan is not an upload");
        a.vault.set("notes/a.md", "edited");
        await a.engine.sync();
        await b.engine.sync();
        assert.equal(b.engine.status.updated, 1);
        assert.equal(b.engine.status.pending, 0);
    });

    it("propagates a new file and an edit", async () => {
        const a = device("Mac");
        const b = device("iPhone");
        a.vault.set("1. Daily/2026-10-30.md", "hello\n");
        await a.engine.sync();
        await b.engine.sync();
        assert.equal(b.vault.text("1. Daily/2026-10-30.md"), "hello\n");

        b.vault.set("1. Daily/2026-10-30.md", "hello\nfrom phone\n");
        await b.engine.sync();
        await a.engine.sync();
        assert.equal(a.vault.text("1. Daily/2026-10-30.md"), "hello\nfrom phone\n");
        assert.equal(a.engine.status.phase, "idle");
        assert.equal(a.engine.status.pending, 0);
    });

    it("stores only ciphertext on the server", async () => {
        const a = device("Mac");
        a.vault.set("秘密/日记.md", "我的秘密内容");
        await a.engine.sync();
        const row = db.get<{ object: string; meta: string }>("SELECT object, meta FROM versions")!;
        const blob = db.objects.getSync(row.object).toString("latin1");
        assert.equal(blob.includes("秘密"), false);
        assert.equal(Buffer.from(row.meta, "base64").toString("utf8").includes("日记"), false);
        const [file] = db.all<{ id: string }>("SELECT id FROM files");
        assert.match(file!.id, /^[0-9a-f]{64}$/, "server sees only an opaque file ID");
    });

    it("merges concurrent edits to different lines", async () => {
        const a = device("Mac");
        const b = device("iPhone");
        a.vault.set("note.md", "line 1\nline 2\nline 3\n");
        await a.engine.sync();
        await b.engine.sync();

        a.vault.set("note.md", "line 1 (Mac)\nline 2\nline 3\n");
        b.vault.set("note.md", "line 1\nline 2\nline 3 (iPhone)\n");
        await a.engine.sync();
        await b.engine.sync();
        await a.engine.sync();

        const expected = "line 1 (Mac)\nline 2\nline 3 (iPhone)\n";
        assert.equal(b.vault.text("note.md"), expected);
        assert.equal(a.vault.text("note.md"), expected);
        assert.deepEqual(a.vault.paths(), ["note.md"], "no conflict copy");
    });

    it("keeps both versions when the same line changed on both devices", async () => {
        const a = device("Mac");
        const b = device("iPhone");
        a.vault.set("note.md", "title\n");
        await a.engine.sync();
        await b.engine.sync();

        a.vault.set("note.md", "title by Mac\n");
        b.vault.set("note.md", "title by iPhone\n");
        await a.engine.sync();
        await b.engine.sync();
        await a.engine.sync();

        const copy = b.vault.paths().find((p) => p.includes("冲突 iPhone"))!;
        assert.ok(copy, "conflict copy created on the device which lost the race");
        assert.equal(b.vault.text("note.md"), "title by Mac\n");
        assert.equal(b.vault.text(copy), "title by iPhone\n");
        assert.equal(a.vault.text(copy), "title by iPhone\n", "conflict copy is synchronised too");
        assert.deepEqual(b.engine.status.conflicts, [copy]);
    });

    it("propagates a deletion but keeps a file edited on the other device", async () => {
        const a = device("Mac");
        const b = device("iPhone");
        a.vault.set("gone.md", "x");
        a.vault.set("kept.md", "y");
        await a.engine.sync();
        await b.engine.sync();

        await a.vault.trash("gone.md");
        await a.engine.noteDeleted("gone.md");
        await a.vault.trash("kept.md");
        await a.engine.noteDeleted("kept.md");
        b.vault.set("kept.md", "y edited on phone");
        await a.engine.sync();
        await b.engine.sync();
        await a.engine.sync();

        assert.equal(b.vault.text("gone.md"), undefined);
        assert.equal(b.vault.text("kept.md"), "y edited on phone");
        assert.equal(a.vault.text("kept.md"), "y edited on phone", "edit wins over deletion");
    });

    it("restores a file that disappeared without a deletion event", async () => {
        const a = device("iPhone");
        a.vault.set("evicted.md", "still here");
        await a.engine.sync();
        await a.vault.trash("evicted.md"); // e.g. iCloud evicted it; no noteDeleted()
        await a.engine.sync();
        assert.equal(a.vault.text("evicted.md"), "still here");
        assert.equal(db.get<{ deleted: number }>("SELECT deleted FROM files")!.deleted, 0);
    });

    it("renames atomically", async () => {
        const a = device("Mac");
        const b = device("iPhone");
        a.vault.set("old name.md", "content");
        await a.engine.sync();
        await b.engine.sync();

        const f = a.vault.files.get("old name.md")!;
        a.vault.files.delete("old name.md");
        a.vault.files.set("folder/new name.md", f);
        await a.engine.noteRenamed("old name.md", "folder/new name.md");
        await a.engine.sync();
        await b.engine.sync();

        assert.deepEqual(b.vault.paths(), ["folder/new name.md"]);
        assert.equal(db.get<{ n: number }>("SELECT COUNT(DISTINCT batch_id) AS n FROM versions WHERE batch_id IS NOT NULL")!.n, 1);
    });

    it("joins a device with existing files without overwriting anything", async () => {
        const a = device("Mac");
        a.vault.set("same.md", "same");
        a.vault.set("differs.md", "Mac version");
        a.vault.set("only-mac.md", "m");
        await a.engine.sync();

        const b = device("Windows");
        b.vault.set("same.md", "same");
        b.vault.set("differs.md", "Windows version");
        b.vault.set("only-win.md", "w");
        await b.engine.sync();

        assert.equal(b.vault.text("differs.md"), "Mac version");
        const copy = b.vault.paths().find((p) => p.startsWith("differs (冲突 Windows"))!;
        assert.equal(b.vault.text(copy), "Windows version");
        assert.equal(b.vault.text("only-mac.md"), "m");
        await a.engine.sync();
        assert.equal(a.vault.text("only-win.md"), "w");
        assert.equal(a.vault.text(copy), "Windows version");
    });

    it("holds back a mass deletion until confirmed", async () => {
        const a = device("Mac");
        const b = device("iPhone");
        for (let i = 0; i < 25; i++) a.vault.set(`n${i}.md`, `note ${i}`);
        await a.engine.sync();
        await b.engine.sync();
        for (let i = 0; i < 25; i++) {
            await a.vault.trash(`n${i}.md`);
            await a.engine.noteDeleted(`n${i}.md`);
        }
        await a.engine.sync();

        await b.engine.sync();
        assert.equal(b.engine.status.phase, "needs-confirm");
        assert.equal(b.engine.status.guardCount, 25);
        assert.equal(b.vault.paths().length, 25, "nothing deleted yet");

        b.engine.confirmMassChange();
        await b.engine.sync();
        assert.equal(b.vault.paths().length, 0);
        assert.equal(b.engine.status.phase, "idle");
    });

    it("refuses content from a different vault key", async () => {
        const a = device("Mac");
        a.vault.set("a.md", "x");
        await a.engine.sync();
        keys = await deriveVaultKeys(newMasterKey());
        const stranger = device("Stranger");
        await stranger.engine.sync();
        assert.deepEqual(stranger.vault.paths(), []);
        assert.ok(stranger.logs.some((l) => l.includes("无法解密")));
    });

    it("resumes after the server was unreachable", async () => {
        const a = device("Mac");
        const real = http;
        let down = true;
        http = async (req) => {
            if (down) throw new Error("ECONNREFUSED");
            return real(req);
        };
        const offline = device("Laptop");
        offline.vault.set("draft.md", "written offline");
        await offline.engine.sync();
        assert.equal(offline.engine.status.phase, "offline");
        down = false;
        await offline.engine.sync();
        assert.equal(offline.engine.status.phase, "idle");
        await a.engine.sync();
        assert.equal(a.vault.text("draft.md"), "written offline");
    });

    it("downloads the reported Windows filename and edits, restarts and deletes the same canonical file", async () => {
        const a = device("Mac");
        const remote = "示例 文档 14-> 15.md";
        const local = "示例 文档 14-＞ 15.md";
        a.vault.set(remote, "original");
        a.vault.set("valid.md", "valid");
        await a.engine.sync();
        const b = device("Windows", { windows: true });
        const stat = b.vault.stat.bind(b.vault);
        const write = b.vault.write.bind(b.vault);
        b.vault.stat = async (path) => {
            assert.equal(windowsPathProblem(path), null, "invalid paths never reach the filesystem");
            return stat(path);
        };
        b.vault.write = async (path, ...args) => {
            assert.equal(windowsPathProblem(path), null);
            assert.equal(b.store.state!.localPaths[remote], local, "persist aliases before writing");
            return write(path, ...args);
        };
        await b.engine.sync();
        assert.equal(b.vault.text("valid.md"), "valid");
        assert.equal(b.vault.text(local), "original");
        assert.equal(b.engine.status.phase, "idle");
        assert.equal(b.engine.status.pending, 0);
        assert.equal(b.engine.status.skipped, 0);
        assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n, 2, "local aliases are not uploaded as duplicate notes");
        b.engine = b.restart();
        b.vault.set(local, "edited on Windows");
        await b.engine.sync();
        await a.engine.sync();
        assert.equal(a.vault.text(remote), "edited on Windows");
        assert.equal(a.vault.text(local), undefined);
        a.vault.set(remote, "edited on Mac");
        await a.engine.sync();
        await b.engine.sync();
        assert.equal(b.vault.text(local), "edited on Mac");
        await b.vault.trash(local);
        await b.engine.noteDeleted(local);
        await b.engine.sync();
        await a.engine.sync();
        assert.equal(a.vault.text(remote), undefined);
        assert.equal(b.vault.text(local), undefined);
        assert.equal(b.engine.status.pending, 0);
    });

    it("keeps literal full-width names, existing local notes and case collisions distinct on Windows", async () => {
        const a = device("Mac");
        a.vault.set("arrow>.md", "ASCII arrow");
        a.vault.set("arrow＞.md", "full-width arrow");
        a.vault.set("Note.md", "upper");
        a.vault.set("note.md", "lower");
        a.vault.set("existing?.md", "remote question");
        await a.engine.sync();
        const b = device("Windows", { windows: true });
        b.vault.set("existing？.md", "pre-existing local");
        await b.engine.sync();
        assert.equal(b.engine.status.phase, "idle");
        assert.equal(b.engine.status.pending, 0);
        const paths = b.vault.paths();
        assert.equal(paths.length, 6);
        assert.equal(new Set(paths.map((p) => p.toLowerCase())).size, 6);
        assert.equal(b.vault.text("existing？.md"), "pre-existing local");
        const contents = paths.map((p) => b.vault.text(p));
        for (const text of ["ASCII arrow", "full-width arrow", "upper", "lower", "remote question", "pre-existing local"])
            assert.ok(contents.includes(text), text);
        for (const path of paths) assert.equal(windowsPathProblem(path), null, path);
        await a.engine.sync();
        assert.equal(a.vault.text("arrow>.md"), "ASCII arrow");
        assert.equal(a.vault.text("arrow＞.md"), "full-width arrow");
        assert.equal(a.vault.text("existing?.md"), "remote question");
        assert.equal(a.vault.text("existing？.md"), "pre-existing local");
    });

    it("preserves folder aliases for new files and a Windows folder rename", async () => {
        const a = device("Mac");
        a.vault.set("folder>/one?.md", "one");
        a.vault.set("folder＞/other.md", "literal folder");
        await a.engine.sync();
        const b = device("Windows", { windows: true });
        await b.engine.sync();
        const localFolder = b.store.state!.localPaths["folder>"]!;
        const localFile = b.store.state!.localPaths["folder>/one?.md"]!;
        assert.equal(b.vault.text(localFile), "one");
        b.vault.set(localFolder + "/new.md", "created on Windows");
        await b.engine.sync();
        await a.engine.sync();
        assert.equal(a.vault.text("folder>/new.md"), "created on Windows");
        assert.equal(a.vault.text("folder＞/new.md"), undefined);
        b.engine = b.restart();
        for (const [path, data] of [...b.vault.files]) {
            if (!path.startsWith(localFolder + "/")) continue;
            b.vault.files.delete(path);
            b.vault.files.set("renamed" + path.slice(localFolder.length), data);
        }
        await b.engine.noteRenamed(localFolder, "renamed");
        await b.engine.sync();
        await a.engine.sync();
        assert.equal(a.vault.text("folder>/one?.md"), undefined);
        assert.equal(a.vault.text("renamed/one?.md"), "one");
        assert.equal(a.vault.text("renamed/new.md"), "created on Windows");
        assert.equal(a.vault.text("folder＞/other.md"), "literal folder");
        assert.equal(b.engine.status.pending, 0);
        assert.equal(b.vault.paths().filter((p) => p.startsWith("renamed/")).length, 2);
    });

    it("uses physical aliases for busy-note checks and propagates a Windows file rename", async () => {
        const remote = "file>.md";
        const a = device("Mac");
        a.vault.set(remote, "original");
        await a.engine.sync();
        let busy = false;
        const b = device("Windows", { windows: true, isBusy: (path) => busy && path === "file＞.md" });
        await b.engine.sync();
        busy = true;
        a.vault.set(remote, "remote changed");
        await a.engine.sync();
        await b.engine.sync();
        assert.equal(b.vault.text("file＞.md"), "original");
        assert.equal(b.engine.status.pending, 1);
        busy = false;
        await b.engine.sync();
        assert.equal(b.vault.text("file＞.md"), "remote changed");
        const file = b.vault.files.get("file＞.md")!;
        b.vault.files.delete("file＞.md");
        b.vault.files.set("renamed.md", file);
        await b.engine.noteRenamed("file＞.md", "renamed.md");
        await b.engine.sync();
        await a.engine.sync();
        assert.equal(a.vault.text(remote), undefined);
        assert.equal(a.vault.text("renamed.md"), "remote changed");
        assert.deepEqual(b.vault.paths(), ["renamed.md"]);
    });

    it("does not write aliased notes until their mapping has been saved successfully", async () => {
        const a = device("Mac");
        a.vault.set("file>.md", "content");
        await a.engine.sync();
        const store = new MemoryStore();
        let fail = true;
        const b = device("Windows", { windows: true, store: {
            load: () => store.load(),
            save: async (state) => {
                if (fail && Object.keys(state.localPaths).length > 0) throw new Error("alias save failed");
                await store.save(state);
            },
        } });
        await b.engine.sync();
        assert.equal(b.engine.status.phase, "error");
        assert.deepEqual(b.vault.paths(), []);
        fail = false;
        await b.engine.sync();
        assert.equal(b.vault.text("file＞.md"), "content");
        assert.equal(b.engine.status.phase, "idle");
        assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n, 1);
    });

    it("retries a file retained by 0.2.1 without resetting the cursor or pairing", async () => {
        const remote = "示例 文档 14-> 15.md";
        const a = device("Mac");
        a.vault.set(remote, "retained pending file");
        await a.engine.sync();
        const entry = a.store.state!.index[remote]!;
        const store = new MemoryStore();
        // Snapshot of the preceding release: pending remote change, no local-path dictionary.
        store.state = { version: 1, cursor: db.head(), index: {}, config: null, pendingDeletes: {},
            dirty: { [entry.id]: { path: remote, rev: entry.rev, deleted: false } } } as SyncState;
        const b = device("Windows", { windows: true, store });
        await b.engine.sync();
        assert.equal(b.vault.text("示例 文档 14-＞ 15.md"), "retained pending file");
        assert.equal(b.engine.cursor, db.head());
        assert.equal(b.engine.status.pending, 0);
        assert.equal(b.engine.status.phase, "idle");
        assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n, 1);
    });

    it("applies a source rename and deletion without leaving Windows alias copies behind", async () => {
        const a = device("Mac");
        a.vault.set("old>.md", "keep me");
        await a.engine.sync();
        const b = device("Windows", { windows: true });
        await b.engine.sync();
        assert.deepEqual(b.vault.paths(), ["old＞.md"]);
        const data = a.vault.files.get("old>.md")!;
        a.vault.files.delete("old>.md");
        a.vault.files.set("new?.md", data);
        await a.engine.noteRenamed("old>.md", "new?.md");
        await a.engine.sync();
        b.engine = b.restart();
        await b.engine.sync();
        assert.deepEqual(b.vault.paths(), ["new？.md"]);
        assert.equal(b.vault.text("new？.md"), "keep me");
        await a.vault.trash("new?.md");
        await a.engine.noteDeleted("new?.md");
        await a.engine.sync();
        await b.engine.sync();
        assert.deepEqual(b.vault.paths(), []);
        assert.equal(b.engine.status.pending, 0);
    });

    it("prefetches at most three files while applying files and saving in order", { timeout: 5000 }, async () => {
        const a = device("Mac");
        for (let n = 0; n < 9; n++) a.vault.set(`${n}.md`, `file ${n}`);
        await a.engine.sync();
        const real = http;
        let active = 0, peak = 0, started = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        http = async (req) => {
            if (!req.url.includes("/v1/files/") || req.method !== "GET") return real(req);
            active++; started++; peak = Math.max(peak, active);
            if (started === 3) release();
            try { await gate; return await real(req); }
            finally { active--; }
        };
        const b = device("Linux");
        let writing = false;
        const write = b.vault.write.bind(b.vault);
        b.vault.write = async (...args) => {
            assert.equal(writing, false);
            writing = true;
            try {
                if (b.engine.status.downloaded === 0) {
                    const report = db.get<{ ack_seq: number; pending: number }>("SELECT ack_seq, pending FROM devices WHERE id = 'Linux'")!;
                    assert.equal(report.ack_seq, db.head(), "the cursor is reported before the initial download finishes");
                    assert.equal(report.pending, 9);
                }
                tick();
                return await write(...args);
            }
            finally { writing = false; }
        };
        await b.engine.sync();
        assert.equal(peak, 3);
        assert.equal(started, 9);
        assert.equal(b.engine.status.downloaded, 9);
        assert.equal(db.get<{ pending: number }>("SELECT pending FROM devices WHERE id = 'Linux'")!.pending, 0);
        assert.equal(Object.keys(b.store.state!.dirty).length, 0);
        for (const stage of ["网络下载", "解密校验", "本地写入", "索引保存"])
            assert.ok(b.logs.some((line) => line.includes(`耗时 · ${stage}`)));
    });

    it("times out a stalled download, retains its dirty entry and retries successfully", async () => {
        const a = device("Mac");
        a.vault.set("a.md", "recover me");
        await a.engine.sync();
        const real = http;
        let stalled = true;
        http = (req) => stalled && req.url.includes("/v1/files/") ? new Promise(() => {}) : real(req);
        const b = device("Linux", {}, 15);
        await b.engine.sync();
        assert.equal(b.engine.status.phase, "offline");
        assert.equal(b.engine.status.progress, null);
        assert.match(b.engine.status.message!, /请求超时/);
        assert.equal(Object.keys(b.store.state!.dirty).length, 1);
        stalled = false;
        await b.engine.sync();
        assert.equal(b.vault.text("a.md"), "recover me");
        assert.equal(b.engine.status.phase, "idle");
    });

    it("counts busy remote paths once and finishes the local scan counter", async () => {
        const a = device("Mac");
        a.vault.set("busy.md", "remote");
        await a.engine.sync();
        let busy = true;
        const b = device("Linux", { isBusy: () => busy });
        b.vault.set("busy.md", "local");
        await b.engine.sync();
        assert.equal(b.engine.status.pending, 1);
        assert.equal(b.engine.status.lastSyncAt, null);
        assert.ok(b.statuses.some((s) => s.progress?.action === "正在检查" && s.progress.completed === s.progress.total && s.progress.total === 1));
        busy = false;
        await b.engine.sync();
        assert.equal(b.engine.status.pending, 0);
    });

    it("reports index failures without overwriting a state which failed to load", async () => {
        let saves = 0;
        const b = device("Broken", { store: {
            load: async () => { throw new Error("IndexedDB unavailable"); },
            save: async () => { saves++; },
        } });
        await b.engine.sync();
        assert.equal(b.engine.status.phase, "error");
        assert.match(b.engine.status.message!, /IndexedDB unavailable/);
        assert.equal(saves, 0);
    });
});
