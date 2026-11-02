// SQLite schema and the version-history write path. See docs/design.md §6.
// History is append-only: every write, deletion, and restore adds a row to `versions`.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Change, ChangeOp, ConflictResponse, WriteResponse } from "@lite-sync/core";
import { ObjectStore } from "./store.ts";

const SCHEMA = `
CREATE TABLE vault (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    kdf TEXT NOT NULL,
    login_hash TEXT NOT NULL,
    wrapped_mk TEXT NOT NULL,
    mk_proof_hash TEXT,
    updated_at INTEGER NOT NULL
);
CREATE TABLE admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    totp_secret TEXT,           -- sealed with the server key; null until confirmed
    totp_pending TEXT,          -- sealed secret awaiting its first code
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    recovery TEXT NOT NULL DEFAULT '[]', -- JSON array of SHA-256 hashes of unused codes
    fail_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL
);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    client_version TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ack_seq INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
);
CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE versions (
    file_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    seq INTEGER NOT NULL UNIQUE,
    op TEXT NOT NULL,
    deleted INTEGER NOT NULL,
    object TEXT,
    meta TEXT,
    size INTEGER NOT NULL,
    device_id TEXT,
    at INTEGER NOT NULL,
    batch_id TEXT,
    PRIMARY KEY (file_id, rev)
);
CREATE INDEX versions_at ON versions (at);
CREATE TABLE config_versions (
    rev INTEGER PRIMARY KEY,
    blob TEXT NOT NULL,
    at INTEGER NOT NULL
);
CREATE TABLE audit (
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
);
CREATE TABLE plugin_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seed_device TEXT NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE plugin_versions (
    id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    object TEXT NOT NULL,
    size INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (id, rev)
);
CREATE TABLE trusted_browsers (
    id_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL
);
INSERT INTO admin (id) VALUES (1);
`;

export type WriteOutcome = ({ ok: true } & WriteResponse) | { ok: false; conflict: ConflictResponse };

export interface WriteInput {
    id: string;
    baseRev: number;
    deviceId: string | null;
    batchId?: string | null;
    op?: ChangeOp;
    at?: number;
}

type Row = Record<string, unknown>;

export class Db {
    readonly sql: DatabaseSync;
    readonly objects: ObjectStore;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.sql = new DatabaseSync(join(dataDir, "lite-sync.db"));
        this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
        this.objects = new ObjectStore(dataDir);
        this.initialise();
    }

    private initialise() {
        // One current schema. Existing databases are opened as-is; no historical upgrade paths.
        if (this.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'vault'")) return;
        this.tx(() => this.sql.exec(SCHEMA));
    }

    // node:sqlite is synchronous, so a transaction cannot interleave with another request.
    tx<T>(fn: () => T): T {
        this.sql.exec("BEGIN IMMEDIATE");
        try {
            const r = fn();
            this.sql.exec("COMMIT");
            return r;
        } catch (e) {
            this.sql.exec("ROLLBACK");
            throw e;
        }
    }

    get<T>(query: string, ...params: (string | number | null)[]): T | undefined {
        return this.sql.prepare(query).get(...params) as T | undefined;
    }

    all<T>(query: string, ...params: (string | number | null)[]): T[] {
        return this.sql.prepare(query).all(...params) as T[];
    }

    run(query: string, ...params: (string | number | null)[]) {
        return this.sql.prepare(query).run(...params);
    }

    head(): number {
        return this.get<{ s: number }>("SELECT COALESCE(MAX(seq), 0) AS s FROM versions")!.s;
    }

    audit(actor: string, action: string, detail: string | null = null) {
        this.run("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", Date.now(), actor, action, detail);
    }

    private current(id: string) {
        return this.get<{ rev: number; deleted: number }>("SELECT rev, deleted FROM files WHERE id = ?", id);
    }

    private conflict(id: string): WriteOutcome {
        const cur = this.current(id);
        return { ok: false, conflict: { error: "conflict", rev: cur?.rev ?? 0, deleted: cur ? cur.deleted === 1 : true } };
    }

    private append(w: WriteInput, rev: number, deleted: boolean, object: string | null, meta: string | null, size: number): WriteOutcome {
        const at = w.at ?? Date.now();
        const seq = this.head() + 1;
        this.run(
            `INSERT INTO versions (file_id, rev, seq, op, deleted, object, meta, size, device_id, at, batch_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            w.id, rev, seq, w.op ?? (deleted ? "delete" : "write"), deleted ? 1 : 0, object, meta, size, w.deviceId, at, w.batchId ?? null
        );
        this.run(
            `INSERT INTO files (id, rev, deleted, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted, updated_at = excluded.updated_at`,
            w.id, rev, deleted ? 1 : 0, at
        );
        return { ok: true, rev, seq };
    }

    // Must run inside tx(). A write is accepted only when baseRev is the file's current revision;
    // a file which never existed has revision 0.
    putInTx(w: WriteInput, meta: string, data: Uint8Array): WriteOutcome {
        const curRev = this.current(w.id)?.rev ?? 0;
        if (w.baseRev !== curRev) return this.conflict(w.id);
        const object = this.objects.putSync(data);
        return this.append(w, curRev + 1, false, object, meta, data.byteLength);
    }

    deleteInTx(w: WriteInput): WriteOutcome {
        const cur = this.current(w.id);
        if (!cur || cur.deleted === 1 || w.baseRev !== cur.rev) return this.conflict(w.id);
        return this.append(w, cur.rev + 1, true, null, null, 0);
    }

    put(w: WriteInput, meta: string, data: Uint8Array): WriteOutcome {
        return this.tx(() => this.putInTx(w, meta, data));
    }

    delete(w: WriteInput): WriteOutcome {
        return this.tx(() => this.deleteInTx(w));
    }

    // Only each file's current version is returned, so a client never replays superseded history.
    // Paging by seq stays correct: a file changed between pages reappears later with a larger seq.
    changes(since: number, limit: number): Change[] {
        return this.all<Row>(
            `SELECT v.seq, v.file_id, v.rev, v.op, v.deleted, v.meta, v.size, v.device_id, v.at
             FROM versions v JOIN files f ON f.id = v.file_id AND f.rev = v.rev
             WHERE v.seq > ? ORDER BY v.seq LIMIT ?`,
            since,
            limit
        ).map(toChange);
    }

    version(id: string, rev: number) {
        return this.get<{ rev: number; deleted: number; object: string | null; meta: string | null }>(
            "SELECT rev, deleted, object, meta FROM versions WHERE file_id = ? AND rev = ?",
            id,
            rev
        );
    }

    latest(id: string) {
        const cur = this.current(id);
        return cur ? this.version(id, cur.rev) : undefined;
    }
}

export function toChange(r: Row): Change {
    return {
        seq: r.seq as number,
        id: r.file_id as string,
        rev: r.rev as number,
        op: r.op as ChangeOp,
        deleted: r.deleted === 1,
        meta: (r.meta as string | null) ?? null,
        size: r.size as number,
        deviceId: (r.device_id as string | null) ?? null,
        at: r.at as number,
    };
}
