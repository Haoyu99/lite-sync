<script lang="ts">
    import { session } from "../lib/session.svelte";
    import { route } from "../lib/router.svelte";
    import Activity from "./Activity.svelte";
    import Plugins from "./Plugins.svelte";
    import Files from "./Files.svelte";
    import Overview from "./Overview.svelte";
    import Settings from "./Settings.svelte";

    let { onSignOut }: { onSignOut: () => void } = $props();

    const NAV = [
        { path: "/", label: "设备" },
        { path: "/files", label: "文件" },
        { path: "/plugins", label: "插件" },
        { path: "/activity", label: "操作记录" },
        { path: "/settings", label: "设置" },
    ];

    const section = $derived(NAV.find((n) => n.path !== "/" && route.path.startsWith(n.path))?.path ?? "/");
</script>

<div class="app">
    <header class="topbar">
        <div class="topbar-inner">
            <span class="wordmark">lite-sync</span>
            <nav class="nav" aria-label="主导航">
                {#each NAV as n (n.path)}
                    <a href="#{n.path}" aria-current={section === n.path ? "page" : undefined}>{n.label}</a>
                {/each}
            </nav>
            <div class="topbar-end">
                <span class="lock-state" title="解锁有效期 7 天，可在设置中撤销浏览器信任">已解锁</span>
                <button class="btn btn-quiet btn-sm" onclick={onSignOut}>退出</button>
            </div>
        </div>
    </header>
    <main class="main">
        {#if session.cacheWarning}<p class="notice" role="status">{session.cacheWarning}</p>{/if}
        {#if section === "/files"}
            <Files />
        {:else if section === "/plugins"}
            <Plugins />
        {:else if section === "/activity"}
            <Activity />
        {:else if section === "/settings"}
            <Settings />
        {:else}
            <Overview />
        {/if}
    </main>
</div>
