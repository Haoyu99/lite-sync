// HTTP and WebSocket routes. Device API under /v1, admin API under /admin/api. See docs/design.md §5 and §7.

import { randomUUID } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import type {
    AuditEntry,
    BatchRequest,
    ChangePage,
    DeviceSummary,
    FileEntry,
    KdfParams,
    LoginRequest,
    Overview,
    PairRequest,
    PassphraseReset,
    Platform,
    SetupRequest,
    StatusReport,
    VaultInfo,
    VersionEntry,
} from "@lite-sync/core";
import {
    ServerKey,
    currentStep,
    newPairingCode,
    newRecoveryCodes,
    newToken,
    newTotpSecret,
    normaliseCode,
    otpauthUrl,
    safeEqual,
    sha256Hex,
    verifyTotp,
} from "./auth.ts";
import { type Db, type WriteOutcome, toChange } from "./db.ts";

export interface AppOptions {
    db: Db;
    serverKey: ServerKey;
    maxBodyBytes?: number;
    insecureCookies?: boolean; // plain-HTTP development only
    now?: () => number;
}

type DeviceRow = { id: string; name: string };
type Env = { Variables: { device: DeviceRow } };

const SESSION_COOKIE = "ls_session";
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_MAX_MS = 12 * 60 * 60_000;
const PAIRING_TTL_MS = 10 * 60_000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60_000;
const ID_RE = /^[0-9a-f]{64}$/;
const PLATFORMS: Platform[] = ["macos", "windows", "linux", "ios", "android", "unknown"];

const isB64 = (s: unknown, maxLen = 1 << 20): s is string =>
    typeof s === "string" && s.length > 0 && s.length <= maxLen && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

function validKdf(k: unknown): k is KdfParams {
    const o = k as KdfParams;
    return !!o && o.alg === "PBKDF2-SHA256" && Number.isInteger(o.iterations) && o.iterations >= 100_000 && o.iterations <= 10_000_000;
}

function intHeader(c: Context, name: string): number | null {
    const v = c.req.header(name);
    if (v === undefined || !/^\d{1,12}$/.test(v)) return null;
    return Number(v);
}

export function createApp(opts: AppOptions) {
    const { db, serverKey } = opts;
    const now = opts.now ?? Date.now;
    const app = new Hono<Env>();
    const sockets = new Set<WSContext>();
    let pairFails: number[] = [];

    const notify = () => {
        const msg = JSON.stringify({ head: db.head() });
        for (const ws of sockets) {
            try {
                ws.send(msg);
            } catch {
                sockets.delete(ws);
            }
        }
    };

    const writeResult = (c: Context, r: WriteOutcome) => {
        if (!r.ok) return c.json(r.conflict, 409);
        notify();
        return c.json({ rev: r.rev, seq: r.seq });
    };

    app.onError((err, c) => {
        console.error(err);
        return c.json({ error: "internal" }, 500);
    });

    // Set here rather than in the reverse proxy, so the console is protected behind any proxy.
    // The console decrypts data in the browser, so it must never load scripts from elsewhere.
    // Inline styles are allowed because the console sets layout values through style attributes.
    app.use("*", async (c, next) => {
        await next();
        if (c.res.status === 101) return;
        try {
            const h = c.res.headers;
            h.set("X-Content-Type-Options", "nosniff");
            h.set("Referrer-Policy", "no-referrer");
            h.set("X-Frame-Options", "DENY");
            h.set("Cross-Origin-Opener-Policy", "same-origin");
            h.set(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            );
            if (!opts.insecureCookies) h.set("Strict-Transport-Security", "max-age=31536000");
        } catch {
            /* responses with immutable headers */
        }
    });

    app.use(
        "*",
        bodyLimit({
            maxSize: opts.maxBodyBytes ?? 100 * 1024 * 1024,
            onError: (c) => c.json({ error: "too_large" }, 413),
        })
    );

    app.get("/healthz", (c) => c.json({ ok: true, head: db.head() }));

    // ===== Device API =======================================================================

    const deviceAuth = async (c: Context<Env>, next: Next) => {
        const h = c.req.header("authorization") ?? "";
        const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
        const dev = token ? db.get<DeviceRow>("SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL", sha256Hex(token)) : undefined;
        if (!dev) return c.json({ error: "unauthorised" }, 401);
        db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", now(), dev.id);
        c.set("device", dev);
        await next();
    };

    app.post("/v1/pair", async (c) => {
        const t = now();
        pairFails = pairFails.filter((x) => t - x < 10 * 60_000);
        if (pairFails.length >= 10) return c.json({ error: "rate_limited" }, 429);
        const body = (await c.req.json().catch(() => null)) as PairRequest | null;
        const code = typeof body?.code === "string" ? normaliseCode(body.code) : "";
        const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
        if (!code || !name) return c.json({ error: "bad_request" }, 400);
        const platform = PLATFORMS.includes(body!.platform) ? body!.platform : "unknown";
        const clientVersion = typeof body!.clientVersion === "string" ? body!.clientVersion.slice(0, 20) : "?";
        const result = db.tx(() => {
            const row = db.get<{ expires_at: number }>(
                "SELECT expires_at FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL",
                sha256Hex(code)
            );
            if (!row || row.expires_at < t) return null;
            db.run("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?", t, sha256Hex(code));
            const deviceId = randomUUID();
            const token = newToken();
            db.run(
                "INSERT INTO devices (id, name, platform, client_version, token_hash, created_at, last_seen_at, ack_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                deviceId, name, platform, clientVersion, sha256Hex(token), t, t
            );
            db.audit("device:" + deviceId, "device.paired", `${name} (${platform})`);
            return { deviceId, token };
        });
        if (!result) {
            pairFails.push(t);
            return c.json({ error: "invalid_code" }, 403);
        }
        return c.json(result);
    });

    const v1 = new Hono<Env>();
    v1.use("*", deviceAuth);

    v1.get("/vault", (c) => {
        const v = db.get<{ salt: string; kdf: string; wrapped_mk: string }>("SELECT salt, kdf, wrapped_mk FROM vault WHERE id = 1");
        if (!v) return c.json({ error: "not_initialised" }, 404);
        return c.json({ salt: v.salt, kdf: JSON.parse(v.kdf), wrappedMk: v.wrapped_mk } satisfies VaultInfo);
    });

    v1.get("/changes", (c) => {
        const since = Math.max(0, Number(c.req.query("since") ?? 0) || 0);
        const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 500) || 500));
        const changes = db.changes(since, limit);
        const head = db.head();
        const more = changes.length === limit;
        const page: ChangePage = { changes, next: more ? changes.at(-1)!.seq : Math.max(head, since), head, more };
        return c.json(page);
    });

    const sendVersion = (c: Context, id: string, v: ReturnType<Db["version"]>) => {
        if (!v) return c.json({ error: "not_found" }, 404);
        if (v.deleted || !v.object) return c.json({ error: "deleted", rev: v.rev }, 410);
        return c.body(new Uint8Array(db.objects.getSync(v.object)), 200, {
            "Content-Type": "application/octet-stream",
            "X-Rev": String(v.rev),
            "X-Meta": v.meta ?? "",
            "Cache-Control": "no-store",
        });
    };

    v1.get("/files/:id", (c) => {
        const id = c.req.param("id");
        if (!ID_RE.test(id)) return c.json({ error: "bad_id" }, 400);
        return sendVersion(c, id, db.latest(id));
    });

    v1.get("/files/:id/versions/:rev", (c) => {
        const id = c.req.param("id");
        const rev = Number(c.req.param("rev"));
        if (!ID_RE.test(id) || !Number.isInteger(rev)) return c.json({ error: "bad_request" }, 400);
        return sendVersion(c, id, db.version(id, rev));
    });

    v1.put("/files/:id", async (c) => {
        const id = c.req.param("id");
        const baseRev = intHeader(c, "x-base-rev");
        const meta = c.req.header("x-meta");
        if (!ID_RE.test(id) || baseRev === null || !isB64(meta, 16_384)) return c.json({ error: "bad_request" }, 400);
        const data = new Uint8Array(await c.req.arrayBuffer());
        if (data.byteLength < 29) return c.json({ error: "bad_request" }, 400);
        return writeResult(c, db.put({ id, baseRev, deviceId: c.get("device").id }, meta, data));
    });

    v1.delete("/files/:id", (c) => {
        const id = c.req.param("id");
        const baseRev = intHeader(c, "x-base-rev");
        if (!ID_RE.test(id) || baseRev === null) return c.json({ error: "bad_request" }, 400);
        return writeResult(c, db.delete({ id, baseRev, deviceId: c.get("device").id }));
    });

    // All operations commit together or none does: a rename never leaves only one half applied.
    v1.post("/batch", async (c) => {
        const body = (await c.req.json().catch(() => null)) as BatchRequest | null;
        const ops = body?.ops;
        if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100) return c.json({ error: "bad_request" }, 400);
        for (const o of ops) {
            if (!o || !ID_RE.test(o.id) || !Number.isInteger(o.baseRev)) return c.json({ error: "bad_request" }, 400);
            if (o.op === "put" ? !isB64(o.meta, 16_384) || !isB64(o.data, 200 << 20) : o.op !== "delete")
                return c.json({ error: "bad_request" }, 400);
        }
        const deviceId = c.get("device").id;
        const batchId = randomUUID();
        class Abort extends Error {
            index: number;
            outcome: WriteOutcome;
            constructor(index: number, outcome: WriteOutcome) {
                super("abort");
                this.index = index;
                this.outcome = outcome;
            }
        }
        try {
            const results = db.tx(() =>
                ops.map((o, index) => {
                    const w = { id: o.id, baseRev: o.baseRev, deviceId, batchId };
                    const r = o.op === "put" ? db.putInTx(w, o.meta, Buffer.from(o.data, "base64")) : db.deleteInTx(w);
                    if (!r.ok) throw new Abort(index, r);
                    return { rev: r.rev, seq: r.seq };
                })
            );
            notify();
            return c.json({ ok: true, results });
        } catch (e) {
            if (e instanceof Abort && !e.outcome.ok) return c.json({ ok: false, index: e.index, conflict: e.outcome.conflict }, 409);
            throw e;
        }
    });

    v1.get("/config", (c) => {
        const row = db.get<{ rev: number; blob: string }>("SELECT rev, blob FROM config_versions ORDER BY rev DESC LIMIT 1");
        return c.json(row ? { rev: row.rev, blob: row.blob } : { rev: 0, blob: null });
    });

    v1.post("/status", async (c) => {
        const body = (await c.req.json().catch(() => null)) as StatusReport | null;
        if (!body || !Number.isInteger(body.pending) || !Number.isInteger(body.seq)) return c.json({ error: "bad_request" }, 400);
        db.run(
            "UPDATE devices SET pending = ?, ack_seq = ?, client_version = ? WHERE id = ?",
            Math.max(0, body.pending), Math.max(0, body.seq), String(body.clientVersion ?? "?").slice(0, 20), c.get("device").id
        );
        return c.json({ ok: true });
    });

    app.route("/v1", v1);

    // ===== WebSocket change notifications ===================================================
    // Browsers cannot set headers on WebSocket requests, so the first message carries the token.

    const wsEvents = () => {
        let authed = false;
        return {
            onMessage(evt: MessageEvent, ws: WSContext) {
                if (authed) return;
                let token = "";
                try {
                    token = String((JSON.parse(String(evt.data)) as { token?: string }).token ?? "");
                } catch {
                    /* closed below */
                }
                const ok = token && db.get("SELECT 1 FROM devices WHERE token_hash = ? AND revoked_at IS NULL", sha256Hex(token));
                if (!ok) return ws.close(4401, "unauthorised");
                authed = true;
                sockets.add(ws);
                ws.send(JSON.stringify({ head: db.head() }));
            },
            onClose(_evt: CloseEvent, ws: WSContext) {
                sockets.delete(ws);
            },
        };
    };

    // ===== Admin API ========================================================================

    const vaultRow = () =>
        db.get<{ salt: string; kdf: string; login_hash: string; wrapped_mk: string; mk_proof_hash: string | null }>("SELECT * FROM vault WHERE id = 1");
    const adminRow = () =>
        db.get<{ totp_secret: string | null; totp_pending: string | null; totp_last_step: number; recovery: string; fail_count: number; locked_until: number }>(
            "SELECT * FROM admin WHERE id = 1"
        )!;

    function recordFailure() {
        const a = adminRow();
        const fails = a.fail_count + 1;
        if (fails >= LOGIN_MAX_FAILS) db.run("UPDATE admin SET fail_count = 0, locked_until = ? WHERE id = 1", now() + LOGIN_LOCK_MS);
        else db.run("UPDATE admin SET fail_count = ? WHERE id = 1", fails);
    }

    // Verifies the second factor. Two-factor authentication is optional: without a confirmed TOTP secret
    // (never enabled, turned off in the console, or removed by `reset-2fa`) the check passes.
    function checkTotp(totp: string, recoveryCode: string | undefined): "ok" | "locked" | "bad_totp" {
        const a = adminRow();
        if (a.locked_until > now()) return "locked";
        if (!a.totp_secret) return "ok";
        if (recoveryCode) {
            const codes = JSON.parse(a.recovery) as string[];
            const h = sha256Hex(recoveryCode.trim().toLowerCase());
            const idx = codes.findIndex((x) => safeEqual(x, h));
            if (idx < 0) return recordFailure(), "bad_totp";
            codes.splice(idx, 1);
            db.run("UPDATE admin SET recovery = ?, fail_count = 0 WHERE id = 1", JSON.stringify(codes));
            db.audit("admin", "recovery_code.used", `${codes.length} left`);
            return "ok";
        }
        const secret = serverKey.open(a.totp_secret, "totp");
        const step = verifyTotp(secret, totp, a.totp_last_step, now());
        if (step === null) return recordFailure(), "bad_totp";
        db.run("UPDATE admin SET totp_last_step = ?, fail_count = 0 WHERE id = 1", step);
        return "ok";
    }

    function checkLoginKey(loginKey: unknown): boolean {
        const v = vaultRow();
        return !!v && typeof loginKey === "string" && safeEqual(sha256Hex(loginKey), v.login_hash);
    }

    function startSession(c: Context) {
        const id = newToken();
        const t = now();
        db.run("INSERT INTO sessions (id_hash, created_at, last_at) VALUES (?, ?, ?)", sha256Hex(id), t, t);
        setCookie(c, SESSION_COOKIE, id, {
            httpOnly: true,
            secure: !opts.insecureCookies,
            sameSite: "Strict",
            path: "/admin",
            maxAge: SESSION_MAX_MS / 1000,
        });
    }

    const adminApi = new Hono();

    // Custom header on every admin request: a cross-site form cannot set it, which backs up SameSite.
    adminApi.use("*", async (c, next) => {
        if (c.req.header("x-lite-sync") !== "1") return c.json({ error: "missing_header" }, 400);
        await next();
    });

    adminApi.get("/prelogin", (c) => {
        const v = vaultRow();
        return c.json(v ? { initialised: true, salt: v.salt, kdf: JSON.parse(v.kdf), totp: !!adminRow().totp_secret } : { initialised: false });
    });

    adminApi.post("/setup", async (c) => {
        const body = (await c.req.json().catch(() => null)) as SetupRequest | null;
        const expected = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'setup_token_hash'")?.value;
        if (!body || !expected || typeof body.setupToken !== "string" || !safeEqual(sha256Hex(body.setupToken), expected))
            return c.json({ error: "invalid_setup_token" }, 403);
        if (!isB64(body.salt, 64) || !validKdf(body.kdf) || !isB64(body.loginKey, 64) || !isB64(body.wrappedMk, 256) || !isB64(body.mkProof, 64))
            return c.json({ error: "bad_request" }, 400);
        const done = db.tx(() => {
            if (vaultRow()) return false;
            db.run(
                "INSERT INTO vault (id, salt, kdf, login_hash, wrapped_mk, mk_proof_hash, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
                body.salt, JSON.stringify(body.kdf), sha256Hex(body.loginKey), body.wrappedMk, sha256Hex(body.mkProof), now()
            );
            db.run("DELETE FROM settings WHERE key = 'setup_token_hash'");
            db.audit("admin", "vault.initialised");
            return true;
        });
        if (!done) return c.json({ error: "already_initialised" }, 409);
        startSession(c);
        return c.json({ ok: true });
    });

    adminApi.post("/login", async (c) => {
        const body = (await c.req.json().catch(() => null)) as LoginRequest | null;
        if (adminRow().locked_until > now()) return c.json({ error: "locked" }, 429);
        if (!body || !checkLoginKey(body.loginKey)) {
            recordFailure();
            return c.json({ error: "bad_credentials" }, 403);
        }
        const r = checkTotp(body.totp ?? "", body.recoveryCode);
        if (r !== "ok") return c.json({ error: r }, r === "locked" ? 429 : 403);
        startSession(c);
        db.audit("admin", "login", body.recoveryCode ? "recovery code" : null);
        return c.json({ wrappedMk: vaultRow()!.wrapped_mk, recoveryCodesLeft: (JSON.parse(adminRow().recovery) as string[]).length });
    });

    const authed = new Hono();
    authed.use("*", async (c, next) => {
        const id = getCookie(c, SESSION_COOKIE);
        const t = now();
        const s = id ? db.get<{ created_at: number; last_at: number }>("SELECT created_at, last_at FROM sessions WHERE id_hash = ?", sha256Hex(id)) : undefined;
        if (!s || t - s.last_at > SESSION_IDLE_MS || t - s.created_at > SESSION_MAX_MS) {
            if (id) db.run("DELETE FROM sessions WHERE id_hash = ?", sha256Hex(id));
            return c.json({ error: "unauthorised" }, 401);
        }
        db.run("UPDATE sessions SET last_at = ? WHERE id_hash = ?", t, sha256Hex(id!));
        await next();
    });

    authed.post("/logout", (c) => {
        const id = getCookie(c, SESSION_COOKIE);
        if (id) db.run("DELETE FROM sessions WHERE id_hash = ?", sha256Hex(id));
        deleteCookie(c, SESSION_COOKIE, { path: "/admin" });
        return c.json({ ok: true });
    });

    authed.get("/session", (c) => {
        const a = adminRow();
        return c.json({
            wrappedMk: vaultRow()!.wrapped_mk,
            totpEnabled: !!a.totp_secret,
            recoveryCodesLeft: (JSON.parse(a.recovery) as string[]).length,
        });
    });

    authed.post("/totp/begin", (c) => {
        if (adminRow().totp_secret) return c.json({ error: "already_enabled" }, 409);
        const secret = newTotpSecret();
        db.run("UPDATE admin SET totp_pending = ? WHERE id = 1", serverKey.seal(secret, "totp"));
        return c.json({ secret, otpauthUrl: otpauthUrl(secret) });
    });

    authed.post("/totp/confirm", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { totp?: string } | null;
        const a = adminRow();
        if (a.totp_secret) return c.json({ error: "already_enabled" }, 409);
        if (!a.totp_pending) return c.json({ error: "not_started" }, 400);
        const secret = serverKey.open(a.totp_pending, "totp");
        const step = verifyTotp(secret, body?.totp ?? "", 0, now());
        if (step === null) return c.json({ error: "bad_totp" }, 403);
        const codes = newRecoveryCodes();
        db.run(
            "UPDATE admin SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, recovery = ? WHERE id = 1",
            step, JSON.stringify(codes.map((x) => sha256Hex(x)))
        );
        db.audit("admin", "totp.enabled");
        return c.json({ recoveryCodes: codes });
    });

    // Turning the second factor off requires the passphrase and a current code.
    authed.post("/totp/disable", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { loginKey?: string; totp?: string } | null;
        if (!adminRow().totp_secret) return c.json({ error: "not_enabled" }, 409);
        if (!checkLoginKey(body?.loginKey)) {
            recordFailure();
            return c.json({ error: "bad_credentials" }, 403);
        }
        const r = checkTotp(body?.totp ?? "", undefined);
        if (r !== "ok") return c.json({ error: r }, r === "locked" ? 429 : 403);
        db.run("UPDATE admin SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0, recovery = '[]' WHERE id = 1");
        db.audit("admin", "totp.disabled");
        return c.json({ ok: true });
    });

    authed.post("/recovery-codes", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { loginKey?: string; totp?: string } | null;
        if (!checkLoginKey(body?.loginKey)) return c.json({ error: "bad_credentials" }, 403);
        const r = checkTotp(body?.totp ?? "", undefined);
        if (r !== "ok") return c.json({ error: r }, 403);
        const codes = newRecoveryCodes();
        db.run("UPDATE admin SET recovery = ? WHERE id = 1", JSON.stringify(codes.map((x) => sha256Hex(x))));
        db.audit("admin", "recovery_codes.regenerated");
        return c.json({ recoveryCodes: codes });
    });

    authed.post("/passphrase", async (c) => {
        const body = (await c.req.json().catch(() => null)) as (PassphraseReset & { currentLoginKey?: string }) | null;
        if (!body || !checkLoginKey(body.currentLoginKey)) return c.json({ error: "bad_credentials" }, 403);
        if (!isB64(body.salt, 64) || !validKdf(body.kdf) || !isB64(body.loginKey, 64) || !isB64(body.wrappedMk, 256))
            return c.json({ error: "bad_request" }, 400);
        const r = checkTotp(body.totp ?? "", undefined);
        if (r !== "ok") return c.json({ error: r }, 403);
        db.run(
            "UPDATE vault SET salt = ?, kdf = ?, login_hash = ?, wrapped_mk = ?, updated_at = ? WHERE id = 1",
            body.salt, JSON.stringify(body.kdf), sha256Hex(body.loginKey), body.wrappedMk, now()
        );
        db.audit("admin", "passphrase.changed");
        return c.json({ ok: true });
    });

    const deviceSummaries = (): DeviceSummary[] =>
        db.all<Record<string, unknown>>("SELECT * FROM devices ORDER BY created_at").map((d) => ({
            id: d.id as string,
            name: d.name as string,
            platform: d.platform as Platform,
            clientVersion: d.client_version as string,
            createdAt: d.created_at as number,
            lastSeenAt: (d.last_seen_at as number | null) ?? null,
            ackSeq: d.ack_seq as number,
            pending: d.pending as number,
            revokedAt: (d.revoked_at as number | null) ?? null,
        }));

    authed.get("/overview", (c) => {
        const counts = db.get<{ files: number; deleted: number }>(
            "SELECT COUNT(*) AS files, COALESCE(SUM(deleted), 0) AS deleted FROM files"
        )!;
        const versions = db.get<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM versions")!;
        const storage = db.get<{ bytes: number }>(
            "SELECT COALESCE(SUM(size), 0) AS bytes FROM (SELECT object, MAX(size) AS size FROM versions WHERE object IS NOT NULL GROUP BY object)"
        )!;
        const recent = db
            .all<Record<string, unknown>>(
                `SELECT v.*, d.name AS device_name FROM versions v LEFT JOIN devices d ON d.id = v.device_id ORDER BY v.seq DESC LIMIT 30`
            )
            .map((r) => ({ ...toChange(r), deviceName: (r.device_name as string | null) ?? null }));
        const o: Overview = {
            head: db.head(),
            files: counts.files - counts.deleted,
            deletedFiles: counts.deleted,
            versions: versions.n,
            storageBytes: storage.bytes,
            devices: deviceSummaries(),
            recent,
        };
        return c.json(o);
    });

    authed.post("/pairing-codes", (c) => {
        const code = newPairingCode();
        const expiresAt = now() + PAIRING_TTL_MS;
        db.run("DELETE FROM pairing_codes WHERE expires_at < ?", now() - 24 * 60 * 60_000);
        db.run("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)", sha256Hex(normaliseCode(code)), expiresAt);
        db.audit("admin", "pairing_code.created");
        return c.json({ code, expiresAt });
    });

    authed.patch("/devices/:id", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
        const name = body?.name?.trim().slice(0, 60);
        if (!name) return c.json({ error: "bad_request" }, 400);
        const r = db.run("UPDATE devices SET name = ? WHERE id = ?", name, c.req.param("id"));
        if (r.changes === 0) return c.json({ error: "not_found" }, 404);
        db.audit("admin", "device.renamed", name);
        return c.json({ ok: true });
    });

    authed.post("/devices/:id/revoke", (c) => {
        const id = c.req.param("id");
        const r = db.run("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now(), id);
        if (r.changes === 0) return c.json({ error: "not_found" }, 404);
        db.audit("admin", "device.revoked", db.get<{ name: string }>("SELECT name FROM devices WHERE id = ?", id)?.name ?? id);
        return c.json({ ok: true });
    });

    // The meta of a deleted file's last readable version is returned so the console can show its name.
    authed.get("/files", (c) => {
        const rows = db.all<Record<string, unknown>>(
            `SELECT f.id, f.rev, f.deleted, f.updated_at, v.meta, v.rev AS meta_rev, v.size
             FROM files f JOIN versions v ON v.file_id = f.id
               AND v.rev = (SELECT MAX(rev) FROM versions WHERE file_id = f.id AND deleted = 0)`
        );
        const files: FileEntry[] = rows.map((r) => ({
            id: r.id as string,
            rev: r.rev as number,
            deleted: r.deleted === 1,
            meta: r.meta as string,
            metaRev: r.meta_rev as number,
            size: r.size as number,
            updatedAt: r.updated_at as number,
        }));
        return c.json({ files });
    });

    authed.get("/files/:id/versions", (c) => {
        const rows = db.all<Record<string, unknown>>(
            `SELECT v.*, d.name AS device_name FROM versions v LEFT JOIN devices d ON d.id = v.device_id
             WHERE v.file_id = ? ORDER BY v.rev DESC`,
            c.req.param("id")
        );
        const versions: VersionEntry[] = rows.map((r) => ({
            rev: r.rev as number,
            seq: r.seq as number,
            op: r.op as VersionEntry["op"],
            deleted: r.deleted === 1,
            meta: (r.meta as string | null) ?? null,
            size: r.size as number,
            deviceId: (r.device_id as string | null) ?? null,
            deviceName: (r.device_name as string | null) ?? null,
            at: r.at as number,
            batchId: (r.batch_id as string | null) ?? null,
        }));
        return c.json({ versions });
    });

    authed.get("/files/:id/versions/:rev", (c) => {
        const id = c.req.param("id");
        const rev = Number(c.req.param("rev"));
        if (!ID_RE.test(id) || !Number.isInteger(rev)) return c.json({ error: "bad_request" }, 400);
        return sendVersion(c, id, db.version(id, rev));
    });

    // Restores are encrypted in the browser, because the ciphertext is bound to its new revision.
    authed.put("/files/:id", async (c) => {
        const id = c.req.param("id");
        const baseRev = intHeader(c, "x-base-rev");
        const meta = c.req.header("x-meta");
        if (!ID_RE.test(id) || baseRev === null || !isB64(meta, 16_384)) return c.json({ error: "bad_request" }, 400);
        const data = new Uint8Array(await c.req.arrayBuffer());
        if (data.byteLength < 29) return c.json({ error: "bad_request" }, 400);
        const r = db.put({ id, baseRev, deviceId: null, op: "restore" }, meta, data);
        if (r.ok) db.audit("admin", "file.restored", `${id.slice(0, 12)} → rev ${r.rev}`);
        return writeResult(c, r);
    });

    authed.get("/audit", (c) => {
        const entries = db.all<AuditEntry>("SELECT at, actor, action, detail FROM audit ORDER BY rowid DESC LIMIT 200");
        return c.json({ entries });
    });

    authed.get("/config", (c) => {
        const row = db.get<{ rev: number; blob: string }>("SELECT rev, blob FROM config_versions ORDER BY rev DESC LIMIT 1");
        return c.json(row ? { rev: row.rev, blob: row.blob } : { rev: 0, blob: null });
    });

    authed.put("/config", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { baseRev?: number; blob?: string } | null;
        if (!body || !Number.isInteger(body.baseRev) || !isB64(body.blob, 1 << 20)) return c.json({ error: "bad_request" }, 400);
        const r = db.tx(() => {
            const cur = db.get<{ rev: number }>("SELECT COALESCE(MAX(rev), 0) AS rev FROM config_versions")!.rev;
            if (cur !== body.baseRev) return { ok: false as const, rev: cur };
            db.run("INSERT INTO config_versions (rev, blob, at) VALUES (?, ?, ?)", cur + 1, body.blob!, now());
            db.audit("admin", "config.saved", `rev ${cur + 1}`);
            return { ok: true as const, rev: cur + 1 };
        });
        if (!r.ok) return c.json({ error: "conflict", rev: r.rev }, 409);
        const msg = JSON.stringify({ config: r.rev });
        for (const ws of sockets) ws.send(msg);
        return c.json({ rev: r.rev });
    });

    adminApi.route("/", authed);
    app.route("/admin/api", adminApi);

    return { app, notify, wsEvents, sockets };
}

// Generates a fresh one-time setup token while the vault is uninitialised. Returns null afterwards.
export function issueSetupToken(db: Db): string | null {
    if (db.get("SELECT 1 FROM vault WHERE id = 1")) return null;
    const token = newToken(24);
    db.run(
        "INSERT INTO settings (key, value) VALUES ('setup_token_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        sha256Hex(token)
    );
    return token;
}

export function reset2fa(db: Db) {
    db.run("UPDATE admin SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0, recovery = '[]', fail_count = 0, locked_until = 0 WHERE id = 1");
    db.run("DELETE FROM sessions");
    db.audit("server", "totp.reset");
}

export { currentStep };
