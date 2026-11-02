<script lang="ts">
    import {
        DEFAULT_KDF,
        derivePassphraseKeys,
        deriveVaultKeys,
        masterKeyProof,
        newMasterKey,
        randomBytes,
        toB64,
        wrapMasterKey,
    } from "@lite-sync/core";
    import Custody from "../lib/Custody.svelte";
    import { api, describe } from "../lib/api";
    import { replace } from "../lib/router.svelte";
    import { rememberUnlock } from "../lib/unlock-cache";
    import { session } from "../lib/session.svelte";

    let { token, onDone }: { token: string; onDone: () => void } = $props();

    let pass = $state("");
    let pass2 = $state("");
    let busy = $state(false);
    let error = $state("");

    async function submit(e: SubmitEvent) {
        e.preventDefault();
        error = "";
        if (pass.length < 12) return void (error = "口令至少 12 个字符。建议在 Bitwarden 里生成 5 个单词以上的密码短语。");
        if (pass !== pass2) return void (error = "两次输入的口令不一致。");
        busy = true;
        try {
            const salt = randomBytes(16);
            const pk = await derivePassphraseKeys(pass, salt, DEFAULT_KDF);
            const mk = newMasterKey();
            const wrappedMk = await wrapMasterKey(pk.kek, mk);
            await api.post("/setup", {
                setupToken: token,
                salt: toB64(salt),
                kdf: DEFAULT_KDF,
                loginKey: pk.loginKey,
                wrappedMk,
                mkProof: await masterKeyProof(mk),
            });
            session.mk = mk;
            session.keys = await deriveVaultKeys(mk);
            session.totpEnabled = false;
            const active = await api.get<{ sessionTag: string; expiresAt: number }>("/session");
            session.expiresAt = active.expiresAt;
            session.sessionTag = active.sessionTag;
            await rememberUnlock(mk, wrappedMk, active.sessionTag, active.expiresAt).catch(() => {
                session.cacheWarning = "此浏览器无法保存解锁状态，刷新后需要重新输入口令。";
            });
            pass = pass2 = "";
            replace("/");
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
            <div class="gate-brand">
                <span class="wordmark">lite-sync</span>
                <p class="gate-tag">端到端加密的 Obsidian 同步。笔记在设备上加密，服务器只保存密文。</p>
            </div>
            <Custody />
        </aside>
        <form class="gate-main" onsubmit={submit}>
            <div class="stack" style="gap: 8px">
                <h1>设置口令</h1>
                <p class="muted">口令用来登录后台，也用来解开加密数据。它只在这个浏览器里参与计算，不会发送到服务器。</p>
            </div>
            <input class="sr-only" type="text" name="username" autocomplete="username" value="lite-sync" tabindex="-1" aria-hidden="true" readonly />
            <label class="field">
                口令
                <input type="password" autocomplete="new-password" bind:value={pass} required />
                <span class="hint">至少 12 个字符。建议用 Bitwarden 生成 5 个单词以上的密码短语。</span>
            </label>
            <label class="field">
                再输入一次
                <input type="password" autocomplete="new-password" bind:value={pass2} required />
            </label>
            {#if error}<p class="error">{error}</p>{/if}
            <button class="btn btn-primary btn-block" disabled={busy}>{busy ? "正在生成密钥…" : "创建并继续"}</button>
            <p class="hint">口令丢失后，可以在任意一台已配对的设备上重设。请另外抄一份纸质备份。</p>
        </form>
    </div>
</div>
