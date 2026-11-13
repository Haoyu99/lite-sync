import { sha256Hex, utf8, windowsFileName, type Bytes } from "@lite-sync/core";
import type { LocalFile, VaultAdapter } from "./engine.ts";

const normal = (path: string) => path.normalize("NFC");
const physicalKey = (path: string) => normal(path).toLowerCase();

// The engine continues to use canonical paths for encryption, indexing and change events.
// Local aliases are committed before creating files so a restart cannot upload them as new notes.
export class WindowsVault implements VaultAdapter {
    private disk: VaultAdapter;
    private paths: () => Record<string, string>;
    private save: () => Promise<void>;
    private log: (message: string) => void;
    private revision = 0;
    private durableRevision = 0;
    constructor(disk: VaultAdapter, paths: () => Record<string, string>, save: () => Promise<void>, log: (message: string) => void) {
        this.disk = disk; this.paths = paths; this.save = save; this.log = log;
    }

    toLocal(path: string): string {
        const p = normal(path);
        let result = p, length = -1;
        for (const [remote, local] of Object.entries(this.paths())) {
            if ((p === remote || p.startsWith(remote + "/")) && remote.length > length) {
                result = local + p.slice(remote.length);
                length = remote.length;
            }
        }
        return result;
    }

    toRemote(path: string): string {
        const p = normal(path), folded = physicalKey(p);
        let result = p, length = -1;
        for (const [remote, local] of Object.entries(this.paths())) {
            const key = physicalKey(local);
            if ((folded === key || folded.startsWith(key + "/")) && local.length > length) {
                result = remote + p.slice(local.length);
                length = local.length;
            }
        }
        return result;
    }

    moved(oldPath: string, newPath: string) {
        const old = normal(oldPath), target = normal(newPath);
        const remoteOld = this.toRemote(old), remoteNew = this.toRemote(target);
        for (const [remote, local] of Object.entries(this.paths())) {
            if (physicalKey(local) === physicalKey(old) || physicalKey(local).startsWith(physicalKey(old) + "/")) {
                this.remember(remoteNew + remote.slice(remoteOld.length), target + local.slice(old.length));
            }
        }
    }

    private remember(remote: string, local: string) {
        Object.defineProperty(this.paths(), remote, { value: local, writable: true, enumerable: true, configurable: true });
        this.revision++;
    }

    private async prepare(path: string): Promise<string> {
        const parts = normal(path).split("/");
        let physical = "", changed = false;
        for (let i = 0; i < parts.length; i++) {
            const remote = parts.slice(0, i + 1).join("/");
            const known = Object.hasOwn(this.paths(), remote) ? this.paths()[remote] : undefined;
            if (known !== undefined) { physical = known; continue; }
            const parent = physical;
            const name = windowsFileName(parts[i]!);
            let candidate = parent ? `${parent}/${name}` : name;
            const occupied = async (value: string) => {
                const owner = Object.entries(this.paths()).find(([r, local]) => r !== remote && physicalKey(local) === physicalKey(value));
                return !!owner || (await this.disk.exists(value)) && this.toRemote(value) !== remote;
            };
            if (await occupied(candidate)) {
                const suffix = (await sha256Hex(utf8(remote))).slice(0, 10);
                const dot = i === parts.length - 1 ? name.lastIndexOf(".") : -1;
                const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
                let n = 1;
                do {
                    const leaf = `${stem} (lite-sync-${suffix}${n > 1 ? `-${n}` : ""})${ext}`;
                    candidate = parent ? `${parent}/${leaf}` : leaf;
                    n++;
                } while (await occupied(candidate));
            }
            this.remember(remote, candidate);
            physical = candidate;
            changed = true;
        }
        if (this.revision !== this.durableRevision) {
            const revision = this.revision;
            await this.save();
            this.durableRevision = revision;
        }
        if (changed && physical !== normal(path)) this.log(`Windows 本地文件名适配: ${path} → ${physical}；云端路径保持不变`);
        return physical;
    }

    async list(): Promise<LocalFile[]> {
        return (await this.disk.list()).map((f) => ({ ...f, path: this.toRemote(f.path) }));
    }
    async exists(path: string) { return this.disk.exists(await this.prepare(path)); }
    async stat(path: string): Promise<LocalFile | null> {
        const file = await this.disk.stat(await this.prepare(path));
        return file ? { ...file, path: normal(path) } : null;
    }
    async read(path: string) { return this.disk.read(await this.prepare(path)); }
    async write(path: string, data: Bytes, mtime?: number): Promise<LocalFile> {
        const file = await this.disk.write(await this.prepare(path), data, mtime);
        return { ...file, path: normal(path) };
    }
    async trash(path: string) { await this.disk.trash(await this.prepare(path)); }
}
