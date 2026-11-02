<script lang="ts">
    import { onMount, untrack } from "svelte";
    import {
        type FileEntry,
        type VersionEntry,
        fileId,
        fromUtf8,
        openContent,
        openMeta,
        sealContent,
        sealMeta,
        sha256Hex,
    } from "@lite-sync/core";
    import { buildFileTree, type FileTree } from "../lib/file-tree";
    import Modal from "../lib/Modal.svelte";
    import { api, describe } from "../lib/api";
    import { type DiffRow, lineDiff } from "../lib/diff";
    import { bytes, downloadBlob, kindOf, splitPath, stamp } from "../lib/format";
    import { route } from "../lib/router.svelte";
    import { session } from "../lib/session.svelte";
    import { type DecryptedFile, decryptFiles } from "../lib/vault";

    type Version = VersionEntry & { path: string | null };

    let files = $state<DecryptedFile[]>([]);
    let query = $state("");
    let expanded = $state(new Set<string>());
    let showDeleted = $state(false);
    let error = $state("");
    let loading = $state(true);

    let selected = $state<DecryptedFile | null>(null);
    let versions = $state<Version[]>([]);
    let rev = $state<number | null>(null);
    let tab = $state<"content" | "diff">("content");
    let content = $state<Uint8Array | null>(null);
    let previous = $state<Uint8Array | null>(null);
    let imageUrl = $state("");
    let detailError = $state("");

    let restoreOpen = $state(false);
    let busy = $state(false);
    let notice = $state("");

    async function load() {
        try {
            const r = await api.get<{ files: FileEntry[] }>("/files");
            files = (await decryptFiles(session.keys!, r.files)).sort((a, b) => (a.path ?? "￿").localeCompare(b.path ?? "￿", "zh-CN"));
            error = "";
        } catch (e) {
            error = describe(e);
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        void load();
        return () => imageUrl && URL.revokeObjectURL(imageUrl);
    });

    const visible = $derived(
        files.filter((f) => (showDeleted || !f.entry.deleted) && (!query || (f.path ?? "").toLowerCase().includes(query.toLowerCase())))
    );
    const tree = $derived(buildFileTree(visible));
    function toggleFolder(path: string) {
        const next = new Set(expanded);
        if (next.has(path)) next.delete(path); else next.add(path);
        expanded = next;
    }
    $effect(() => {
        const parts = selected?.path?.split("/") ?? [];
        parts.pop();
        const next = new Set(untrack(() => expanded));
        let path = "";
        for (const part of parts) {
            path = path ? `${path}/${part}` : part;
            next.add(path);
        }
        // Only react to selection; expanding ancestors should not prevent manual collapse.
        if (parts.length) expanded = next;
    });
    const deletedCount = $derived(files.filter((f) => f.entry.deleted).length);
    const current = $derived(versions.find((v) => v.rev === rev) ?? null);
    const prev = $derived(current ? versions.find((v) => v.rev < current.rev && !v.deleted) ?? null : null);
    const kind = $derived(selected?.path ? kindOf(selected.path) : { kind: "binary" as const, mime: "" });
    const isLatest = $derived(!!current && !!selected && current.rev === selected.entry.rev);

    async function open(f: DecryptedFile) {
        selected = f;
        versions = [];
        rev = null;
        tab = "content";
        detailError = "";
        notice = "";
        try {
            const r = await api.get<{ versions: VersionEntry[] }>(`/files/${f.entry.id}/versions`);
            versions = await Promise.all(
                r.versions.map(async (v) => {
                    if (!v.meta) return { ...v, path: null };
                    try {
                        return { ...v, path: (await openMeta(session.keys!, f.entry.id, v.rev, v.meta)).path };
                    } catch {
                        return { ...v, path: null };
                    }
                })
            );
            const first = versions.find((v) => !v.deleted);
            if (first) await show(first.rev);
        } catch (e) {
            detailError = describe(e);
        }
    }

    async function read(id: string, r: number): Promise<Uint8Array> {
        const res = await api.raw(`/files/${id}/versions/${r}`);
        const keys = session.keys!;
        const meta = await openMeta(keys, id, r, res.meta);
        const data = await openContent(keys, id, r, res.data);
        if ((await sha256Hex(data)) !== meta.hash) throw new Error("内容校验失败：数据可能已损坏或被篡改。");
        return data;
    }

    async function show(r: number) {
        if (!selected) return;
        rev = r;
        content = previous = null;
        detailError = "";
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = "";
        try {
            content = await read(selected.entry.id, r);
            if (kind.kind === "image") imageUrl = URL.createObjectURL(new Blob([content as BlobPart], { type: kind.mime }));
            const p = versions.find((v) => v.rev < r && !v.deleted);
            if (kind.kind === "text" && p) previous = await read(selected.entry.id, p.rev);
        } catch (e) {
            detailError = describe(e);
        }
    }

    const text = $derived(content && kind.kind === "text" ? safeText(content) : null);
    const diff = $derived<DiffRow[] | null>(text !== null && previous ? lineDiff(safeText(previous) ?? "", text) : null);

    function safeText(b: Uint8Array): string | null {
        try {
            return fromUtf8(b);
        } catch {
            return null;
        }
    }

    // The ciphertext is bound to its revision, so a restore is encrypted here for the next revision.
    async function restore() {
        if (!selected?.path || !content || !current) return;
        busy = true;
        try {
            const keys = session.keys!;
            const id = selected.entry.id;
            if ((await fileId(keys, selected.path)) !== id) throw new Error("文件 ID 与路径不一致，已停止恢复。");
            const base = selected.entry.rev;
            const next = base + 1;
            const meta = await sealMeta(keys, id, next, { path: selected.path, mtime: Date.now(), size: content.byteLength, hash: await sha256Hex(content as Uint8Array<ArrayBuffer>) });
            await api.putFile(id, base, meta, await sealContent(keys, id, next, content as Uint8Array<ArrayBuffer>));
            restoreOpen = false;
            const restoredFrom = current.rev;
            const path = selected.path;
            await load();
            const f = files.find((x) => x.path === path);
            if (f) await open(f);
            notice = `已用第 ${restoredFrom} 版的内容生成第 ${next} 版。各设备会在几秒内收到。`;
        } catch (e) {
            detailError = describe(e);
            restoreOpen = false;
        } finally {
            busy = false;
        }
    }

    // #/files/<id> opens that file; the change log on the devices page links here.
    const routeId = $derived(/^\/files\/([0-9a-f]{64})$/.exec(route.path)?.[1] ?? null);
    $effect(() => {
        const id = routeId;
        if (!id || loading || selected?.entry.id === id) return;
        const f = files.find((x) => x.entry.id === id);
        if (!f) return;
        if (f.entry.deleted) showDeleted = true;
        void open(f);
    });

    const OP = { write: "写入", delete: "删除", restore: "恢复" } as const;
</script>

{#snippet folderContents(node: FileTree, depth: number)}
    {#each node.folders as folder (folder.path)}
        {@const isOpen = !!query.trim() || expanded.has(folder.path)}
        <button class="folder-item" style:padding-left={`${10 + depth * 14}px`} aria-expanded={isOpen} onclick={() => toggleFolder(folder.path)} title={folder.path}>
            <span aria-hidden="true">{isOpen ? "▾" : "▸"} 📁</span> {folder.name}
        </button>
        {#if isOpen}{@render folderContents(folder, depth + 1)}{/if}
    {/each}
    {#each node.files as f (f.entry.id)}
        <button class="file-item" style:padding-left={`${10 + depth * 14}px`} class:deleted={f.entry.deleted} aria-current={selected?.entry.id === f.entry.id} onclick={() => (location.hash = `#/files/${f.entry.id}`)} title={f.path ?? "无法解密"}>
            <span class="name">{f.path ? splitPath(f.path).name : "无法解密"}</span>
            <span class="dir">{bytes(f.entry.size)} · {stamp(f.entry.updatedAt)}</span>
        </button>
    {/each}
{/snippet}

<header class="page-head">
    <h1>文件</h1>
    <span class="faint" style="font-size: 13px">文件名和内容都在这个浏览器里解密</span>
</header>

{#if error}<p class="error">{error}</p>{/if}

<div class="files" class:has-selection={!!selected}>
    <section class="panel file-panel" aria-label="文件列表">
        <div class="file-tools">
            <input class="input" type="search" placeholder="搜索文件名" bind:value={query} aria-label="搜索文件名" />
            <label class="check" style="font-size: 13px">
                <input type="checkbox" bind:checked={showDeleted} />
                <span>显示已删除的文件{deletedCount ? `（${deletedCount}）` : ""}</span>
            </label>
        </div>
        <div class="row" style="padding: 8px 12px; justify-content: space-between">
            <span class="faint" style="font-size: 12px">{visible.length} 个文件</span>
            <button class="btn btn-quiet btn-sm" onclick={() => { expanded = new Set(); query = ""; }}>折叠全部</button>
        </div>
        <div class="file-list">
            {#if loading}
                <p class="empty">正在解密文件列表…</p>
            {:else if visible.length === 0}
                <p class="empty">{files.length === 0 ? "服务器上还没有文件。配对第一台设备后会出现在这里。" : "没有匹配的文件。"}</p>
            {:else}
                {@render folderContents(tree, 0)}
            {/if}
        </div>
    </section>

    <section class="detail" aria-label="文件详情">
        {#if selected}
            <button class="btn btn-quiet btn-sm back" style="justify-self: start" onclick={() => ((selected = null), (location.hash = "#/files"))}>← 返回列表</button>
            <div class="stack" style="gap: 4px">
                <h2 class="detail-title">{selected.path ? splitPath(selected.path).name : "无法解密"}</h2>
                <p class="faint" style="font-size: 13px">
                    {selected.path ? splitPath(selected.path).dir || "/" : ""}
                    {#if selected.entry.deleted}<span class="chip chip-bad" style="margin-left: 6px">已删除</span>{/if}
                </p>
            </div>

            {#if notice}<p class="notice">{notice}</p>{/if}

            <div class="versions" role="tablist" aria-label="历史版本">
                {#each versions as v (v.rev)}
                    <button class="version" role="tab" aria-selected={v.rev === rev} aria-current={v.rev === rev} disabled={v.deleted} onclick={() => show(v.rev)}>
                        <b>第 {v.rev} 版{v.rev === selected.entry.rev ? " · 当前" : ""}</b>
                        <span>{stamp(v.at)}</span>
                        <span class:op-delete={v.deleted} class:op-restore={v.op === "restore"}>{OP[v.op]} · {v.deviceName ?? "后台"}</span>
                    </button>
                {/each}
            </div>

            {#if detailError}<p class="error">{detailError}</p>{/if}

            {#if current && content}
                <div class="row" style="justify-content: space-between">
                    <div class="row">
                        {#if kind.kind === "text"}
                            <button class="btn btn-sm" class:btn-primary={tab === "content"} onclick={() => (tab = "content")}>内容</button>
                            <button class="btn btn-sm" class:btn-primary={tab === "diff"} disabled={!prev} onclick={() => (tab = "diff")}>
                                {prev ? `与第 ${prev.rev} 版对比` : "没有更早的版本"}
                            </button>
                        {/if}
                    </div>
                    <div class="row">
                        <button class="btn btn-sm" onclick={() => downloadBlob(content!, splitPath(selected!.path ?? "file").name, kind.mime)}>下载</button>
                        {#if !isLatest || selected.entry.deleted}
                            <button class="btn btn-sm btn-primary" onclick={() => (restoreOpen = true)}>恢复这个版本</button>
                        {/if}
                    </div>
                </div>

                <div class="panel preview">
                    {#if kind.kind === "image" && imageUrl}
                        <img src={imageUrl} alt={selected.path ?? ""} />
                    {:else if text !== null && tab === "diff" && diff}
                        <div class="diff">
                            {#each diff as d, i (i)}
                                <div class={d.t}><span>{d.a ?? ""}</span><span>{d.b ?? ""}</span>{d.t === "add" ? "+ " : d.t === "del" ? "- " : d.t === "gap" ? "" : "  "}{d.text}</div>
                            {/each}
                        </div>
                    {:else if text !== null}
                        <pre>{text || "（空文件）"}</pre>
                    {:else}
                        <p class="empty">这个文件无法预览（{bytes(content.byteLength)}）。可以下载查看。</p>
                    {/if}
                </div>
            {:else if !detailError && versions.length && !content}
                <p class="faint">正在解密…</p>
            {/if}
        {:else}
            <div class="panel empty"><p>选择左侧的文件，查看内容和全部历史版本。</p></div>
        {/if}
    </section>
</div>

<Modal bind:open={restoreOpen} title="恢复第 {current?.rev ?? ''} 版">
    <p>会用这一版的内容生成一个新版本。当前版本仍保留在历史里，恢复本身也可以再撤销。</p>
    <p>如果某台设备上正好有未上传的修改，它会和恢复的内容合并，合并不了时另存为冲突副本，不会丢失。</p>
    {#snippet actions()}
        <button class="btn" onclick={() => (restoreOpen = false)}>取消</button>
        <button class="btn btn-primary" disabled={busy} onclick={restore}>恢复</button>
    {/snippet}
</Modal>
