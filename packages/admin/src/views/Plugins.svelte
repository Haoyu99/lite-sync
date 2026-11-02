<script lang="ts">
    import { onMount } from "svelte";
    import { type DevicePluginReport, type PluginInventory, fromB64, fromUtf8, open, parsePluginInventory, pluginInventoryAad } from "@lite-sync/core";
    import { api, describe } from "../lib/api";
    import { stamp } from "../lib/format";
    import { session } from "../lib/session.svelte";

    type Report = DevicePluginReport & { inventory: PluginInventory | null; error: string };
    let reports = $state<Report[]>([]);
    let deviceId = $state("");
    let query = $state("");
    let enabledOnly = $state(false);
    let loading = $state(true);
    let error = $state("");
    async function load() {
        loading = true;
        try {
            const data = await api.get<{ reports: DevicePluginReport[] }>("/plugins");
            const keys = session.keys!;
            reports = await Promise.all(data.reports.map(async (r): Promise<Report> => {
                try {
                    const inventory = r.blob ? parsePluginInventory(JSON.parse(fromUtf8(await open(keys.config, fromB64(r.blob), pluginInventoryAad(r.deviceId))))) : null;
                    return { ...r, inventory, error: "" };
                } catch {
                    return { ...r, inventory: null, error: "清单解密或格式校验失败，请在设备上重新启动 Lite Sync 后重试。" };
                }
            }));
            if (!reports.some((r) => r.deviceId === deviceId)) deviceId = reports[0]?.deviceId ?? "";
            error = "";
        } catch (e) { error = describe(e); }
        finally { loading = false; }
    }
    onMount(() => { void load(); });
    const current = $derived(reports.find((r) => r.deviceId === deviceId));
    const visible = $derived((current?.inventory?.plugins ?? []).filter((p) =>
        (!enabledOnly || p.enabled) && `${p.name} ${p.id}`.toLowerCase().includes(query.trim().toLowerCase())));
</script>

<header class="page-head">
    <h1>插件</h1>
    <button class="btn btn-sm" disabled={loading} onclick={load}>{loading ? "正在读取…" : "刷新"}</button>
</header>
<p class="muted">查看各设备已安装的 Obsidian 社区插件。Lite Sync 自身已过滤。</p>
{#if error}<p class="error">{error}</p>{/if}
<div class="panel plugin-panel">
    <div class="plugin-tools">
        <label class="field">设备<select class="input" bind:value={deviceId} aria-label="选择设备">
            {#each reports as r (r.deviceId)}<option value={r.deviceId}>{r.deviceName}</option>{/each}
        </select></label>
        <label class="field">搜索<input class="input" type="search" placeholder="插件名称或 ID" bind:value={query} /></label>
        <label class="check"><input type="checkbox" bind:checked={enabledOnly} />只看已启用</label>
    </div>
    {#if loading}<p class="empty">正在读取插件清单…</p>
    {:else if !current}<p class="empty">还没有配对设备。</p>
    {:else if current.error}<p class="error">{current.error}</p>
    {:else if !current.inventory}<p class="empty">这台设备尚未上报清单。请将 Lite Sync 更新到 0.1.1 或更高版本，并打开 Obsidian 联网同步。</p>
    {:else}
        <p class="faint" style="padding: 0 16px; font-size: 13px">共 {current.inventory.plugins.length} 个插件 · 显示 {visible.length} 个 · 上报时间 {stamp(current.updatedAt!)}<br />设备在线时每分钟检查一次变化；离线时显示最后一次清单。</p>
        <div class="plugin-table-wrap"><table class="table plugin-table">
            <thead><tr><th>插件</th><th>版本</th><th>状态</th></tr></thead>
            <tbody>{#each visible as p (p.id)}<tr>
                <td><strong>{p.name}</strong><br /><span class="faint">{p.id}</span></td>
                <td>{p.version}</td><td><span class="chip" class:chip-ok={p.enabled}>{p.enabled ? "已启用" : "未启用"}</span></td>
            </tr>{/each}</tbody>
        </table></div>
        {#if !visible.length}<p class="empty">{current.inventory.plugins.length ? "没有匹配的插件。" : "这台设备没有安装其他社区插件。"}</p>{/if}
    {/if}
</div>
