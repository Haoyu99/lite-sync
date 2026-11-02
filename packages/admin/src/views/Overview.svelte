<script lang="ts">
    import { onMount } from "svelte";
    import type { ActivityDay, ChangeEntry, DeviceSummary, FileEntry, Overview, PairingCode } from "@lite-sync/core";
    import Heatmap from "../lib/Heatmap.svelte";
    import Icon from "../lib/Icon.svelte";
    import Modal from "../lib/Modal.svelte";
    import OsIcon from "../lib/OsIcon.svelte";
    import { api, describe } from "../lib/api";
    import { PLATFORM, ago, bytes, splitPath } from "../lib/format";
    import { session } from "../lib/session.svelte";
    import { decryptFiles, pathMap } from "../lib/vault";

    const DAY_MS = 86_400_000;
    const STALE_MS = 7 * DAY_MS;
    const ONLINE_MS = 5 * 60_000;
    const tz = -new Date().getTimezoneOffset(); // minutes east of UTC
    const localDay = (t: number) => Math.floor((t + tz * 60_000) / DAY_MS);

    let data = $state<Overview | null>(null);
    let activity = $state<ActivityDay[]>([]);
    let paths = $state<Map<string, string>>(new Map());
    let error = $state("");
    let now = $state(Date.now());

    // Filters: a device and/or one day. Both narrow the heatmap and the change log.
    let device = $state<string | null>(null);
    let day = $state<number | null>(null);
    let log = $state<ChangeEntry[]>([]);
    let logMore = $state(false);
    let logBusy = $state(false);
    let logReq = 0;

    let pairOpen = $state(false);
    let pair = $state<PairingCode | null>(null);
    let pairError = $state("");
    let revokeTarget = $state<DeviceSummary | null>(null);
    let revokeOpen = $state(false);
    let renameTarget = $state<DeviceSummary | null>(null);
    let renameOpen = $state(false);
    let renameValue = $state("");
    let busy = $state(false);

    async function refreshPaths() {
        const f = await api.get<{ files: FileEntry[] }>("/files");
        paths = pathMap(await decryptFiles(session.keys!, f.files));
    }

    async function load() {
        try {
            const [o, a] = await Promise.all([api.get<Overview>("/overview"), api.get<{ days: ActivityDay[] }>(`/activity?tz=${tz}`), refreshPaths()]);
            activity = a.days;
            data = o;
            error = "";
        } catch (e) {
            error = describe(e);
        }
    }

    // `quiet` is the background refresh: it leaves the loading state alone so nothing on screen changes until new rows arrive.
    async function loadLog(append = false, quiet = false) {
        const req = ++logReq;
        const q = new URLSearchParams({ tz: String(tz) });
        if (device) q.set("device", device);
        if (day !== null) q.set("day", String(day));
        if (append && log.length) q.set("before", String(log.at(-1)!.seq));
        if (!quiet) logBusy = true;
        try {
            const r = await api.get<{ entries: ChangeEntry[]; more: boolean }>(`/changes?${q}`);
            if (req !== logReq) return; // a newer filter replaced this request
            // A new file can reach the log before the path list has it. Decrypt its path first, so the row never shows the file ID.
            if (r.entries.some((e) => !paths.has(e.id))) await refreshPaths().catch(() => {});
            if (req !== logReq) return;
            log = append ? [...log, ...r.entries] : r.entries;
            logMore = r.more;
        } catch (e) {
            error = describe(e);
        } finally {
            if (req === logReq) logBusy = false;
        }
    }

    $effect(() => {
        void device;
        void day;
        void loadLog();
    });

    onMount(() => {
        void load();
        const t = setInterval(() => {
            now = Date.now();
            if (pairOpen || revokeOpen || renameOpen) return;
            // Paths first, then the log, so new rows arrive with their names.
            void load().then(() => {
                if (log.length <= 50 && !logBusy) void loadLog(false, true);
            });
        }, 15_000);
        const tick = setInterval(() => (now = Date.now()), 1000);
        return () => {
            clearInterval(t);
            clearInterval(tick);
        };
    });

    const today = $derived(localDay(now));
    const counts = $derived.by(() => {
        const m = new Map<number, number>();
        for (const a of activity) if (!device || a.deviceId === device) m.set(a.day, (m.get(a.day) ?? 0) + a.n);
        return m;
    });
    const yearTotal = $derived([...counts.values()].reduce((s, n) => s + n, 0));
    const perDevice = $derived.by(() => {
        const m = new Map<string, number>();
        for (const a of activity) if (a.deviceId) m.set(a.deviceId, (m.get(a.deviceId) ?? 0) + a.n);
        return m;
    });
    const devices = $derived(data ? [...data.devices.filter((d) => !d.revokedAt), ...data.devices.filter((d) => d.revokedAt)] : []);
    const selected = $derived(data?.devices.find((d) => d.id === device) ?? null);

    function deviceState(d: DeviceSummary) {
        if (d.revokedAt) return { cls: "chip-bad", text: "已吊销", ok: false };
        if (d.pending > 0) return { cls: "chip-warn", text: `↑ ${d.pending} 待上传`, ok: false };
        const behind = (data?.head ?? 0) - d.ackSeq;
        if (behind > 0) return { cls: "chip-warn", text: `落后 ${behind} 次修改`, ok: false };
        if (d.lastSeenAt === null) return { cls: "chip-plain", text: "未连接", ok: false };
        return { cls: "chip-ok", text: "已同步", ok: true };
    }

    const activeCount = $derived(devices.filter((d) => !d.revokedAt).length);
    const online = (d: DeviceSummary) => !d.revokedAt && d.lastSeenAt !== null && now - d.lastSeenAt < ONLINE_MS;

    const status = $derived.by(() => {
        const active = devices.filter((d) => !d.revokedAt);
        if (active.length === 0) return { tone: "idle", title: "还没有配对的设备", sub: "点「添加设备」获得配对码，在 Obsidian 的 lite-sync 设置里填入。" };
        const last = Math.max(...active.map((d) => d.lastSeenAt ?? 0));
        const seen = last ? `最近同步 ${ago(last, now)}` : "还没有设备连接过";
        const lagging = active.filter((d) => !deviceState(d).ok);
        if (lagging.length === 0) return { tone: "ok", title: `${active.length} 台设备全部已同步`, sub: seen };
        return {
            tone: "warn",
            title: `${lagging.length} 台设备未同步`,
            sub: `${lagging.map((d) => `${d.name} ${deviceState(d).text}`).join("，")} · ${seen}`,
        };
    });

    function dayName(d: number): string {
        if (d === today) return "今天";
        if (d === today - 1) return "昨天";
        const t = new Date(d * DAY_MS);
        const md = `${t.getUTCMonth() + 1}月${t.getUTCDate()}日`;
        return t.getUTCFullYear() === new Date(now).getFullYear() ? md : `${t.getUTCFullYear()}年${md}`;
    }

    const clock = (t: number) => {
        const d = new Date(t);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    function opLabel(e: ChangeEntry) {
        if (e.op === "delete") return { cls: "chip-bad", text: "删除" };
        if (e.op === "restore") return { cls: "chip-plain", text: "恢复" };
        if (e.rev === 1) return { cls: "chip-ok", text: "新建" };
        return null;
    }

    const platformOf = (id: string | null) => data?.devices.find((d) => d.id === id)?.platform ?? "unknown";

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
            void loadLog();
        } catch (err) {
            error = describe(err);
        } finally {
            busy = false;
        }
    }

    function closeMenu(e: Event) {
        (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
    }
</script>

<header class="page-head">
    <div class="stack" style="gap: 10px">
        <h1>设备</h1>
        {#if data}
            <p class="lede lede-{status.tone}" aria-live="polite"><span class="lede-mark" aria-hidden="true"></span>{status.title}</p>
            <p class="lede-sub">{status.sub}</p>
        {/if}
    </div>
    <button class="btn btn-primary" onclick={newCode}>添加设备</button>
</header>

{#if error}<p class="error">{error}</p>{/if}

{#if data}
    <dl class="figures" aria-label="概况">
        <div><dt>设备</dt><dd>{activeCount}</dd></div>
        <div><dt>文件</dt><dd>{data.files.toLocaleString()}</dd></div>
        <div><dt>历史版本</dt><dd>{data.versions.toLocaleString()}</dd></div>
        <div><dt>密文</dt><dd>{bytes(data.storageBytes)}</dd></div>
    </dl>

    <section class="panel" aria-label="已配对的设备">
        {#if devices.length === 0}
            <div class="empty">
                <p>添加第一台设备。配对码在 Obsidian 的 lite-sync 设置里填入。</p>
                <button class="btn btn-primary" onclick={newCode}>添加设备</button>
            </div>
        {:else}
            {#each devices as d (d.id)}
                {@const s = deviceState(d)}
                <div
                    class="device"
                    class:selected={device === d.id}
                    class:revoked={!!d.revokedAt}
                    class:stale={!d.revokedAt && d.lastSeenAt !== null && now - d.lastSeenAt > STALE_MS}
                >
                    <button class="device-main" aria-pressed={device === d.id} onclick={() => ((device = device === d.id ? null : d.id), (day = null))}>
                        <span class="os-badge">
                            <OsIcon platform={d.platform} size={18} />
                            {#if !d.revokedAt}<span class="dot" class:on={online(d)} title={online(d) ? "5 分钟内在线" : "离线"}></span>{/if}
                        </span>
                        <span class="device-text">
                            <span class="device-name">{d.name}</span>
                            <span class="device-sub">{PLATFORM[d.platform]} · v{d.clientVersion} · {ago(d.lastSeenAt, now)}</span>
                        </span>
                    </button>
                    <span class="device-count">近一年 <b>{perDevice.get(d.id) ?? 0}</b> 次修改</span>
                    <span class="chip {s.cls}">{s.text}</span>
                    {#if d.revokedAt}
                        <span></span>
                    {:else}
                        <details class="menu">
                            <summary class="btn btn-quiet btn-sm" aria-label="更多操作"><Icon name="more" /></summary>
                            <div class="menu-pop">
                                <button class="btn btn-quiet btn-sm" onclick={(e) => (closeMenu(e), (renameTarget = d), (renameValue = d.name), (renameOpen = true))}>改名</button>
                                <button class="btn btn-quiet btn-sm btn-danger" onclick={(e) => (closeMenu(e), (revokeTarget = d), (revokeOpen = true))}>吊销</button>
                            </div>
                        </details>
                    {/if}
                </div>
            {/each}
        {/if}
    </section>

    <section class="panel" aria-labelledby="heat-title">
        <div class="panel-head">
            <h2 id="heat-title">
                {#if selected}<span class="title-os"><OsIcon platform={selected.platform} size={14} /></span>{/if}
                {selected?.name ?? "全部设备"} · 近一年 {yearTotal.toLocaleString()} 次修改
            </h2>
        </div>
        <div class="panel-body">
            <Heatmap {counts} {today} selected={day} onSelect={(d) => (day = day === d ? null : d)} />
        </div>
    </section>

    <section class="panel" aria-labelledby="log-title">
        <div class="panel-head">
            <h2 id="log-title">修改记录</h2>
            <div class="row">
                {#if selected}
                    <button class="filter" onclick={() => (device = null)} aria-label="取消设备筛选">
                        <OsIcon platform={selected.platform} size={12} />{selected.name}<Icon name="x" size={12} />
                    </button>
                {/if}
                {#if day !== null}
                    <button class="filter" onclick={() => (day = null)} aria-label="取消日期筛选">{dayName(day)}<Icon name="x" size={12} /></button>
                {/if}
            </div>
        </div>
        {#if log.length === 0}
            <div class="empty"><p>{logBusy ? "正在加载…" : device || day !== null ? "这个范围内没有修改。" : "设备开始同步后，这里会列出每一次修改。"}</p></div>
        {:else}
            <ol class="log">
                {#each log as e, i (e.seq)}
                    {@const d = localDay(e.at)}
                    {#if i === 0 || localDay(log[i - 1]!.at) !== d}
                        <li class="log-day">{dayName(d)}</li>
                    {/if}
                    {@const p = paths.get(e.id)}
                    {@const op = opLabel(e)}
                    <li>
                        <button class="log-item" onclick={() => (location.hash = `#/files/${e.id}`)}>
                            <span class="mono faint">{clock(e.at)}</span>
                            <span class="log-who"><OsIcon platform={platformOf(e.deviceId)} size={13} />{e.deviceName ?? "后台"}</span>
                            <span class="path" class:op-delete={e.op === "delete"}>
                                {#if p}
                                    {@const sp = splitPath(p)}<span class="dir">{sp.dir}</span>{sp.name}
                                {:else}
                                    <span class="faint mono">{e.id.slice(0, 16)}…</span>
                                {/if}
                            </span>
                            <span class="log-end">
                                {#if op}<span class="chip {op.cls}">{op.text}</span>{/if}
                                <span class="log-rev">第 {e.rev} 版</span>
                            </span>
                        </button>
                    </li>
                {/each}
            </ol>
            {#if logMore}
                <div class="panel-body" style="text-align: center">
                    <button class="btn btn-sm" disabled={logBusy} onclick={() => loadLog(true)}>{logBusy ? "正在加载…" : "加载更多"}</button>
                </div>
            {/if}
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
