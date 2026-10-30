// End-to-end encryption. See docs/design.md §3.
//
// passphrase + salt --PBKDF2--> root (64 B)
//   root --HKDF "login"--> login key (sent to the server, stored there only as SHA-256)
//   root --HKDF "kek"----> KEK --AES-GCM--> wraps the master key (MK)
// MK --HKDF--> content / meta / id / config keys

export type Bytes = Uint8Array<ArrayBuffer>;

export const FORMAT = 1;
export const DEFAULT_KDF: KdfParams = { alg: "PBKDF2-SHA256", iterations: 600_000 };

export interface KdfParams {
    alg: "PBKDF2-SHA256";
    iterations: number;
}

export interface VaultKeys {
    content: CryptoKey;
    meta: CryptoKey;
    id: CryptoKey;
    config: CryptoKey;
}

export interface PassphraseKeys {
    loginKey: string; // base64, 32 bytes
    kek: CryptoKey;
}

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (s: string): Bytes => te.encode(s) as Bytes;
export const fromUtf8 = (b: Uint8Array): string => td.decode(b);

export function randomBytes(n: number): Bytes {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}

export function fromB64(s: string): Bytes {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function toHex(b: Uint8Array): string {
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: Bytes): Promise<Bytes> {
    return new Uint8Array(await subtle.digest("SHA-256", data));
}

export async function sha256Hex(data: Bytes): Promise<string> {
    return toHex(await sha256(data));
}

async function hkdf(ikm: Bytes, info: string, bytes = 32): Promise<Bytes> {
    const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) },
        base,
        bytes * 8
    );
    return new Uint8Array(bits);
}

const aesKey = (raw: Bytes) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function derivePassphraseKeys(passphrase: string, salt: Bytes, kdf: KdfParams): Promise<PassphraseKeys> {
    if (kdf.alg !== "PBKDF2-SHA256") throw new Error(`Unsupported KDF: ${kdf.alg}`);
    const base = await subtle.importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
    const root = new Uint8Array(
        await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: kdf.iterations }, base, 512)
    );
    const [login, kek] = await Promise.all([hkdf(root, "lite-sync/v1/login"), hkdf(root, "lite-sync/v1/kek")]);
    return { loginKey: toB64(login), kek: await aesKey(kek) };
}

export async function deriveVaultKeys(mk: Bytes): Promise<VaultKeys> {
    if (mk.length !== 32) throw new Error("Invalid master key length");
    const [content, meta, id, config] = await Promise.all([
        hkdf(mk, "lite-sync/v1/content"),
        hkdf(mk, "lite-sync/v1/meta"),
        hkdf(mk, "lite-sync/v1/id"),
        hkdf(mk, "lite-sync/v1/config"),
    ]);
    return {
        content: await aesKey(content),
        meta: await aesKey(meta),
        id: await subtle.importKey("raw", id, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        config: await aesKey(config),
    };
}

// Layout: [format byte][12-byte IV][ciphertext + 16-byte GCM tag].
export async function seal(key: CryptoKey, data: Bytes, aad: string): Promise<Bytes> {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, data));
    const out = new Uint8Array(13 + ct.length);
    out[0] = FORMAT;
    out.set(iv, 1);
    out.set(ct, 13);
    return out;
}

export class DecryptError extends Error {}

export async function open(key: CryptoKey, blob: Bytes, aad: string): Promise<Bytes> {
    if (blob.length < 29) throw new DecryptError("Ciphertext too short");
    if (blob[0] !== FORMAT) throw new DecryptError(`Unsupported ciphertext format ${blob[0]}`);
    try {
        return new Uint8Array(
            await subtle.decrypt(
                { name: "AES-GCM", iv: blob.subarray(1, 13), additionalData: utf8(aad) },
                key,
                blob.subarray(13)
            )
        );
    } catch {
        throw new DecryptError("Decryption failed: wrong key or tampered data");
    }
}

export const aad = {
    mk: "lite-sync/v1|mk",
    content: (fileId: string, rev: number) => `lite-sync/v1|content|${fileId}|${rev}`,
    meta: (fileId: string, rev: number) => `lite-sync/v1|meta|${fileId}|${rev}`,
    config: (rev: number) => `lite-sync/v1|config|${rev}`,
};

export function newMasterKey(): Bytes {
    return randomBytes(32);
}

// Proves possession of the master key without revealing it. The server stores only its SHA-256, so a
// device can reset the passphrase only if it really holds the key (docs/design.md §3.5).
export async function masterKeyProof(mk: Bytes): Promise<string> {
    return toB64(await hkdf(mk, "lite-sync/v1/mk-proof"));
}

export async function wrapMasterKey(kek: CryptoKey, mk: Bytes): Promise<string> {
    return toB64(await seal(kek, mk, aad.mk));
}

export async function unwrapMasterKey(kek: CryptoKey, wrapped: string): Promise<Bytes> {
    return open(kek, fromB64(wrapped), aad.mk);
}

// Paths are compared NFC-normalised so macOS (NFD file names) and other platforms agree.
export async function fileId(keys: VaultKeys, path: string): Promise<string> {
    return toHex(new Uint8Array(await subtle.sign("HMAC", keys.id, utf8(path.normalize("NFC")))));
}

export interface FileMeta {
    path: string;
    mtime: number;
    size: number;
    hash: string; // SHA-256 hex of the plaintext
}

export async function sealMeta(keys: VaultKeys, id: string, rev: number, meta: FileMeta): Promise<string> {
    return toB64(await seal(keys.meta, utf8(JSON.stringify(meta)), aad.meta(id, rev)));
}

export async function openMeta(keys: VaultKeys, id: string, rev: number, blob: string): Promise<FileMeta> {
    return JSON.parse(fromUtf8(await open(keys.meta, fromB64(blob), aad.meta(id, rev)))) as FileMeta;
}

export const sealContent = (keys: VaultKeys, id: string, rev: number, data: Bytes) =>
    seal(keys.content, data, aad.content(id, rev));

export const openContent = (keys: VaultKeys, id: string, rev: number, blob: Bytes) =>
    open(keys.content, blob, aad.content(id, rev));
