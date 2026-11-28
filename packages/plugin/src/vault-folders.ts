import type { DataAdapter, TFolder } from "obsidian";

interface FolderVault {
    adapter: Pick<DataAdapter, "rmdir">;
    getFolderByPath(path: string): Pick<TFolder, "path" | "children" | "isRoot"> | null;
}

export async function removeEmptyVaultFolder(vault: FolderVault, path: string, configDir: string): Promise<boolean> {
    if (!path || path === "/" || path === "." || path === configDir || path.startsWith(`${configDir}/`)) return false;
    const folder = vault.getFolderByPath(path);
    if (!folder || folder.isRoot() || folder.children.length > 0) return false;

    try {
        // Refuse non-empty directories at deletion time, even if Obsidian's tree is stale.
        await vault.adapter.rmdir(folder.path, false);
        return true;
    } catch {
        return false;
    }
}
