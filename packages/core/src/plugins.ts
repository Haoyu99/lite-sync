// Only public manifest metadata is reported; plugin settings and code stay on the device.
export interface InstalledPlugin {
    id: string;
    name: string;
    version: string;
    enabled: boolean;
}
export interface PluginInventory {
    plugins: InstalledPlugin[];
}
export interface DevicePluginReport {
    deviceId: string;
    deviceName: string;
    updatedAt: number | null;
    blob: string | null;
}
export const pluginInventoryAad = (deviceId: string) => `lite-sync/v1|plugin-inventory|${deviceId}`;

export function parsePluginInventory(value: unknown): PluginInventory {
    const data = value as PluginInventory | null;
    if (!data || !Array.isArray(data.plugins) || data.plugins.length > 2000) throw new Error("插件清单格式无效");
    const plugins: InstalledPlugin[] = [];
    const seen = new Set<string>();
    for (const p of data.plugins) {
        if (!p || typeof p.id !== "string" || !p.id || p.id.length > 200 ||
            typeof p.name !== "string" || p.name.length > 200 ||
            typeof p.version !== "string" || p.version.length > 60 || typeof p.enabled !== "boolean")
            throw new Error("插件清单格式无效");
        if (p.id === "lite-sync" || seen.has(p.id)) continue;
        seen.add(p.id);
        plugins.push({ id: p.id, name: p.name, version: p.version, enabled: p.enabled });
    }
    return { plugins: plugins.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) };
}

// Each encrypted package is a complete set of standard Obsidian plugin files.
export const PLUGIN_FILES = ["manifest.json", "main.js", "styles.css", "data.json"] as const;
export const EXCLUDED_PLUGINS = new Set(["lite-sync", "obsidian-livesync"]);
export interface PluginBundle { id: string; files: Record<string, string> }
export interface PluginPackageHead { id: string; rev: number; updatedAt: number }
export interface PluginSyncCatalog {
    seedDevice: string | null;
    ready: boolean;
    packages: PluginPackageHead[];
}
export const pluginBundleAad = (id: string, rev: number) => `lite-sync/v1|plugin-package|${id}|${rev}`;
export function validPluginId(id: unknown): id is string {
    return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id) && !EXCLUDED_PLUGINS.has(id);
}
export function parsePluginBundle(value: unknown): PluginBundle {
    const bundle = value as PluginBundle | null;
    if (!bundle || !validPluginId(bundle.id) || !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files))
        throw new Error("插件包格式无效");
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(bundle.files)) {
        if (!(PLUGIN_FILES as readonly string[]).includes(name) || typeof content !== "string") throw new Error("插件包包含不允许的文件");
        files[name] = content;
    }
    if (!files["main.js"] || !files["manifest.json"]) throw new Error("插件包缺少代码或 manifest");
    const manifest = JSON.parse(files["manifest.json"]);
    if (manifest.id !== bundle.id || typeof manifest.version !== "string" || typeof manifest.name !== "string") throw new Error("插件 ID 与 manifest 不一致");
    if (files["data.json"] !== undefined) JSON.parse(files["data.json"]);
    return { id: bundle.id, files };
}
