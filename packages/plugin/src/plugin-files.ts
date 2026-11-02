import { type PluginBundle, PLUGIN_FILES, parsePluginBundle, validPluginId } from "@lite-sync/core";
import type { PluginHost } from "./plugin-sync.ts";
import { bundleHash } from "./plugin-sync.ts";

export interface PluginDisk {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
export interface PluginRuntime {
    loaded(id: string): boolean;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
}
type Journal = { id: string; before: Record<string, string | null> };

// Known files only: never copies enablement, hotkeys, tokens, or arbitrary paths from a bundle.
export class PluginFiles implements PluginHost {
    private disk: PluginDisk;
    private configDir: string;
    private runtime: PluginRuntime;
    private backupCounter = 0;
    constructor(disk: PluginDisk, configDir: string, runtime: PluginRuntime) {
        this.disk = disk; this.configDir = configDir; this.runtime = runtime;
    }
    private root(id: string) {
        if (!validPluginId(id)) throw new Error("不允许操作这个插件目录");
        return `${this.configDir}/plugins/${id}`;
    }
    private async mkdir(path: string) {
        let current = "";
        for (const part of path.split("/")) {
            if (!part || part === "." || part === "..") throw new Error("插件路径无效");
            current = current ? `${current}/${part}` : part;
            if (!(await this.disk.exists(current))) await this.disk.mkdir(current);
        }
    }
    private async read(id: string): Promise<PluginBundle | null> {
        const root = this.root(id);
        if (!(await this.disk.exists(`${root}/manifest.json`))) return null;
        const files: Record<string, string> = {};
        for (const name of PLUGIN_FILES) if (await this.disk.exists(`${root}/${name}`)) files[name] = await this.disk.read(`${root}/${name}`);
        return parsePluginBundle({ id, files });
    }
    async list(exclude: readonly string[] = []): Promise<PluginBundle[]> {
        const root = `${this.configDir}/plugins`;
        if (!(await this.disk.exists(root))) return [];
        const result: PluginBundle[] = [];
        for (const folder of (await this.disk.list(root)).folders) {
            const id = folder.split("/").at(-1)!;
            if (!validPluginId(id) || exclude.includes(id)) continue;
            const bundle = await this.read(id);
            if (bundle) result.push(bundle);
        }
        return result;
    }
    async backup(bundle: PluginBundle): Promise<void> {
        const dir = `${this.configDir}/lite-sync-backups/${bundle.id}`;
        this.root(bundle.id);
        await this.mkdir(dir);
        await this.disk.write(`${dir}/${Date.now()}-${this.backupCounter++}.json`, JSON.stringify(bundle));
    }
    private journalPath(id: string) { this.root(id); return `${this.configDir}/lite-sync-staging/${id}.json`; }
    private async restore(j: Journal) {
        const root = this.root(j.id);
        await this.mkdir(root);
        for (const name of PLUGIN_FILES) {
            const text = j.before[name];
            if (typeof text === "string") await this.disk.write(`${root}/${name}`, text);
            else if (text === null && await this.disk.exists(`${root}/${name}`)) await this.disk.remove(`${root}/${name}`);
            else if (text !== null) throw new Error("插件恢复记录格式无效");
        }
    }
    async recover(): Promise<void> {
        const dir = `${this.configDir}/lite-sync-staging`;
        if (!(await this.disk.exists(dir))) return;
        for (const path of (await this.disk.list(dir)).files) {
            if (!path.endsWith(".json")) continue;
            const journal = JSON.parse(await this.disk.read(path)) as Journal;
            if (!validPluginId(journal.id) || path !== this.journalPath(journal.id) || !journal.before) throw new Error("插件恢复记录无效");
            const loaded = this.runtime.loaded(journal.id);
            if (loaded) await this.runtime.pause(journal.id);
            await this.restore(journal);
            await this.disk.remove(path);
            if (loaded) await this.runtime.resume(journal.id);
        }
    }
    async apply(value: PluginBundle, expected: PluginBundle | null): Promise<void> {
        const bundle = parsePluginBundle(value);
        const root = this.root(bundle.id);
        const loaded = this.runtime.loaded(bundle.id);
        if (loaded) await this.runtime.pause(bundle.id);
        let canResume = true;
        try {
            // Unload handlers may save settings. Preserve those edits and retry on the next scan.
            const current = await this.read(bundle.id);
            if ((current ? await bundleHash(current) : null) !== (expected ? await bundleHash(expected) : null))
                throw new Error(`插件 ${bundle.id} 在同步期间有新修改，稍后重试`);
            if (current) await this.backup(current);
            await this.mkdir(`${this.configDir}/lite-sync-staging`);
            const journal: Journal = { id: bundle.id, before: Object.fromEntries(PLUGIN_FILES.map((f) => [f, current?.files[f] ?? null])) };
            const journalPath = this.journalPath(bundle.id);
            await this.disk.write(journalPath, JSON.stringify(journal));
            try {
                await this.mkdir(root);
                for (const name of PLUGIN_FILES) {
                    const path = `${root}/${name}`;
                    const text = bundle.files[name];
                    if (text !== undefined) await this.disk.write(path, text);
                    else if (await this.disk.exists(path)) await this.disk.remove(path);
                }
                await this.disk.remove(journalPath);
            } catch (error) {
                try { await this.restore(journal); await this.disk.remove(journalPath); }
                catch { canResume = false; throw new Error(`插件 ${bundle.id} 写入中断，已保留恢复记录；请重启后重试`); }
                throw error;
            }
        } finally {
            if (loaded && canResume) await this.runtime.resume(bundle.id);
        }
    }
}
