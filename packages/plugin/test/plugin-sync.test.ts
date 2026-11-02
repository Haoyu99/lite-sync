import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { type PluginBundle, type VaultKeys, deriveVaultKeys, newMasterKey, normaliseConfig, parsePluginBundle } from "@lite-sync/core";
import { createApp } from "../../server/src/app.ts";
import { Db } from "../../server/src/db.ts";
import { ServerKey, newToken, sha256Hex } from "../../server/src/auth.ts";
import { Api, type Http } from "../src/api.ts";
import { PluginSync, type PluginSyncState, type PluginHost } from "../src/plugin-sync.ts";
import { PluginFiles, type PluginDisk } from "../src/plugin-files.ts";

function bundle(id = "calendar", data: object = { a: 1, b: 1 }, version = "1.0", desktop = false): PluginBundle {
    return { id, files: { "manifest.json": JSON.stringify({ id, name: id, version, isDesktopOnly: desktop }), "main.js": `code-${version}`, "data.json": JSON.stringify(data) } };
}
class Host implements PluginHost {
    installed = new Map<string, PluginBundle>();
    backups: PluginBundle[] = [];
    enabled = new Set<string>();
    async list(exclude: readonly string[] = []) { return [...this.installed.values()].filter((b) => !exclude.includes(b.id)).map((b) => structuredClone(b)); }
    async apply(value: PluginBundle) { const old = this.installed.get(value.id); if (old) await this.backup(old); this.installed.set(value.id, structuredClone(value)); }
    async backup(value: PluginBundle) { this.backups.push(structuredClone(value)); }
}
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "lite-plugin-sync-"));
    const db = new Db(dir);
    const { app } = createApp({ db, serverKey: new ServerKey("x".repeat(40)) });
    const keys = await deriveVaultKeys(newMasterKey());
    const http: Http = async (req) => {
        const r = await app.request(req.url, { method: req.method, headers: req.headers, body: req.body });
        const headers: Record<string, string> = {};
        r.headers.forEach((value, name) => { headers[name] = value; });
        return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
    };
    const device = (name: string, mobile = false, customKeys: VaultKeys = keys) => {
        const token = newToken();
        db.run("INSERT INTO devices(id,name,platform,client_version,token_hash,created_at) VALUES(?,?,'macos','0.2.0',?,0)", name, name, sha256Hex(token));
        const host = new Host();
        let state: PluginSyncState | null = null;
        const api = new Api(http, "http://test", token);
        const logs: string[] = [];
        const makeSync = () => new PluginSync({ api, keys: customKeys, deviceId: name, mobile, host,
            load: async () => structuredClone(state), save: async (s) => { state = structuredClone(s); },
            progress: (m) => logs.push(m), log: (m) => logs.push(m) });
        return { host, api, sync: makeSync(), restart: makeSync, logs };
    };
    return { db, device, close: () => { db.sql.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const config = normaliseConfig({});

it("seeds from the first device, installs/configures other devices, and never synchronises enablement or uninstalls", async () => {
    const f = await fixture();
    try {
        const a = f.device("Mac"), b = f.device("Phone");
        a.host.installed.set("calendar", bundle()); a.host.enabled.add("calendar");
        b.host.installed.set("calendar", bundle("calendar", { a: 9 }));
        assert.equal((await a.sync.sync(config)).uploaded, 1);
        assert.equal((await b.sync.sync(config)).applied, 1);
        assert.deepEqual(b.host.installed.get("calendar"), bundle());
        assert.equal(b.host.backups.length, 1, "first join preserves the differing local version");
        assert.equal(b.host.enabled.size, 0, "receiving a plugin does not enable it");
        b.host.installed.delete("calendar");
        await b.sync.sync(config);
        a.host.installed.set("calendar", bundle("calendar", { a: 2 }, "2.0"));
        await a.sync.sync(config);
        await b.restart().sync(config);
        assert.equal(b.host.installed.has("calendar"), false, "remote updates do not reinstall a locally removed plugin");
        assert.equal((await a.api.pluginCatalog()).packages[0]!.rev, 2);
        const c = f.device("New");
        await c.sync.sync(config);
        assert.equal(JSON.parse(c.host.installed.get("calendar")!.files["data.json"]!).a, 2);
        assert.equal(f.db.head(), 0, "no plugin code enters the note stream");
    } finally { f.close(); }
});

it("merges independently edited configuration fields and backs up same-field conflicts", async () => {
    const f = await fixture();
    try {
        const a = f.device("A"), b = f.device("B");
        a.host.installed.set("calendar", bundle());
        await a.sync.sync(config); await b.sync.sync(config);
        a.host.installed.set("calendar", bundle("calendar", { a: 2, b: 1 }));
        b.host.installed.set("calendar", bundle("calendar", { a: 1, b: 3 }));
        await a.sync.sync(config);
        await b.sync.sync(config);
        assert.deepEqual(JSON.parse(b.host.installed.get("calendar")!.files["data.json"]!), { a: 2, b: 3 });
        await a.sync.sync(config);
        a.host.installed.set("calendar", bundle("calendar", { a: 7, b: 3 }));
        b.host.installed.set("calendar", bundle("calendar", { a: 8, b: 3 }));
        await a.sync.sync(config);
        const result = await b.sync.sync(config);
        assert.equal(result.conflicts, 1);
        assert.equal(JSON.parse(b.host.installed.get("calendar")!.files["data.json"]!).a, 7);
        assert.ok(b.host.backups.some((p) => JSON.parse(p.files["data.json"]!).a === 8));
    } finally { f.close(); }
});

it("keeps desktop-only plugins off mobile and leaves excluded and opted-out settings local", async () => {
    const f = await fixture();
    try {
        const a = f.device("A"), b = f.device("B", true);
        a.host.installed.set("desktop", bundle("desktop", {}, "1", true));
        a.host.installed.set("calendar", bundle());
        await a.sync.sync(config);
        b.host.installed.set("calendar", bundle("calendar", { device: "phone" }));
        const noData = normaliseConfig({ obsidian: { pluginData: false } });
        await b.sync.sync(noData);
        assert.equal(b.host.installed.has("desktop"), false);
        assert.deepEqual(JSON.parse(b.host.installed.get("calendar")!.files["data.json"]!), { device: "phone" });
        b.host.installed.set("calendar", bundle("calendar", { device: "phone" }, "2.0"));
        await b.sync.sync(noData);
        await a.sync.sync(config);
        assert.deepEqual(JSON.parse(a.host.installed.get("calendar")!.files["data.json"]!), { a: 1, b: 1 }, "opt-out does not erase the shared config");
        const c = f.device("C");
        await c.sync.sync(normaliseConfig({ obsidian: { excludePlugins: ["calendar"] } }));
        assert.equal(c.host.installed.has("calendar"), false);
        const d = f.device("D", false, await deriveVaultKeys(newMasterKey()));
        await assert.rejects(d.sync.sync(config));
        assert.equal(d.host.installed.size, 0, "wrong-key packages are never applied");
    } finally { f.close(); }
});

class Disk implements PluginDisk {
    files = new Map<string, string>();
    dirs = new Set<string>([".obsidian", ".obsidian/plugins"]);
    fail = "";
    async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
    async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error("missing " + path); return value; }
    async write(path: string, text: string) { if (path === this.fail) { this.fail = ""; throw new Error("disk failed"); } this.files.set(path, text); }
    async mkdir(path: string) { this.dirs.add(path); }
    async remove(path: string) { this.files.delete(path); }
    async list(path: string) {
        const direct = (p: string) => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/");
        return { files: [...this.files.keys()].filter(direct), folders: [...this.dirs].filter(direct) };
    }
    put(b: PluginBundle) { this.dirs.add(`.obsidian/plugins/${b.id}`); for (const [name, value] of Object.entries(b.files)) this.files.set(`.obsidian/plugins/${b.id}/${name}`, value); }
}
it("applies complete plugin packages with lifecycle handling, backups, rollback and crash recovery", async () => {
    const disk = new Disk(); disk.put(bundle());
    disk.files.set(".obsidian/community-plugins.json", '["calendar"]');
    disk.files.set(".obsidian/hotkeys.json", '{"local":true}');
    disk.files.set(".obsidian/plugins/calendar/cache.bin", "keep-local-cache");
    const calls: string[] = [];
    const host = new PluginFiles(disk, ".obsidian", { loaded: () => true, pause: async () => { calls.push("pause"); }, resume: async () => { calls.push("resume"); } });
    disk.fail = ".obsidian/plugins/calendar/main.js";
    await assert.rejects(host.apply(bundle("calendar", { a: 2 }, "2"), bundle()));
    assert.deepEqual((await host.list())[0], bundle());
    assert.deepEqual(calls, ["pause", "resume"]);
    await host.apply(bundle("calendar", { a: 2 }, "2"), bundle());
    assert.equal((await host.list())[0]!.files["main.js"], "code-2");
    assert.equal(disk.files.get(".obsidian/community-plugins.json"), '["calendar"]');
    assert.equal(disk.files.get(".obsidian/hotkeys.json"), '{"local":true}');
    assert.equal(disk.files.get(".obsidian/plugins/calendar/cache.bin"), "keep-local-cache");
    const journal = { id: "calendar", before: { ...bundle().files, "styles.css": null } };
    disk.files.set(".obsidian/lite-sync-staging/calendar.json", JSON.stringify(journal));
    await host.recover();
    assert.deepEqual((await host.list())[0], bundle());
    assert.throws(() => parsePluginBundle({ ...bundle(), id: "../escape" }));
    assert.throws(() => parsePluginBundle({ ...bundle(), id: "lite-sync" }));
    assert.throws(() => parsePluginBundle({ ...bundle(), files: { ...bundle().files, "../data.json": "oops" } }));
    assert.throws(() => parsePluginBundle(bundle("obsidian-livesync")));
});
