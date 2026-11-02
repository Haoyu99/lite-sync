// Two simulated devices synchronising through the real server.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { type Bytes, type VaultKeys, deriveVaultKeys, fromUtf8, newMasterKey, utf8 } from "@lite-sync/core";
import { ServerKey, newToken, sha256Hex } from "../../server/src/auth.ts";
import { createApp } from "../../server/src/app.ts";
import { Db } from "../../server/src/db.ts";
import { Api, type Http } from "../src/api.ts";
import { type LocalFile, type StateStore, type SyncState, type SyncStatus, SyncEngine, type VaultAdapter } from "../src/engine.ts";

let clock = Date.UTC(2026, 9, 30, 12, 0, 0);
const tick = () => (clock += 1000);

class MemoryVault implements VaultAdapter {
    files = new Map<string, { data: Bytes; mtime: number }>();
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

    const device = (name: string) => {
        const token = newToken();
        db.run(
            "INSERT INTO devices (id, name, platform, client_version, token_hash, created_at) VALUES (?, ?, 'macos', '0.1.0', ?, ?)",
            name, name, sha256Hex(token), clock
        );
        const vault = new MemoryVault();
        const logs: string[] = [];
        const statuses: SyncStatus[] = [];
        const engine = new SyncEngine({
            api: new Api(http, "http://test", token),
            keys,
            vault,
            store: new MemoryStore(),
            deviceName: name,
            clientVersion: "0.1.0",
            mobile: false,
            log: (m) => logs.push(m),
            onStatus: (status) => statuses.push(structuredClone(status)),
            now: () => clock,
        });
        return { engine, vault, logs, statuses };
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
});
