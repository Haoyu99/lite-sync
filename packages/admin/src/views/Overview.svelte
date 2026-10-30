<script lang="ts">
    import { onMount } from "svelte";
    import { type DeviceSummary, type FileEntry, type Overview, type PairingCode, openMeta } from "@lite-sync/core";
    import Modal from "../lib/Modal.svelte";
    import { api, describe } from "../lib/api";
    import { PLATFORM, ago, bytes, splitPath, stamp } from "../lib/format";
    import { session } from "../lib/session.svelte";
    import { decryptFiles, pathMap } from "../lib/vault";

    const CELLS = 48;
    const STALE_MS = 7 * 86_400_000;

    let data = $state<Overview | null>(null);
    let paths = $state<Map<string, string>>(new Map());
    let recentPaths = $state<(string | null)[]>([]);
    let error = $state("");
    let now = $state(Date.now());

    let pairOpen = $state(false);
    let pair = $state<PairingCode | null>(null);
    let pairError = $state("");

    let revokeTarget = $state<DeviceSummary | null>(null);
    let revokeOpen = $state(false);
    let renameTarget = $state<DeviceSummary | null>(null);
    let renameOpen = $state(false);
    let renameValue = $state("");
    let busy = $state(false);

    async function load() {
        try {
            const [o, f] = await Promise.all([api.get<Overview>("/overview"), api.get<{ files: FileEntry[] }>("/files")]);
            const keys = session.keys!;
            paths = pathMap(await decryptFiles(keys, f.files));
            recentPaths = await Promise.all(
                o.recent.map(async (c) => {
                    if (c.meta) {
                        try {
                            return (await openMeta(keys, c.id, c.rev, c.meta)).path;
                        } catch {
                            return null;
                        }
                    }
                    return paths.get(c.id) ?? null;
                })
            );
            data = o;
            error = "";
        } catch (e) {
            error = describe(e);
        }
    }

    onMount(() => {
        void load();
        const t = setInterval(() => {
            now = Date.now();
            if (!pairOpen && !revokeOpen && !renameOpen) void load();
        }, 15_000);
        const tick = setInterval(() => (now = Date.now()), 1000);
        return () => {
            clearInterval(t);
            clearInterval(tick);
        };
    });

    const seqs = $derived(data ? Array.from({ length: Math.min(CELLS, data.head) }, (_, i) => data!.head - Math.min(CELLS, data!.head) + 1 + i) : []);
    const active = $derived(data?.devices.filter((d) => !d.revokedAt) ?? []);
    const revoked = $derived(data?.devices.filter((d) => d.revokedAt) ?? []);

    function deviceState(d: DeviceSummary) {
        if (d.revokedAt) return { cls: "chip-bad", text: "已吊销" };
        if (d.pending > 0) return { cls: "chip-warn", text: `↑ ${d.pending} 待上传` };
        const behind = (data?.head ?? 0) - d.ackSeq;
        if (behind > 0) return { cls: "chip-warn", text: `落后 ${behind} 次修改` };
        if (d.lastSeenAt === null) return { cls: "chip-plain", text: "未连接" };
        return { cls: "chip-ok", text: "已同步" };
    }

    async function newCode() {
        pairOpen = true;
        pair = null;
        pairError = "";
        try {
            pair = await api.post<PairingCode>("/pairing-codes");
        } catch (e) {
            pairError = describe(e);
        }
    }

    const left = $derived(pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0);

    async function revoke() {
        if (!revokeTarget) return;
        busy = true;
        try {
            await api.post(`/devices/${revokeTarget.id}/revoke`);
            revokeOpen = false;
            await load();
        } catch (e) {
            error = describe(e);
        } finally {
            busy = false;
        }
    }

    async function rename(e: SubmitEvent) {
        e.preventDefault();
        if (!renameTarget || !renameValue.trim()) return;
        busy = true;
        try {
            await api.patch(`/devices/${renameTarget.id}`, { name: renameValue.trim() });
            renameOpen = false;
            await load();
        } catch (err) {
            error = describe(err);
        } finally {
            busy = false;
        }
    }

    const OP = { write: "写入", delete: "删除", restore: "恢复" } as const;
</script>

<header class="page-head">
    <h1>设备</h1>
    <button class="btn btn-primary" onclick={newCode}>添加设备</button>
</header>

{#if error}<p class="error">{error}</p>{/if}

{#if data}
    <section class="head" aria-label="服务器状态">
        <div>
            <div class="head-seq">{data.head.toLocaleString()}</div>
            <p class="head-label">服务器已记录的修改次数</p>
        </div>
        <div class="facts">
            <span><b>{data.files.toLocaleString()}</b>个文件</span>
            <span><b>{data.versions.toLocaleString()}</b>个历史版本</span>
            <span><b>{bytes(data.storageBytes)}</b>密文</span>
            {#if data.deletedFiles}<span><b>{data.deletedFiles}</b>个已删除，可恢复</span>{/if}
        </div>
    </section>

    <section class="panel" aria-labelledby="devices-title">
        <div class="panel-head">
            <h2 id="devices-title">已配对的设备</h2>
            <span class="faint" style="font-size: 12px">每一格是服务器上的一次修改，实心表示该设备已收到</span>
        </div>
        {#if active.length === 0}
            <div class="empty">
                <p>还没有设备。点「添加设备」获得配对码，在 Obsidian 的 lite-sync 设置里填入。</p>
                <button class="btn btn-primary" onclick={newCode}>添加设备</button>
            </div>
        {:else}
            <div class="ledger">
                {#each [...active, ...revoked] as d (d.id)}
                    {@const s = deviceState(d)}
                    <div class="device" class:revoked={!!d.revokedAt} class:stale={!d.revokedAt && d.lastSeenAt !== null && now - d.lastSeenAt > STALE_MS}>
                        <div>
                            <div class="device-name">{d.name}</div>
                            <div class="device-sub">{PLATFORM[d.platform]} · v{d.clientVersion} · {ago(d.lastSeenAt, now)}</div>
                        </div>
                        <div class="track">
                            {#if seqs.length}
                                <div class="cells" style="--n: {seqs.length}" aria-label="已收到 {Math.min(d.ackSeq, data.head)} / {data.head}">
                                    {#each seqs as q, i (q)}
                                        <span class="cell" class:on={d.ackSeq >= q} style="--i: {i}"></span>
                                    {/each}
                                </div>
                                <div class="cells-caption mono">
                                    <span>#{seqs[0]}</span>
                                    <span>#{data.head}</span>
                                </div>
                            {:else}
                                <span class="faint" style="font-size: 13px">服务器上还没有修改</span>
                            {/if}
                        </div>
                        <div class="device-actions">
                            <span class="chip {s.cls}">{s.text}</span>
                            {#if !d.revokedAt}
                                <button class="btn btn-quiet btn-sm" onclick={() => ((renameTarget = d), (renameValue = d.name), (renameOpen = true))}>改名</button>
                                <button class="btn btn-quiet btn-sm btn-danger" onclick={() => ((revokeTarget = d), (revokeOpen = true))}>吊销</button>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </section>

    <section class="panel" aria-labelledby="recent-title">
        <div class="panel-head">
            <h2 id="recent-title">最近修改</h2>
            <a href="#/files" style="font-size: 13px">查看全部文件</a>
        </div>
        {#if data.recent.length === 0}
            <div class="empty"><p>设备开始同步后，这里会列出最近的修改。</p></div>
        {:else}
            <ul class="activity">
                {#each data.recent as c, i (c.seq)}
                    {@const p = recentPaths[i]}
                    <li>
                        <span class="mono faint">{stamp(c.at)}</span>
                        <span class="who muted">{c.deviceName ?? "后台"}</span>
                        <span class="path op-{c.op}">
                            {#if p}
                                {@const sp = splitPath(p)}
                                <span class="dir">{sp.dir}</span>{sp.name}
                            {:else}
                                <span class="faint mono">{c.id.slice(0, 16)}…</span>
                            {/if}
                            {#if c.op !== "write"}<span class="chip chip-plain" style="margin-left: 8px">{OP[c.op]}</span>{/if}
                        </span>
                    </li>
                {/each}
            </ul>
        {/if}
    </section>
{:else if !error}
    <p class="faint">正在加载…</p>
{/if}

<Modal bind:open={pairOpen} title="添加设备">
    {#if pairError}
        <p class="error">{pairError}</p>
    {:else if pair}
        <div class="pair-code" aria-live="polite">{pair.code}</div>
        <p class="countdown">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后失效 · 只能使用一次` : "已失效，请重新生成"}</p>
        <ol class="steps">
            <li>在新设备上用 BRAT 安装 lite-sync 插件。</li>
            <li>打开插件设置，填写服务器地址 <span class="mono">{location.origin}</span> 和这个配对码。</li>
            <li>按提示输入口令。口令只在那台设备上用于解开主密钥。</li>
        </ol>
    {:else}
        <p class="faint">正在生成…</p>
    {/if}
    {#snippet actions()}
        {#if pair && left === 0}<button class="btn" onclick={newCode}>重新生成</button>{/if}
        <button class="btn btn-primary" onclick={() => ((pairOpen = false), void load())}>完成</button>
    {/snippet}
</Modal>

<Modal bind:open={revokeOpen} title="吊销「{revokeTarget?.name ?? ''}」">
    <p>吊销后，这台设备立即无法访问服务器，它上面已有的文件不会被删除。</p>
    <p>它本地仍保存着主密钥。如果设备丢失，之后还应该轮换主密钥。</p>
    {#snippet actions()}
        <button class="btn" onclick={() => (revokeOpen = false)}>取消</button>
        <button class="btn btn-danger" disabled={busy} onclick={revoke}>吊销设备</button>
    {/snippet}
</Modal>

<Modal bind:open={renameOpen} title="修改设备名">
    <form id="rename-form" onsubmit={rename}>
        <label class="field">
            设备名
            <input bind:value={renameValue} maxlength="60" required />
            <span class="hint">新名称用于后台显示。冲突副本的文件名使用设备自己设置的名称。</span>
        </label>
    </form>
    {#snippet actions()}
        <button class="btn" onclick={() => (renameOpen = false)}>取消</button>
        <button class="btn btn-primary" form="rename-form" disabled={busy}>保存</button>
    {/snippet}
</Modal>
