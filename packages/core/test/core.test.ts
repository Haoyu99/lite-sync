import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    DecryptError,
    PathFilter,
    conflictPath,
    derivePassphraseKeys,
    deriveVaultKeys,
    fileId,
    fromUtf8,
    mergeJson,
    mergeText,
    newMasterKey,
    normaliseConfig,
    openContent,
    openMeta,
    randomBytes,
    sealContent,
    sealMeta,
    unwrapMasterKey,
    utf8,
    wrapMasterKey,
    windowsPathProblem,
    windowsFileName,
} from "../src/index.ts";

const FAST_KDF = { alg: "PBKDF2-SHA256", iterations: 1000 } as const;

describe("crypto", () => {
    it("unwraps the master key only with the right passphrase", async () => {
        const salt = randomBytes(16);
        const mk = newMasterKey();
        const good = await derivePassphraseKeys("河马-台灯-雨伞", salt, FAST_KDF);
        const wrapped = await wrapMasterKey(good.kek, mk);

        const again = await derivePassphraseKeys("河马-台灯-雨伞", salt, FAST_KDF);
        assert.equal(again.loginKey, good.loginKey);
        assert.deepEqual(await unwrapMasterKey(again.kek, wrapped), mk);

        const bad = await derivePassphraseKeys("wrong", salt, FAST_KDF);
        assert.notEqual(bad.loginKey, good.loginKey);
        await assert.rejects(unwrapMasterKey(bad.kek, wrapped), DecryptError);
    });

    it("gives different login keys for the same passphrase with a new salt", async () => {
        const a = await derivePassphraseKeys("same", randomBytes(16), FAST_KDF);
        const b = await derivePassphraseKeys("same", randomBytes(16), FAST_KDF);
        assert.notEqual(a.loginKey, b.loginKey);
    });

    it("binds ciphertext to its file ID and revision", async () => {
        const keys = await deriveVaultKeys(newMasterKey());
        const blob = await sealContent(keys, "aaa", 3, utf8("secret"));
        assert.equal(fromUtf8(await openContent(keys, "aaa", 3, blob)), "secret");
        await assert.rejects(openContent(keys, "bbb", 3, blob), DecryptError);
        await assert.rejects(openContent(keys, "aaa", 2, blob), DecryptError);

        const meta = { path: "a.md", mtime: 1, size: 6, hash: "h" };
        const sealed = await sealMeta(keys, "aaa", 3, meta);
        assert.deepEqual(await openMeta(keys, "aaa", 3, sealed), meta);
        await assert.rejects(openMeta(keys, "aaa", 4, sealed), DecryptError);
    });

    it("rejects data sealed with another vault's key", async () => {
        const a = await deriveVaultKeys(newMasterKey());
        const b = await deriveVaultKeys(newMasterKey());
        const blob = await sealContent(a, "x", 1, utf8("hi"));
        await assert.rejects(openContent(b, "x", 1, blob), DecryptError);
    });

    it("derives the same file ID for NFC and NFD paths", async () => {
        const keys = await deriveVaultKeys(newMasterKey());
        const nfc = "笔记/café.md".normalize("NFC");
        const nfd = "笔记/café.md".normalize("NFD");
        assert.notEqual(nfc, nfd);
        assert.equal(await fileId(keys, nfc), await fileId(keys, nfd));
        assert.match(await fileId(keys, nfc), /^[0-9a-f]{64}$/);
    });
});

describe("mergeText", () => {
    it("merges edits to different lines", () => {
        const base = "a\nb\nc\nd\n";
        const r = mergeText(base, "a\nB\nc\nd\n", "a\nb\nc\nD\n");
        assert.deepEqual(r, { ok: true, text: "a\nB\nc\nD\n" });
    });

    it("reports a conflict for edits to the same line", () => {
        assert.deepEqual(mergeText("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n"), { ok: false });
    });

    it("accepts identical edits on both sides", () => {
        assert.deepEqual(mergeText("a\nb\n", "a\nX\n", "a\nX\n"), { ok: true, text: "a\nX\n" });
    });

    it("takes the only side that changed", () => {
        assert.deepEqual(mergeText("a", "a", "b"), { ok: true, text: "b" });
        assert.deepEqual(mergeText("a", "b", "a"), { ok: true, text: "b" });
    });

    it("keeps CRLF line endings and a missing final newline", () => {
        const r = mergeText("a\r\nb\r\nc", "A\r\nb\r\nc", "a\r\nb\r\nC");
        assert.deepEqual(r, { ok: true, text: "A\r\nb\r\nC" });
    });

    it("merges an append with an edit near the top", () => {
        const r = mergeText("a\nb", "a\nb\nc", "x\nb");
        assert.deepEqual(r, { ok: true, text: "x\nb\nc" });
    });
});

describe("mergeJson", () => {
    it("merges different keys and keeps the remote indentation", () => {
        const base = '{\n  "a": 1,\n  "b": 1\n}\n';
        const r = mergeJson(base, '{\n  "a": 2,\n  "b": 1\n}\n', '{\n  "a": 1,\n  "b": 3\n}\n');
        assert.deepEqual(r, { ok: true, text: '{\n  "a": 2,\n  "b": 3\n}\n', conflicts: 0 });
    });

    it("counts a key changed differently on both sides", () => {
        const r = mergeJson('{"a":1}', '{"a":2}', '{"a":3}');
        assert.deepEqual(r, { ok: true, text: '{"a":3}', conflicts: 1 });
    });

    it("merges nested objects and key deletions", () => {
        const r = mergeJson('{"x":{"a":1,"b":1},"y":1}', '{"x":{"a":2,"b":1},"y":1}', '{"x":{"a":1}}');
        assert.ok(r.ok);
        assert.deepEqual(JSON.parse(r.text), { x: { a: 2 } });
        assert.equal(r.conflicts, 0);
    });

    it("fails on invalid JSON", () => {
        assert.deepEqual(mergeJson("{", "{}", "{}"), { ok: false });
    });
});

describe("PathFilter", () => {
    const f = new PathFilter(normaliseConfig({}).exclude);

    it("accepts notes and attachments", () => {
        assert.ok(f.accepts("1. 『📅 Daily』/2026-10-30.md"));
        assert.ok(f.accepts("raw/image.png"));
    });

    it("rejects the config folder, trash, system files, and unsafe paths", () => {
        for (const p of [".obsidian/app.json", ".obsidian/plugins/lite-sync/data.json", ".obsidian/plugins/calendar/data.json", ".trash/a.md", "a/.DS_Store", "~$doc.docx", "../x.md", "/abs.md", "a//b.md", ""])
            assert.equal(f.accepts(p), false, p);
    });

    it("applies user globs", () => {
        const g = new PathFilter(["private/**", "*.log", "**/draft-*.md", "/top.md", "  "]);
        assert.equal(g.accepts("private/a/b.md"), false);
        assert.equal(g.accepts("notes/private/b.md"), true, "a pattern with / starts at the vault root");
        assert.equal(g.accepts("x.log"), false);
        assert.equal(g.accepts("dir/sub/x.log"), false, "a pattern without / matches in any folder");
        assert.equal(g.accepts("top.md"), false);
        assert.equal(g.accepts("dir/top.md"), true);
        assert.equal(g.accepts("a/b/draft-1.md"), false);
        assert.equal(g.accepts("draft-1.md"), false);
    });
});

describe("conflictPath", () => {
    it("inserts the device and time before the extension", () => {
        const at = new Date(2026, 9, 30, 14, 2);
        assert.equal(conflictPath("a/笔记.md", "iPhone", at), "a/笔记 (冲突 iPhone 10-30 1402).md");
        assert.equal(conflictPath("a.b/README", "Mac/1", at), "a.b/README (冲突 Mac-1 10-30 1402)");
    });
});

describe("Windows paths", () => {
    it("adapts the reported arrow filename and reserved segments to valid local names", () => {
        assert.equal(windowsFileName("示例 文档 14-> 15.md"), "示例 文档 14-＞ 15.md");
        assert.equal(windowsFileName("CON.md"), "_CON.md");
        assert.equal(windowsFileName("folder. "), "folder．　");
        for (const name of ['a:b.md', 'a?b.md', 'a*b.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md', 'a\\b.md', 'a\x01b.md', 'CON.md', 'LPT1.txt', 'COM³.txt', 'folder.', 'space '])
            assert.equal(windowsPathProblem(windowsFileName(name)), null, name);
    });
    it("checks every path segment for forbidden characters, reserved names and suffixes", () => {
        for (const path of ['notes/a:b.md', 'a?b.md', 'a*b.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md', 'a\\b.md', 'a\x01b.md', 'CON.md', 'aux/data.md', 'LPT1.txt', 'COM³.txt', 'folder./a.md', 'space /a.md'])
            assert.ok(windowsPathProblem(path), path);
        for (const path of ['notes/笔记.md', 'CONtext.md', 'COM10.md', 'a.b/a.md', '笔记 (冲突 Windows 11-07 1200).md'])
            assert.equal(windowsPathProblem(path), null, path);
    });
});

describe("normaliseConfig", () => {
    it("fills defaults, drops unknown keys, and clamps values", () => {
        const c = normaliseConfig({ sync: { debounceMs: 1, massChangeGuard: "x" }, extra: true, exclude: [1] });
        assert.equal(c.sync.debounceMs, 500);
        assert.equal(c.sync.massChangeGuard, 20);
        assert.deepEqual(c.exclude, normaliseConfig(null).exclude);
        assert.equal("extra" in c, false);
        assert.equal(c.schema, 1);
    });
});
