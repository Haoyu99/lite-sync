import { parsePluginInventory, type PluginInventory } from "@lite-sync/core";

interface PluginFiles {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ folders: string[] }>;
    read(path: string): Promise<string>;
}

export async function collectPlugins(adapter: PluginFiles, configDir: string): Promise<PluginInventory> {
    const root = `${configDir}/plugins`;
    if (!(await adapter.exists(root))) return { plugins: [] };
    const enabledPath = `${configDir}/community-plugins.json`;
    const enabledData: unknown = await adapter.exists(enabledPath) ? JSON.parse(await adapter.read(enabledPath)) : [];
    if (!Array.isArray(enabledData) || !enabledData.every((id) => typeof id === "string")) throw new Error("无法读取已启用插件列表");
    const enabled = new Set(enabledData);
    const { folders } = await adapter.list(root);
    const plugins = [];
    for (const dir of folders) {
        if (dir.split("/").at(-1) === "lite-sync") continue;
        const path = `${dir}/manifest.json`;
        if (!(await adapter.exists(path))) continue;
        const m = JSON.parse(await adapter.read(path));
        plugins.push({ id: m.id, name: m.name, version: m.version, enabled: enabled.has(m.id) });
    }
    return parsePluginInventory({ plugins });
}
