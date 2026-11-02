import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createApp, issueSetupToken, reset2fa } from "../src/app.ts";
import { Db } from "../src/db.ts";
import { ServerKey, currentStep, totpAt, newToken, sha256Hex } from "../src/auth.ts";

const KEY = Buffer.alloc(32, 8).toString("base64");
const BLOB = Buffer.alloc(64, 9).toString("base64");
const WEEK = 7 * 86400000;
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "lite-sync-features-"));
    const db = new Db(dir);
    let time = Date.now();
    const { app } = createApp({ db, serverKey: new ServerKey("x".repeat(40)), now: () => time, insecureCookies: true });
    function browser() {
        const jar = new Map<string, string>();
        const request = async (path: string, body?: object, method = body ? "POST" : "GET") => {
            const r = await app.request("/admin/api" + path, { method, body: body ? JSON.stringify(body) : undefined,
                headers: { "x-lite-sync": "1", "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
            for (const cookie of r.headers.getSetCookie()) {
                const pair = cookie.split(";")[0]!; const i = pair.indexOf("=");
                if (/Max-Age=0/.test(cookie)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
            }
            return r;
        };
        return { request, jar };
    }
    const device = (name: string) => {
        const token = newToken();
        db.run("INSERT INTO devices(id,name,platform,client_version,token_hash,created_at) VALUES (?,?,'macos','0.2.0',?,?)", name, name, sha256Hex(token), time);
        return (path: string, init: RequestInit = {}) => app.request("/v1" + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
    };
    return { db, app, browser, device, advance: (ms: number) => { time += ms; }, now: () => time,
        close: () => { db.sql.close(); rmSync(dir, { recursive: true, force: true }); } };
}
it("keeps sessions for seven days, trusts only verified browsers, and revokes trust", async () => {
    const f = fixture();
    try {
        const a = f.browser(), b = f.browser();
        assert.equal((await a.request("/setup", { setupToken: issueSetupToken(f.db), salt: BLOB.slice(0, 24), kdf: { alg: "PBKDF2-SHA256", iterations: 600000 }, loginKey: KEY, wrappedMk: BLOB, mkProof: KEY })).status, 200);
        const secret = (await (await a.request("/totp/begin", {})).json()).secret;
        assert.equal((await a.request("/totp/confirm", { totp: totpAt(secret, currentStep(f.now())) })).status, 200);
        assert.equal((await (await a.request("/prelogin")).json()).trusted, true);
        assert.equal((await b.request("/login", { loginKey: KEY })).status, 403, "a fresh browser still needs TOTP");
        const initial = await (await a.request("/session")).json();
        assert.equal(initial.expiresAt - f.now(), WEEK);
        f.advance(2 * 86400000);
        assert.equal((await a.request("/session")).status, 200, "reading without API requests does not expire after 30 minutes");
        f.advance(5 * 86400000 + 1);
        assert.equal((await a.request("/session")).status, 401, "expiry is fixed, not extended by activity");
        assert.equal((await a.request("/login", { loginKey: BLOB })).status, 403, "trust never replaces the passphrase");
        assert.equal((await a.request("/login", { loginKey: KEY })).status, 200, "trusted browser does not need another TOTP");
        assert.notEqual((await (await a.request("/session")).json()).sessionTag, initial.sessionTag);
        assert.equal((await a.request("/forget-browser", {})).status, 200);
        assert.equal((await a.request("/session")).status, 401);
        assert.equal((await a.request("/login", { loginKey: KEY })).status, 403);
        f.advance(30000);
        assert.equal((await a.request("/login", { loginKey: KEY, totp: totpAt(secret, currentStep(f.now())) })).status, 200);
        const newKey = Buffer.alloc(32, 5).toString("base64");
        f.advance(30000);
        assert.equal((await a.request("/passphrase", { currentLoginKey: KEY, loginKey: newKey, salt: BLOB.slice(0, 24), kdf: { alg: "PBKDF2-SHA256", iterations: 600000 }, wrappedMk: BLOB, totp: totpAt(secret, currentStep(f.now())) })).status, 200);
        assert.equal((await a.request("/session")).status, 401);
        assert.equal(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trusted_browsers")!.n, 0);
        assert.equal((await a.request("/login", { loginKey: newKey })).status, 403);
        reset2fa(f.db);
        assert.equal((await a.request("/login", { loginKey: newKey })).status, 200);
    } finally { f.close(); }
});

it("isolates encrypted plugin packages from note history and serialises bootstrap and writes", async () => {
    const f = fixture();
    try {
        const a = f.device("Mac"), b = f.device("Phone");
        const id = "a".repeat(64), data = Buffer.alloc(64, 1);
        const put = (request: typeof a, base: number) => request(`/plugin-packages/${id}`, { method: "PUT", headers: { "x-base-rev": String(base) }, body: data });
        assert.equal((await put(a, 0)).status, 409, "claim the seed first");
        assert.equal((await (await a("/plugin-sync/claim", { method: "POST" })).json()).seedDevice, "Mac");
        assert.equal((await (await b("/plugin-sync/claim", { method: "POST" })).json()).seedDevice, "Mac");
        assert.equal((await put(b, 0)).status, 409);
        assert.equal((await b("/plugin-sync/complete", { method: "POST" })).status, 403);
        assert.equal((await put(a, 0)).status, 200);
        assert.equal((await (await a("/plugin-sync/claim", { method: "POST" })).json()).ready, false, "an interrupted seed can resume");
        assert.equal((await a("/plugin-sync/complete", { method: "POST" })).status, 200);
        assert.equal((await put(b, 0)).status, 409);
        assert.equal((await put(b, 1)).status, 200);
        const response = await b(`/plugin-packages/${id}`);
        assert.equal(response.headers.get("x-rev"), "2");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
        assert.equal(f.db.head(), 0);
        assert.deepEqual((await (await a("/changes?since=0")).json()).changes, []);
        assert.equal(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plugin_versions")!.n, 2);
        f.db.run("UPDATE devices SET revoked_at = ? WHERE id = 'Phone'", f.now());
        assert.equal((await put(b, 2)).status, 401);
    } finally { f.close(); }
});

it("creates the complete schema in a fresh directory and preserves it on restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "lite-sync-fresh-"));
    let db = new Db(dir);
    try {
        const tables = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name));
        for (const name of ["vault", "admin", "devices", "files", "versions", "plugin_sync", "plugin_versions", "trusted_browsers"])
            assert.ok(tables.has(name), name);
        assert.equal(db.head(), 0);
        assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault")!.n, 0);
        db.run("INSERT INTO vault(id,salt,kdf,login_hash,wrapped_mk,mk_proof_hash,updated_at) VALUES(1,'salt','{}','hash','wrapped','proof',0)");
        db.put({ id: "f".repeat(64), baseRev: 0, deviceId: null }, BLOB, Buffer.alloc(64));
        db.sql.close();
        db = new Db(dir);
        assert.equal(db.head(), 1);
        assert.equal(db.get<{ mk_proof_hash: string }>("SELECT mk_proof_hash FROM vault")!.mk_proof_hash, "proof");
    } finally { db.sql.close(); rmSync(dir, { recursive: true, force: true }); }
});
