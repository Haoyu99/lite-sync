<script lang="ts">
    import { type KdfParams, type LoginResponse, derivePassphraseKeys, deriveVaultKeys, fromB64, unwrapMasterKey } from "@lite-sync/core";
    import Custody from "../lib/Custody.svelte";
    import { api, describe } from "../lib/api";
    import { session } from "../lib/session.svelte";

    let {
        salt,
        kdf,
        totp,
        mode,
        wrappedMk,
        onDone,
    }: { salt: string; kdf: KdfParams; totp: boolean; mode: "login" | "unlock"; wrappedMk: string; onDone: () => void } = $props();

    let pass = $state("");
    let code = $state("");
    let useRecovery = $state(false);
    let busy = $state(false);
    let error = $state("");

    const askCode = $derived(mode === "login" && totp);

    async function submit(e: SubmitEvent) {
        e.preventDefault();
        busy = true;
        error = "";
        try {
            const pk = await derivePassphraseKeys(pass, fromB64(salt), kdf);
            let wrapped = wrappedMk;
            if (mode === "login") {
                const body = !askCode ? { loginKey: pk.loginKey } : useRecovery ? { loginKey: pk.loginKey, recoveryCode: code } : { loginKey: pk.loginKey, totp: code };
                wrapped = (await api.post<LoginResponse>("/login", body)).wrappedMk;
                const s = await api.get<{ totpEnabled: boolean; recoveryCodesLeft: number }>("/session");
                session.totpEnabled = s.totpEnabled;
                session.recoveryLeft = s.recoveryCodesLeft;
            }
            const mk = await unwrapMasterKey(pk.kek, wrapped);
            session.mk = mk;
            session.keys = await deriveVaultKeys(mk);
            pass = code = "";
            onDone();
        } catch (err) {
            error = describe(err);
        } finally {
            busy = false;
        }
    }
</script>

<div class="gate">
    <div class="gate-card">
        <aside class="gate-aside">
            <span class="wordmark">lite-sync</span>
            <Custody />
        </aside>
        <form class="gate-main" onsubmit={submit}>
            <div class="stack" style="gap: 8px">
                <h1>{mode === "login" ? "登录" : "解锁"}</h1>
                <p class="muted">
                    {mode === "unlock"
                        ? "登录仍然有效。输入口令，在这个浏览器里解开主密钥。"
                        : askCode
                          ? "输入口令和手机上的验证码。口令在浏览器里算出登录钥匙，服务器只收到登录钥匙。"
                          : "输入口令。口令在浏览器里算出登录钥匙，服务器只收到登录钥匙。"}
                </p>
            </div>
            <input class="sr-only" type="text" name="username" autocomplete="username" value="lite-sync" tabindex="-1" aria-hidden="true" readonly />
            <label class="field">
                口令
                <!-- svelte-ignore a11y_autofocus -->
                <input type="password" autocomplete="current-password" bind:value={pass} required autofocus />
            </label>
            {#if askCode}
                <label class="field">
                    {useRecovery ? "恢复码" : "验证码"}
                    {#if useRecovery}
                        <input type="text" autocomplete="off" spellcheck="false" placeholder="abcde-fghjk" bind:value={code} required />
                    {:else}
                        <input class="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" bind:value={code} />
                    {/if}
                </label>
                <button type="button" class="btn btn-quiet btn-sm" style="justify-self: start" onclick={() => ((useRecovery = !useRecovery), (code = ""))}>
                    {useRecovery ? "改用验证码" : "手机不在身边？使用恢复码"}
                </button>
            {/if}
            {#if error}<p class="error">{error}</p>{/if}
            <button class="btn btn-primary btn-block" disabled={busy}>{busy ? "正在计算…" : mode === "login" ? "登录" : "解锁"}</button>
        </form>
    </div>
</div>
