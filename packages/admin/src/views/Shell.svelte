<script lang="ts">
    import { route } from "../lib/router.svelte";
    import Activity from "./Activity.svelte";
    import Files from "./Files.svelte";
    import Overview from "./Overview.svelte";
    import Settings from "./Settings.svelte";

    let { onSignOut }: { onSignOut: () => void } = $props();

    const NAV = [
        { path: "/", label: "设备", icon: "💻" },
        { path: "/files", label: "文件", icon: "📄" },
        { path: "/activity", label: "操作记录", icon: "🕘" },
        { path: "/settings", label: "设置", icon: "⚙️" },
    ];

    const section = $derived(NAV.find((n) => n.path !== "/" && route.path.startsWith(n.path))?.path ?? "/");
</script>

<div class="shell">
    <nav class="rail" aria-label="主导航">
        <span class="wordmark">lite-sync</span>
        <div class="nav">
            {#each NAV as n (n.path)}
                <a href="#{n.path}" aria-current={section === n.path ? "page" : undefined}><span class="nav-icon" aria-hidden="true">{n.icon}</span>{n.label}</a>
            {/each}
        </div>
        <div class="rail-foot">
            <span class="lock-state">已解锁 · 30 分钟无操作自动退出</span>
            <button class="btn btn-quiet btn-sm" style="justify-self: start" onclick={onSignOut}>退出</button>
        </div>
    </nav>
    <main class="main">
        {#if section === "/files"}
            <Files />
        {:else if section === "/activity"}
            <Activity />
        {:else if section === "/settings"}
            <Settings />
        {:else}
            <Overview />
        {/if}
    </main>
</div>
