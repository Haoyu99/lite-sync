// Ciphertext objects on disk, named by the SHA-256 of their bytes: objects/ab/abcdef…
// Writes go to a temporary file which is fsynced and renamed, so a crash never leaves a partial object.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export class ObjectStore {
    private root: string;

    constructor(dataDir: string) {
        this.root = join(dataDir, "objects");
        mkdirSync(join(this.root, "tmp"), { recursive: true });
    }

    private pathOf(key: string): string {
        if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid object key");
        return join(this.root, key.slice(0, 2), key);
    }

    putSync(data: Uint8Array): string {
        const key = createHash("sha256").update(data).digest("hex");
        const target = this.pathOf(key);
        if (existsSync(target)) return key;
        mkdirSync(join(this.root, key.slice(0, 2)), { recursive: true });
        const tmp = join(this.root, "tmp", `${key}.${randomBytes(6).toString("hex")}`);
        const fd = openSync(tmp, "wx");
        try {
            writeSync(fd, data);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(tmp, target);
        return key;
    }

    getSync(key: string): Buffer {
        return readFileSync(this.pathOf(key));
    }
}
