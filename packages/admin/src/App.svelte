<script lang="ts">
    import { onMount } from "svelte";
    import type { PreloginResponse } from "@lite-sync/core";
    import { ApiError, api, describe } from "./lib/api";
    import { replace, route } from "./lib/router.svelte";
    import { lock, session } from "./lib/session.svelte";
    import Enrol from "./views/Enrol.svelte";
    import Login from "./views/Login.svelte";
    import Setup from "./views/Setup.svelte";
    import Shell from "./views/Shell.svelte";

    type Stage = "loading" | "uninitialised" | "setup" | "login" | "unlock" | "enrol" | "app" | "error";

    const IDLE_MS = 30 * 60_000;

    let stage = $state<Stage>("loading");
    let pre = $state<PreloginResponse>({ initialised: false });
    let wrappedMk = $state("");
    let setupToken = $state("");
    let error = $state("");

    async function boot() {
        try {
            pre = await api.get<PreloginResponse>("/prelogin");
            const token = /^\/setup\/(.+)$/.exec(route.path)?.[1];
            if (!pre.initialised) {
                setupToken = token ?? "";
                stage = token ? "setup" : "uninitialised";
                return;
            }
            if (token) replace("/");
            try {
                const s = await api.get<{ wrappedMk: string; totpEnabled: boolean; recoveryCodesLeft: number }>("/session");
                wrappedMk = s.wrappedMk;
                session.totpEnabled = s.totpEnabled;
                session.recoveryLeft = s.recoveryCodesLeft;
                stage = "unlock";
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) stage = "login";
                else throw e;
            }
        } catch (e) {
            error = describe(e);
            stage = "error";
        }
    }

    // Two-factor authentication can be switched on or off in settings, so re-read it before each login.
    async function toLogin() {
        lock();
        pre = await api.get<PreloginResponse>("/prelogin").catch(() => pre);
        stage = "login";
    }

    async function signOut() {
        await api.post("/logout").catch(() => {});
        await toLogin();
    }

    onMount(() => {
        void boot();
        let last = Date.now();
        const bump = () => (last = Date.now());
        const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
        for (const ev of events) window.addEventListener(ev, bump, { passive: true });
        const expired = () => void toLogin();
        window.addEventListener("lite-sync:expired", expired);
        const timer = setInterval(() => {
            if (session.keys && Date.now() - last > IDLE_MS) void signOut();
        }, 30_000);
        return () => {
            clearInterval(timer);
            window.removeEventListener("lite-sync:expired", expired);
            for (const ev of events) window.removeEventListener(ev, bump);
        };
    });
</script>

{#if stage === "loading"}
    <div class="gate"><span class="wordmark">lite-sync</span></div>
{:else if stage === "error"}
    <div class="gate">
        <div class="gate-card narrow">
            <div class="gate-main">
                <span class="wordmark">lite-sync</span>
                <p class="error">{error}</p>
                <button class="btn" onclick={() => location.reload()}>重新加载</button>
            </div>
        </div>
    </div>
{:else if stage === "uninitialised"}
    <div class="gate">
        <div class="gate-card narrow">
            <div class="gate-main">
                <span class="wordmark">lite-sync</span>
                <h1>还没有初始化</h1>
                <p class="muted">初始化需要服务器生成的一次性链接。在服务器上运行下面的命令，打开它输出的链接。</p>
                <pre class="pair-code" style="font-size: 13px; letter-spacing: 0; text-align: left">docker exec lite-sync lite-sync setup-link</pre>
            </div>
        </div>
    </div>
{:else if stage === "setup"}
    <Setup token={setupToken} onDone={() => (stage = "enrol")} />
{:else if stage === "login" || stage === "unlock"}
    <Login salt={pre.salt ?? ""} kdf={pre.kdf!} totp={!!pre.totp} mode={stage} {wrappedMk} onDone={() => (stage = "app")} />
{:else if stage === "enrol"}
    <Enrol onDone={() => (stage = "app")} onSkip={() => (stage = "app")} />
{:else}
    <Shell onSignOut={signOut} />
{/if}
