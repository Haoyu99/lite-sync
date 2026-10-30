// Server-side secrets: TOTP (RFC 6238), recovery codes, tokens, and sealing with the server key.
// See docs/design.md §5.3. Uses node:crypto only.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

// Pairing codes avoid look-alike characters: no 0/O, 1/I/L.
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomFrom(alphabet: string, n: number): string {
    let out = "";
    while (out.length < n) {
        for (const b of randomBytes(n * 2)) {
            // Rejection sampling keeps the distribution uniform.
            if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
            if (out.length === n) break;
        }
    }
    return out;
}

export function newPairingCode(): string {
    const s = randomFrom(PAIR_ALPHABET, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const normaliseCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function newRecoveryCodes(n = 10): string[] {
    return Array.from({ length: n }, () => {
        const s = randomFrom("abcdefghjkmnpqrstuvwxyz23456789", 10);
        return `${s.slice(0, 5)}-${s.slice(5)}`;
    });
}

// --- Sealing with LITE_SYNC_SERVER_KEY -------------------------------------------------------

export class ServerKey {
    private key: Buffer;

    constructor(secret: string) {
        if (secret.length < 32) throw new Error("LITE_SYNC_SERVER_KEY must be at least 32 characters");
        this.key = createHash("sha256").update(`lite-sync/server-key|${secret}`).digest();
    }

    seal(plain: string, purpose: string): string {
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", this.key, iv);
        c.setAAD(Buffer.from(purpose));
        const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    }

    open(sealed: string, purpose: string): string {
        const b = Buffer.from(sealed, "base64");
        const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
        d.setAAD(Buffer.from(purpose));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    }
}

// --- TOTP ------------------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(s: string): Buffer {
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export const TOTP_PERIOD = 30;

export function totpAt(secretB32: string, step: number): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const h = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
    const off = h[h.length - 1]! & 0x0f;
    const n = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
    return String(n).padStart(6, "0");
}

export const currentStep = (now = Date.now()): number => Math.floor(now / 1000 / TOTP_PERIOD);

// Returns the matching time step, or null. Accepts one step of clock drift either way and refuses
// any step at or before `lastStep`, so a code cannot be replayed.
export function verifyTotp(secretB32: string, code: string, lastStep: number, now = Date.now()): number | null {
    const c = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(c)) return null;
    const step = currentStep(now);
    for (const s of [step - 1, step, step + 1]) {
        if (s <= lastStep) continue;
        if (safeEqual(totpAt(secretB32, s), c)) return s;
    }
    return null;
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function otpauthUrl(secretB32: string, label = "lite-sync"): string {
    return `otpauth://totp/${encodeURIComponent(label)}?secret=${secretB32}&issuer=lite-sync&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}
