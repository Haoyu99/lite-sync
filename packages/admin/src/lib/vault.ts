import { type FileEntry, type VaultKeys, openMeta } from "@lite-sync/core";

export type DecryptedFile = { entry: FileEntry; path: string | null };

// A file ID is the HMAC of its path, so one ID always names the same path.
export async function decryptFiles(keys: VaultKeys, entries: FileEntry[]): Promise<DecryptedFile[]> {
    return Promise.all(
        entries.map(async (entry) => {
            try {
                return { entry, path: (await openMeta(keys, entry.id, entry.metaRev, entry.meta ?? "")).path };
            } catch {
                return { entry, path: null };
            }
        })
    );
}

export function pathMap(files: DecryptedFile[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const f of files) if (f.path) m.set(f.entry.id, f.path);
    return m;
}
