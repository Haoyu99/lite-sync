<script lang="ts">
    import { onMount } from "svelte";
    import {
        type ConfigDoc,
        type PreloginResponse,
        DEFAULT_CONFIG,
        DEFAULT_KDF,
        aad,
        derivePassphraseKeys,
        fromB64,
        fromUtf8,
        normaliseConfig,
        open,
        randomBytes,
        seal,
        toB64,
        utf8,
        wrapMasterKey,
    } from "@lite-sync/core";
    import { api, describe } from "../lib/api";
    import { session } from "../lib/session.svelte";
    import Enrol from "./Enrol.svelte";

    let enrolling = $state(false);
    let offPass = $state("");
    let offCode = $state("");
    let offError = $state("");
    let offNotice = $state("");
    let savingOff = $state(false);

    let configText = $state("");
    let configRev = $state(0);
    let configError = $state("");
    let configNotice = $state("");
    let savingConfig = $state(false);

    let curPass = $state("");
    let newPass = $state("");
    let newPass2 = $state("");
    let passCode = $state("");
    let passError = $state("");
    let passNotice = $state("");
    let savingPass = $state(false);

    let recPass = $state("");
    let recCode = $state("");
    let recError = $state("");
    let recCodes = $state<string[]>([]);
    let savingRec = $state(false);

    async function loadConfig() {
        try {
            const doc = await api.get<ConfigDoc>("/config");
            configRev = doc.rev;
            const json = doc.blob ? JSON.parse(fromUtf8(await open(session.keys!.config, fromB64(doc.blob), aad.config(doc.rev)))) : DEFAULT_CONFIG;
            configText = JSON.stringify(normaliseConfig(json), null, 2);
        } catch (e) {
            configError = describe(e);
        }
    }

    onMount(loadConfig);

    async function saveConfig() {
        configError = configNotice = "";
        let parsed: unknown;
        try {
            parsed = JSON.parse(configText);
        } catch (e) {
            return void (configError = `不是有效的 JSON：${(e as Error).message}`);
        }
        const config = normaliseConfig(parsed);
        savingConfig = true;
        try {
            const next = configRev + 1;
            const blob = toB64(await seal(session.keys!.config, utf8(JSON.stringify(config)), aad.config(next)));
            const r = await api.put<{ rev: number }>("/config", { baseRev: configRev, blob });
            configRev = r.rev;
            configText = JSON.stringify(config, null, 2);
            configNotice = `已保存为第 ${r.rev} 版，在线设备会立即收到。超出范围的值已调整，未知的项已移除。`;
        } catch (e) {
            configError = describe(e);
        } finally {
            savingConfig = false;
        }
    }

    async function currentLoginKey(pass: string): Promise<string> {
        const pre = await api.get<PreloginResponse>("/prelogin");
        return (await derivePassphraseKeys(pass, fromB64(pre.salt!), pre.kdf!)).loginKey;
    }

    async function changePass(e: SubmitEvent) {
        e.preventDefault();
        passError = passNotice = "";
        if (newPass.length < 12) return void (passError = "新口令至少 12 个字符。");
        if (newPass !== newPass2) return void (passError = "两次输入的新口令不一致。");
        savingPass = true;
        try {
            const salt = randomBytes(16);
            const pk = await derivePassphraseKeys(newPass, salt, DEFAULT_KDF);
            await api.post("/passphrase", {
                currentLoginKey: await currentLoginKey(curPass),
                salt: toB64(salt),
                kdf: DEFAULT_KDF,
                loginKey: pk.loginKey,
                wrappedMk: await wrapMasterKey(pk.kek, session.mk!),
                totp: passCode,
            });
            curPass = newPass = newPass2 = passCode = "";
            passNotice = "口令已修改。已配对的设备不受影响，下次登录后台请使用新口令。";
        } catch (err) {
            passError = describe(err);
        } finally {
            savingPass = false;
        }
    }

    async function disableTotp(e: SubmitEvent) {
        e.preventDefault();
        offError = offNotice = "";
        savingOff = true;
        try {
            await api.post("/totp/disable", { loginKey: await currentLoginKey(offPass), totp: offCode });
            session.totpEnabled = false;
            session.recoveryLeft = 0;
            offPass = offCode = "";
            offNotice = "双重认证已关闭，恢复码已作废。之后登录只需要口令。";
        } catch (err) {
            offError = describe(err);
        } finally {
            savingOff = false;
        }
    }

    async function regenerate(e: SubmitEvent) {
        e.preventDefault();
        recError = "";
        savingRec = true;
        try {
            recCodes = (await api.post<{ recoveryCodes: string[] }>("/recovery-codes", { loginKey: await currentLoginKey(recPass), totp: recCode })).recoveryCodes;
            session.recoveryLeft = recCodes.length;
            recPass = recCode = "";
        } catch (err) {
            recError = describe(err);
        } finally {
            savingRec = false;
        }
    }
</script>

<header class="page-head">
    <h1>设置</h1>
</header>

<section class="panel" aria-labelledby="config-title">
    <div class="panel-head">
        <h2 id="config-title">统一配置</h2>
        <span class="faint mono" style="font-size: 12px">第 {configRev} 版 · 加密保存</span>
    </div>
    <div class="panel-body stack">
        <p class="muted" style="font-size: 14px">
            所有设备都从这里读取配置。<span class="mono">exclude</span> 填不同步的路径，例如
            <span class="mono">"私密/**"</span>；<span class="mono">massChangeGuard</span> 是一次同步中删除或覆盖多少个文件时需要确认。
            <span class="mono">.obsidian</span> 配置同步会在后续版本提供。
        </p>
        <label class="field">
            <span class="sr-only">配置 JSON</span>
            <textarea rows="22" spellcheck="false" bind:value={configText}></textarea>
        </label>
        {#if configError}<p class="error">{configError}</p>{/if}
        {#if configNotice}<p class="notice">{configNotice}</p>{/if}
        <div class="row">
            <button class="btn btn-primary" disabled={savingConfig} onclick={saveConfig}>{savingConfig ? "正在保存…" : "保存配置"}</button>
            <button class="btn btn-quiet" onclick={() => (configText = JSON.stringify(DEFAULT_CONFIG, null, 2))}>填入默认值</button>
        </div>
    </div>
</section>

<section class="panel" aria-labelledby="pass-title">
    <div class="panel-head"><h2 id="pass-title">修改口令</h2></div>
    <form class="panel-body stack" onsubmit={changePass} style="max-width: 520px">
        <p class="muted" style="font-size: 14px">只重新加密主密钥，数据和已配对的设备都不受影响。</p>
        <input class="sr-only" type="text" name="username" autocomplete="username" value="lite-sync" tabindex="-1" aria-hidden="true" readonly />
        <label class="field">当前口令<input type="password" autocomplete="current-password" bind:value={curPass} required /></label>
        <label class="field">新口令<input type="password" autocomplete="new-password" bind:value={newPass} required /></label>
        <label class="field">再输入一次新口令<input type="password" autocomplete="new-password" bind:value={newPass2} required /></label>
        {#if session.totpEnabled}
            <label class="field">验证码<input class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" bind:value={passCode} /></label>
        {/if}
        {#if passError}<p class="error">{passError}</p>{/if}
        {#if passNotice}<p class="notice">{passNotice}</p>{/if}
        <button class="btn btn-primary" style="justify-self: start" disabled={savingPass}>{savingPass ? "正在计算…" : "修改口令"}</button>
    </form>
</section>

<section class="panel" aria-labelledby="totp-title">
    <div class="panel-head">
        <h2 id="totp-title">双重认证</h2>
        <span class="chip {session.totpEnabled ? 'chip-ok' : 'chip-plain'}">{session.totpEnabled ? "已开启" : "未开启"}</span>
    </div>
    <div class="panel-body stack" style="max-width: 520px">
        {#if offNotice}<p class="notice">{offNotice}</p>{/if}
        {#if session.totpEnabled}
            <form class="stack" onsubmit={disableTotp}>
                <p class="muted" style="font-size: 14px">登录时需要口令和 Google Authenticator 验证码。关闭后只需要口令，恢复码也会作废。</p>
                <label class="field">口令<input type="password" autocomplete="current-password" bind:value={offPass} required /></label>
                <label class="field">验证码<input class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" bind:value={offCode} required /></label>
                {#if offError}<p class="error">{offError}</p>{/if}
                <button class="btn btn-danger" style="justify-self: start" disabled={savingOff}>{savingOff ? "正在计算…" : "关闭双重认证"}</button>
            </form>
        {:else if enrolling}
            <Enrol embedded onDone={() => ((enrolling = false), (offNotice = ""))} />
        {:else}
            <p class="muted" style="font-size: 14px">
                现在登录只需要口令。开启后还需要手机上 Google Authenticator 的 6 位验证码，口令泄露时别人也无法登录后台。
            </p>
            <button class="btn btn-primary" style="justify-self: start" onclick={() => ((enrolling = true), (offNotice = ""))}>开启双重认证</button>
        {/if}
    </div>
</section>

{#if session.totpEnabled && !enrolling}
<section class="panel" aria-labelledby="rec-title">
    <div class="panel-head">
        <h2 id="rec-title">恢复码</h2>
        <span class="chip {session.recoveryLeft > 3 ? 'chip-ok' : 'chip-warn'}">剩余 {session.recoveryLeft} 个</span>
    </div>
    <form class="panel-body stack" onsubmit={regenerate} style="max-width: 520px">
        {#if recCodes.length}
            <p class="muted" style="font-size: 14px">新的恢复码只显示这一次，旧的已全部作废。</p>
            <ul class="codes">{#each recCodes as c (c)}<li>{c}</li>{/each}</ul>
            <button type="button" class="btn btn-sm" style="justify-self: start" onclick={() => navigator.clipboard.writeText(recCodes.join("\n"))}>复制全部</button>
        {:else}
            <p class="muted" style="font-size: 14px">重新生成后，旧的恢复码全部作废。</p>
            <label class="field">口令<input type="password" autocomplete="current-password" bind:value={recPass} required /></label>
            <label class="field">验证码<input class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" bind:value={recCode} required /></label>
            {#if recError}<p class="error">{recError}</p>{/if}
            <button class="btn" style="justify-self: start" disabled={savingRec}>重新生成恢复码</button>
        {/if}
    </form>
</section>
{/if}
