<script lang="ts">
    import { onMount } from "svelte";
    import QRCode from "qrcode";
    import { api, describe } from "../lib/api";
    import { session } from "../lib/session.svelte";

    // Shown after setup (full screen, skippable) and from settings (embedded in the page).
    let { onDone, onSkip, embedded = false }: { onDone: () => void; onSkip?: () => void; embedded?: boolean } = $props();

    let qr = $state("");
    let secret = $state("");
    let code = $state("");
    let codes = $state<string[]>([]);
    let saved = $state(false);
    let busy = $state(false);
    let error = $state("");

    onMount(async () => {
        try {
            const r = await api.post<{ secret: string; otpauthUrl: string }>("/totp/begin");
            secret = r.secret.replace(/(.{4})/g, "$1 ").trim();
            qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 0, width: 360, color: { dark: "#141b2d", light: "#ffffff" } });
        } catch (e) {
            error = describe(e);
        }
    });

    async function confirm(e: SubmitEvent) {
        e.preventDefault();
        busy = true;
        error = "";
        try {
            codes = (await api.post<{ recoveryCodes: string[] }>("/totp/confirm", { totp: code })).recoveryCodes;
            session.totpEnabled = true;
            session.recoveryLeft = codes.length;
        } catch (err) {
            error = describe(err);
        } finally {
            busy = false;
        }
    }
</script>

{#snippet content(cls: string)}
    {#if codes.length === 0}
        <form class={cls} onsubmit={confirm}>
            {#if !embedded}<span class="wordmark">lite-sync</span>{/if}
            <div class="stack" style="gap: 8px">
                {#if !embedded}<h1>开启双重认证（可选）</h1>{/if}
                <p class="muted">用 Google Authenticator 扫描二维码，然后输入它显示的 6 位数。开启后，新浏览器首次登录需要口令和验证码，受信任浏览器后续免验证码。</p>
            </div>
            {#if qr}
                <img class="qr" src={qr} alt="验证器二维码" />
                <p class="secret" title="无法扫码时手动输入这串密钥">{secret}</p>
            {/if}
            <label class="field">
                验证码
                <input class="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" bind:value={code} required />
            </label>
            {#if error}<p class="error">{error}</p>{/if}
            <button class="btn btn-primary {embedded ? '' : 'btn-block'}" style={embedded ? "justify-self: start" : ""} disabled={busy || !qr}>{busy ? "正在验证…" : "开启"}</button>
            {#if onSkip}
                <button type="button" class="btn btn-quiet btn-sm" style="justify-self: center" onclick={onSkip}>暂不开启，以后在设置里开启</button>
            {/if}
            <p class="hint">验证码请放在手机上，不要和口令一起存进 Bitwarden。</p>
        </form>
    {:else}
        <div class={cls}>
            {#if !embedded}<span class="wordmark">lite-sync</span>{/if}
            <div class="stack" style="gap: 8px">
                {#if !embedded}<h1>保存恢复码</h1>{/if}
                <p class="muted">手机丢失时，用恢复码代替验证码登录。每个只能用一次，这里只显示这一次。</p>
            </div>
            <ul class="codes">
                {#each codes as c (c)}<li>{c}</li>{/each}
            </ul>
            <button class="btn btn-sm" style="justify-self: start" onclick={() => navigator.clipboard.writeText(codes.join("\n"))}>复制全部</button>
            <label class="check">
                <input type="checkbox" bind:checked={saved} />
                <span>我已经把恢复码和口令另外保存好了，建议抄一份纸质的</span>
            </label>
            <button class="btn btn-primary {embedded ? '' : 'btn-block'}" style={embedded ? "justify-self: start" : ""} disabled={!saved} onclick={onDone}>
                {embedded ? "完成" : "进入后台"}
            </button>
        </div>
    {/if}
{/snippet}

{#if embedded}
    {@render content("stack")}
{:else}
    <div class="gate">
        <div class="gate-card narrow">{@render content("gate-main")}</div>
    </div>
{/if}
