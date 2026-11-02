import { type Bytes, fromB64, open, randomBytes, seal, toB64 } from "@lite-sync/core";

// The passphrase is never stored. The per-origin wrapping key is non-extractable and held in IDB.
export interface UnlockRecord {
    key: CryptoKey;
    blob: string;
    wrappedMk: string;
    sessionTag: string;
    expiresAt: number;
}
export const UNLOCK_TTL_MS = 7 * 24 * 60 * 60_000;
const purpose = (tag: string, expiresAt: number) => `lite-sync/browser-unlock/v1|${tag}|${expiresAt}`;
export async function makeUnlockRecord(mk: Bytes, wrappedMk: string, sessionTag: string, expiresAt: number, now = Date.now()): Promise<UnlockRecord> {
    if (!Number.isFinite(expiresAt) || expiresAt <= now || !sessionTag) throw new Error("登录会话无法保存");
    const expiry = Math.min(expiresAt, now + UNLOCK_TTL_MS);
    const key = await crypto.subtle.importKey("raw", randomBytes(32), "AES-GCM", false, ["encrypt", "decrypt"]);
    const blob = toB64(await seal(key, mk, purpose(sessionTag, expiry)));
    return { key, blob, wrappedMk, sessionTag, expiresAt: expiry };
}
export async function readUnlockRecord(record: UnlockRecord, wrappedMk: string, sessionTag: string, now = Date.now()): Promise<Bytes | null> {
    if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now || record.expiresAt > now + UNLOCK_TTL_MS || record.wrappedMk !== wrappedMk || record.sessionTag !== sessionTag || record.key.extractable) return null;
    const mk = await open(record.key, fromB64(record.blob), purpose(record.sessionTag, record.expiresAt));
    return mk.length === 32 ? mk : null;
}
async function db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("lite-sync-browser", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("unlock");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function stored<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await db();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = database.transaction("unlock", mode);
            const request = action(tx.objectStore("unlock"));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally { database.close(); }
}
export const clearRememberedUnlock = () => stored("readwrite", (s) => s.delete("current"));
export async function rememberUnlock(mk: Bytes, wrapped: string, tag: string, expiresAt: number) {
    const record = await makeUnlockRecord(mk, wrapped, tag, expiresAt);
    await stored("readwrite", (s) => s.put(record, "current"));
}
export async function restoreUnlock(wrapped: string, tag: string): Promise<Bytes | null> {
    try {
        const record = await stored<UnlockRecord | undefined>("readonly", (s) => s.get("current"));
        const mk = record ? await readUnlockRecord(record, wrapped, tag) : null;
        if (!mk) await clearRememberedUnlock();
        return mk;
    } catch { await clearRememberedUnlock().catch(() => {}); return null; }
}
