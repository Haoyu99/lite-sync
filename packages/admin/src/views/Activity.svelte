<script lang="ts">
    import { onMount } from "svelte";
    import type { AuditEntry } from "@lite-sync/core";
    import { api, describe } from "../lib/api";
    import { stamp } from "../lib/format";

    let entries = $state<AuditEntry[]>([]);
    let error = $state("");
    let loaded = $state(false);

    const LABEL: Record<string, string> = {
        "vault.initialised": "初始化",
        login: "登录后台",
        "totp.enabled": "开启双重认证",
        "totp.disabled": "关闭双重认证",
        "totp.reset": "在服务器上重置验证器",
        "recovery_code.used": "使用恢复码",
        "recovery_codes.regenerated": "重新生成恢复码",
        "passphrase.changed": "修改口令",
        "passphrase.reset": "在设备上重设口令",
        "pairing_code.created": "生成配对码",
        "device.paired": "配对设备",
        "device.renamed": "修改设备名",
        "device.revoked": "吊销设备",
        "file.restored": "恢复文件版本",
        "config.saved": "保存统一配置",
    };

    const actor = (a: string) => (a === "admin" ? "后台" : a === "server" ? "服务器" : a.startsWith("device:") ? "设备" : a);

    onMount(async () => {
        try {
            entries = (await api.get<{ entries: AuditEntry[] }>("/audit")).entries;
        } catch (e) {
            error = describe(e);
        } finally {
            loaded = true;
        }
    });
</script>

<header class="page-head">
    <h1>操作记录</h1>
    <span class="faint" style="font-size: 13px">登录、配对、吊销、恢复等管理操作，最近 200 条</span>
</header>

{#if error}<p class="error">{error}</p>{/if}

<section class="panel">
    {#if !loaded}
        <p class="empty">正在加载…</p>
    {:else if entries.length === 0}
        <p class="empty">还没有记录。</p>
    {:else}
        <table class="table">
            <thead><tr><th>时间</th><th>来源</th><th>操作</th></tr></thead>
            <tbody>
                {#each entries as e, i (i)}
                    <tr>
                        <td class="mono faint" style="white-space: nowrap">{stamp(e.at)}</td>
                        <td class="muted">{actor(e.actor)}</td>
                        <td>{LABEL[e.action] ?? e.action}{#if e.detail}<span class="faint"> · {e.detail}</span>{/if}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
    {/if}
</section>
