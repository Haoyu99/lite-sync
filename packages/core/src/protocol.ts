// Wire types shared by the server, plug-in, and admin. See docs/design.md §7.

import type { KdfParams } from "./crypto.ts";

export const API_VERSION = 1;
export const MIN_CLIENT_VERSION = "0.1.0";

export type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

export interface VaultInfo {
    salt: string; // base64
    kdf: KdfParams;
    wrappedMk: string; // base64, sealed with KEK
}

export interface PairRequest {
    code: string;
    name: string;
    platform: Platform;
    clientVersion: string;
}

export interface PairResponse {
    deviceId: string;
    token: string;
}

export type ChangeOp = "write" | "delete" | "restore";

export interface Change {
    seq: number;
    id: string; // file ID (HMAC of path)
    rev: number;
    op: ChangeOp;
    deleted: boolean;
    meta: string | null; // sealed FileMeta, null for deletions
    size: number;
    deviceId: string | null;
    at: number;
}

export interface ChangePage {
    changes: Change[];
    next: number; // cursor to pass as `since` next time
    head: number; // latest seq on the server
    more: boolean;
}

export interface WriteResponse {
    rev: number;
    seq: number;
}

export interface ConflictResponse {
    error: "conflict";
    rev: number; // current rev on the server
    deleted: boolean;
}

export type BatchOp =
    | { op: "put"; id: string; baseRev: number; meta: string; data: string /* base64 */ }
    | { op: "delete"; id: string; baseRev: number };

export interface BatchRequest {
    ops: BatchOp[];
}

export type BatchResponse = { ok: true; results: WriteResponse[] } | { ok: false; index: number; conflict: ConflictResponse };

export interface StatusReport {
    pending: number;
    seq: number;
    clientVersion: string;
}

export interface ConfigDoc {
    rev: number;
    blob: string | null; // sealed config JSON, null before the first save
}

export interface PassphraseReset {
    salt: string;
    kdf: KdfParams;
    loginKey: string;
    wrappedMk: string;
    totp?: string; // required while two-factor authentication is on
}

// Admin API

export interface PreloginResponse {
    initialised: boolean;
    salt?: string;
    kdf?: KdfParams;
    totp?: boolean; // whether login asks for an authenticator code
}

export interface SetupRequest {
    setupToken: string;
    salt: string;
    kdf: KdfParams;
    loginKey: string;
    wrappedMk: string;
    mkProof: string;
}

export interface SetupResponse {
    totpSecret: string; // base32
    otpauthUrl: string;
}

export interface SetupConfirm {
    setupToken: string;
    totp: string;
}

export interface LoginRequest {
    loginKey: string;
    totp?: string;
    recoveryCode?: string;
}

export interface LoginResponse {
    wrappedMk: string;
    recoveryCodesLeft: number;
}

export interface DeviceSummary {
    id: string;
    name: string;
    platform: Platform;
    clientVersion: string;
    createdAt: number;
    lastSeenAt: number | null;
    ackSeq: number;
    pending: number;
    revokedAt: number | null;
}

export interface Overview {
    head: number;
    files: number;
    deletedFiles: number;
    versions: number;
    storageBytes: number;
    devices: DeviceSummary[];
    recent: (Change & { deviceName: string | null })[];
}

export interface PairingCode {
    code: string;
    expiresAt: number;
}

export interface FileEntry {
    id: string;
    rev: number;
    deleted: boolean;
    meta: string | null; // sealed meta of the latest non-deleted version
    metaRev: number; // rev the meta blob belongs to (for AAD)
    size: number;
    updatedAt: number;
}

export interface VersionEntry {
    rev: number;
    seq: number;
    op: ChangeOp;
    deleted: boolean;
    meta: string | null;
    size: number;
    deviceId: string | null;
    deviceName: string | null;
    at: number;
    batchId: string | null;
}

// Changes per device per local calendar day, for the activity heatmap.
export interface ActivityDay {
    deviceId: string | null;
    day: number; // days since 1970-01-01 in the viewer's time zone
    n: number;
}

export interface ChangeEntry {
    seq: number;
    id: string;
    rev: number;
    op: ChangeOp;
    deleted: boolean;
    size: number;
    deviceId: string | null;
    deviceName: string | null;
    at: number;
}

export interface AuditEntry {
    at: number;
    actor: string;
    action: string;
    detail: string | null;
}
