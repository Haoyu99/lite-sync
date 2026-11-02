import type { DecryptedFile } from "./vault";
export interface FileTree {
    path: string;
    name: string;
    folders: FileTree[];
    files: DecryptedFile[];
}
export function buildFileTree(files: DecryptedFile[]): FileTree {
    const root: FileTree = { path: "", name: "", folders: [], files: [] };
    const folders = new Map<string, FileTree>([["", root]]);
    for (const file of files) {
        const parts = file.path?.split("/") ?? [];
        parts.pop();
        let node = root;
        for (const name of parts) {
            const path = node.path ? `${node.path}/${name}` : name;
            let child = folders.get(path);
            if (!child) {
                child = { path, name, folders: [], files: [] };
                folders.set(path, child);
                node.folders.push(child);
            }
            node = child;
        }
        node.files.push(file);
    }
    for (const node of folders.values()) {
        node.folders.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
        node.files.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "", "zh-CN", { numeric: true }));
    }
    return root;
}
