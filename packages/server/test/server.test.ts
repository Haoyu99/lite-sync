import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ServerKey, currentStep, totpAt } from "../src/auth.ts";
import { createApp, issueSetupToken, reset2fa } from "../src/app.ts";
import { Db } from "../src/db.ts";

const KDF = { alg: "PBKDF2-SHA256", iterations: 600_000 };
const LOGIN_KEY = Buffer.alloc(32, 7).toString("base64");
const WRAPPED = Buffer.alloc(60, 9).toString("base64");
const MK_PROOF = Buffer.alloc(32, 5).toString("base64");
const META = Buffer.from("sealed-meta").toString("base64");
const id = (n: number) => n.toString(16).padStart(64, "0");
const blob = (s: string) => Buffer.concat([Buffer.alloc(29, 1), Buffer.from(s)]);

describe("server", () => {
    let dir: string;
    let db: Db;
    let clock = Date.UTC(2026, 9, 30, 12, 0, 0);
    let app: ReturnType<typeof createApp>["app"];
    let cookie = "";
    let totpSecret = "";
    let recoveryCodes: string[] = [];
    let token = "";
    let deviceId = "";

    const admin = async (path: string, init: RequestInit = {}) => {
        const res = await app.request("/admin/api" + path, {
            ...init,
            headers: { "x-lite-sync": "1", "content-type": "application/json", cookie, ...(init.headers ?? {}) },
        });
        const set = res.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0]!;
        return res;
    };
    const dev = (path: string, init: RequestInit = {}, t = token) =>
        app.request("/v1" + path, { ...init, headers: { authorization: `Bearer ${t}`, ...(init.headers ?? {}) } });
    const put = (n: number, baseRev: number, body = "x", t = token) =>
        dev(`/files/${id(n)}`, { method: "PUT", body: blob(body), headers: { "x-base-rev": String(baseRev), "x-meta": META } }, t);
    // Each TOTP step can be used once, so tests advance the clock to obtain a fresh code.
    const nextCode = () => {
        clock += 30_000;
        return totpAt(totpSecret, currentStep(clock));
    };

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "lite-sync-test-"));
        db = new Db(dir);
        ({ app } = createApp({ db, serverKey: new ServerKey("x".repeat(40)), insecureCookies: true, now: () => clock }));
    });
    after(() => {
        db.sql.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it("refuses setup without the one-time token", async () => {
        const pre = await (await admin("/prelogin")).json();
        assert.deepEqual(pre, { initialised: false });
        const r = await admin("/setup", { method: "POST", body: JSON.stringify({ setupToken: "nope", salt: "AAAA", kdf: KDF, loginKey: LOGIN_KEY, wrappedMk: WRAPPED }) });
        assert.equal(r.status, 403);
    });

    it("rejects admin requests without the custom header", async () => {
        const r = await app.request("/admin/api/prelogin");
        assert.equal(r.status, 400);
    });

    it("sets security headers on every response", async () => {
        const r = await app.request("/healthz");
        assert.equal(r.headers.get("x-frame-options"), "DENY");
        assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
        assert.equal(r.headers.get("strict-transport-security"), null, "no HSTS over plain HTTP");
    });

    it("initialises once and enrols TOTP", async () => {
        const setupToken = issueSetupToken(db)!;
        const body = JSON.stringify({ setupToken, salt: "c2FsdHNhbHQ=", kdf: KDF, loginKey: LOGIN_KEY, wrappedMk: WRAPPED, mkProof: MK_PROOF });
        assert.equal((await admin("/setup", { method: "POST", body })).status, 200);
        assert.equal((await admin("/setup", { method: "POST", body })).status, 403, "token is single-use");
        assert.equal(issueSetupToken(db), null);
        assert.equal((await (await admin("/prelogin")).json()).totp, false, "two-factor is optional and off by default");

        const begin = await (await admin("/totp/begin", { method: "POST" })).json();
        totpSecret = begin.secret;
        assert.match(begin.otpauthUrl, /^otpauth:\/\/totp\//);
        assert.equal((await admin("/totp/confirm", { method: "POST", body: JSON.stringify({ totp: "000000" }) })).status, 403);
        const ok = await admin("/totp/confirm", { method: "POST", body: JSON.stringify({ totp: nextCode() }) });
        recoveryCodes = (await ok.json()).recoveryCodes;
        assert.equal(recoveryCodes.length, 10);
        assert.equal((await (await admin("/prelogin")).json()).totp, true);
    });

    it("logs in with the login key and TOTP, and refuses a replayed code", async () => {
        cookie = "";
        assert.equal((await admin("/overview")).status, 401);
        const code = nextCode();
        const r = await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY, totp: code }) });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).wrappedMk, WRAPPED);
        const replay = await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY, totp: code }) });
        assert.equal(replay.status, 403);
        assert.equal((await admin("/overview")).status, 200);
    });

    it("accepts a recovery code once", async () => {
        const body = JSON.stringify({ loginKey: LOGIN_KEY, recoveryCode: recoveryCodes[0] });
        const r = await admin("/login", { method: "POST", body });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).recoveryCodesLeft, 9);
        assert.equal((await admin("/login", { method: "POST", body })).status, 403);
    });

    it("locks login after repeated failures", async () => {
        for (let i = 0; i < 5; i++)
            await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: Buffer.alloc(32).toString("base64"), totp: "123456" }) });
        const r = await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY, totp: nextCode() }) });
        assert.equal(r.status, 429);
        clock += 16 * 60_000;
        assert.equal((await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY, totp: nextCode() }) })).status, 200);
    });

    it("pairs a device with a single-use code", async () => {
        const { code } = await (await admin("/pairing-codes", { method: "POST" })).json();
        const pair = (c: string) =>
            app.request("/v1/pair", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: c, name: "Mac", platform: "macos", clientVersion: "0.1.0" }),
            });
        const r = await pair(code.toLowerCase().replace("-", " "));
        assert.equal(r.status, 200);
        ({ token, deviceId } = await r.json());
        assert.equal((await pair(code)).status, 403, "code is single-use");
        const vault = await (await dev("/vault")).json();
        assert.equal(vault.wrappedMk, WRAPPED);
        assert.equal((await dev("/vault", {}, "bogus")).status, 401);
    });

    it("rejects pairing codes after they expire", async () => {
        const { code } = await (await admin("/pairing-codes", { method: "POST" })).json();
        clock += 11 * 60_000;
        const r = await app.request("/v1/pair", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, name: "Late", platform: "linux", clientVersion: "0.1.0" }),
        });
        assert.equal(r.status, 403);
    });

    it("accepts writes only against the current revision", async () => {
        assert.equal((await put(1, 0, "v1")).status, 200);
        const stale = await put(1, 0, "stale");
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), { error: "conflict", rev: 1, deleted: false });
        const r2 = await put(1, 1, "v2");
        assert.deepEqual(await r2.json(), { rev: 2, seq: 2 });

        const latest = await dev(`/files/${id(1)}`);
        assert.equal(latest.headers.get("x-rev"), "2");
        assert.equal(Buffer.from(await latest.arrayBuffer()).subarray(29).toString(), "v2");
        const old = await dev(`/files/${id(1)}/versions/1`);
        assert.equal(Buffer.from(await old.arrayBuffer()).subarray(29).toString(), "v1", "history is kept");
    });

    it("records deletions as versions and allows recreation", async () => {
        assert.equal((await dev(`/files/${id(1)}`, { method: "DELETE", headers: { "x-base-rev": "1" } })).status, 409);
        assert.equal((await dev(`/files/${id(1)}`, { method: "DELETE", headers: { "x-base-rev": "2" } })).status, 200);
        assert.equal((await dev(`/files/${id(1)}`)).status, 410);
        assert.equal((await put(1, 3, "back")).status, 200);
    });

    it("commits a batch atomically", async () => {
        const ops = [
            { op: "put", id: id(2), baseRev: 0, meta: META, data: blob("renamed").toString("base64") },
            { op: "delete", id: id(1), baseRev: 99 },
        ];
        const bad = await dev("/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) });
        assert.equal(bad.status, 409);
        assert.equal((await bad.json()).index, 1);
        assert.equal((await dev(`/files/${id(2)}`)).status, 404, "first op rolled back");

        ops[1] = { op: "delete", id: id(1), baseRev: 4 };
        const good = await dev("/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) });
        assert.equal(good.status, 200);
        assert.equal((await good.json()).results.length, 2);
    });

    it("returns only each file's current version, in sequence order", async () => {
        const all = await (await dev("/changes?since=0")).json();
        assert.deepEqual(
            all.changes.map((c: { seq: number; rev: number; deleted: boolean }) => [c.seq, c.rev, c.deleted]),
            [[5, 1, false], [6, 5, true]]
        );
        assert.equal(all.head, 6);
        assert.equal(all.next, 6);
        const page = await (await dev("/changes?since=0&limit=1")).json();
        assert.deepEqual(page.changes.map((c: { seq: number }) => c.seq), [5]);
        assert.equal(page.next, 5);
        assert.equal(page.more, true);
        const rest = await (await dev(`/changes?since=${page.next}`)).json();
        assert.deepEqual(rest.changes.map((c: { seq: number }) => c.seq), [6]);
        assert.equal(rest.more, false);
    });

    it("lists files with their latest readable metadata", async () => {
        const { files } = await (await admin("/files")).json();
        const f1 = files.find((f: { id: string }) => f.id === id(1));
        assert.equal(f1.deleted, true);
        assert.equal(f1.metaRev, 4);
        const { versions } = await (await admin(`/files/${id(1)}/versions`)).json();
        assert.deepEqual(versions.map((v: { rev: number }) => v.rev), [5, 4, 3, 2, 1]);
        assert.equal(versions[0].deviceName, "Mac");
    });

    it("turns two-factor authentication off with the passphrase and a code", async () => {
        assert.equal((await admin("/totp/disable", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY, totp: "000000" }) })).status, 403);
        const r = await admin("/totp/disable", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY, totp: nextCode() }) });
        assert.equal(r.status, 200);
        assert.equal((await (await admin("/prelogin")).json()).totp, false);
        cookie = "";
        assert.equal((await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY }) })).status, 200, "passphrase alone now logs in");
    });

    it("stops a revoked device", async () => {
        const overview = await (await admin("/overview")).json();
        assert.equal(overview.devices.length, 1);
        assert.equal((await admin(`/devices/${deviceId}/revoke`, { method: "POST" })).status, 200);
        assert.equal((await put(9, 0)).status, 401);
    });

    it("lets reset-2fa fall back to passphrase-only login until re-enrolment", async () => {
        reset2fa(db);
        cookie = "";
        const r = await admin("/login", { method: "POST", body: JSON.stringify({ loginKey: LOGIN_KEY }) });
        assert.equal(r.status, 200);
        assert.equal((await (await admin("/session")).json()).totpEnabled, false);
    });
});
