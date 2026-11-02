import assert from "node:assert/strict";
import { it } from "node:test";
import { buildFileTree } from "../src/lib/file-tree.ts";
import type { DecryptedFile } from "../src/lib/vault.ts";

it("groups nested files and keeps root, deleted and unreadable entries addressable", () => {
    const file = (path: string | null, id: string, deleted = false) => ({ path, entry: { id, deleted } }) as DecryptedFile;
    const tree = buildFileTree([
        file("notes/sub/b.md", "b"), file("root.md", "root"),
        file("notes/a.md", "a", true), file(null, "bad"), file("attachments/img.png", "img"),
    ]);
    assert.deepEqual(tree.folders.map((f) => f.name), ["attachments", "notes"]);
    assert.deepEqual(tree.files.map((f) => f.entry.id), ["bad", "root"]);
    const notes = tree.folders[1]!;
    assert.equal(notes.files[0]!.entry.deleted, true);
    assert.equal(notes.folders[0]!.path, "notes/sub");
    assert.equal(notes.folders[0]!.files[0]!.entry.id, "b");
    assert.equal(buildFileTree([]).files.length, 0);
});
