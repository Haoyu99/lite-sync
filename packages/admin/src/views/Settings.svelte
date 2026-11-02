<script lang="ts">
    import { onMount } from "svelte";
    import {
        type ConfigDoc,
        type PreloginResponse,
        type SyncConfig,
        DEFAULT_CONFIG,
        EXCLUDED_PLUGINS,
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

    // The form edits the settings the plug-in reads today. Everything else in the stored document
    // (reserved settings, per-platform overrides) is kept as it is, and editable under "高级".
    let config = $state<SyncConfig>(normaliseConfig({}));
    let excludes = $state<string[]>([]);
    let guard = $state(20);
    let maxMB = $state(50);
    let debounceSec = $state(2);
    let syncPlugins = $state(true);
    let syncPluginData = $state(true);
    let excludedPlugins = $state("");
    let rawText = $state("");
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

    function fill(c: SyncConfig) {
        config = c;
        excludes = [...c.exclude];
        guard = c.sync.massChangeGuard;
        maxMB = c.sync.maxFileSizeMB;
        debounceSec = c.sync.debounceMs / 1000;
        syncPlugins = c.obsidian.enabled && c.obsidian.communityPlugins;
        syncPluginData = c.obsidian.pluginData;
        excludedPlugins = c.obsidian.excludePlugins.filter((id) => !EXCLUDED_PLUGINS.has(id)).join(", ");
        rawText = JSON.stringify({ ...c, obsidian: { ...c.obsidian, excludePlugins: c.obsidian.excludePlugins.filter((id) => !EXCLUDED_PLUGINS.has(id)) } }, null, 2);
    }

    async function loadConfig() {
        try {
            const doc = await api.get<ConfigDoc>("/config");
            configRev = doc.rev;
            const json = doc.blob ? JSON.parse(fromUtf8(await open(session.keys!.config, fromB64(doc.blob), aad.config(doc.rev)))) : DEFAULT_CONFIG;
            fill(normaliseConfig(json));
        } catch (e) {
            configError = describe(e);
        }
    }

    onMount(loadConfig);

    async function store(next: unknown, note: string) {
        configError = configNotice = "";
        savingConfig = true;
        try {
            const c = normaliseConfig(next);
            const rev = configRev + 1;
            const blob = toB64(await seal(session.keys!.config, utf8(JSON.stringify(c)), aad.config(rev)));
            configRev = (await api.put<{ rev: number }>("/config", { baseRev: configRev, blob })).rev;
            fill(c);
            configNotice = note;
        } catch (e) {
            configError = describe(e);
        } finally {
            savingConfig = false;
        }
    }

    function saveForm(e: SubmitEvent) {
        e.preventDefault();
        const base = $state.snapshot(config);
        void store(
            {
                ...base,
                obsidian: { ...base.obsidian, enabled: syncPlugins, communityPlugins: syncPlugins, pluginData: syncPluginData, excludePlugins: [...new Set(excludedPlugins.split(/[,，\n]/).map((id) => id.trim()).filter((id) => !!id && !EXCLUDED_PLUGINS.has(id)))] },
                exclude: [...new Set(excludes.map((x) => x.trim()).filter(Boolean))],
                sync: { ...base.sync, massChangeGuard: Math.round(guard), maxFileSizeMB: Math.round(maxMB), debounceMs: Math.round(debounceSec * 1000) },
            },
            "已保存。在线的设备会立即收到，其他设备下次连接时收到。"
        );
    }

    function saveRaw() {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText);
        } catch (e) {
            return void (configError = `不是有效的 JSON：${(e as Error).message}`);
        }
        void store(parsed, "已保存 JSON，上面的表单已更新。超出范围的值已调整，不认识的项已移除。");
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
            passNotice = "口令已修改，所有网页登录和浏览器信任已失效。";
            window.dispatchEvent(new Event("lite-sync:expired"));
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
        <h2 id="config-title">同步设置</h2>
        <span class="faint" style="font-size: 12px">所有设备共用 · 加密保存</span>
    </div>
    <form class="panel-body cfg" onsubmit={saveForm}>
        <div class="cfg-item">
            <div class="cfg-label">
                <b>不同步的文件和文件夹</b>
                <span class="hint">「私密/**」表示库根目录下的整个私密文件夹，「*.pdf」表示所有文件夹里的 PDF。回收站和 .DS_Store 总是跳过，不用填。</span>
            </div>
            <div class="cfg-control stack" style="gap: 6px">
                {#each excludes as _, i (i)}
                    <div class="cfg-ex">
                        <input class="input mono" bind:value={excludes[i]} placeholder="私密/**" spellcheck="false" aria-label="第 {i + 1} 条规则" />
                        <button type="button" class="btn btn-quiet btn-sm" aria-label="删除第 {i + 1} 条规则" onclick={() => excludes.splice(i, 1)}>✕</button>
                    </div>
                {:else}
                    <p class="faint" style="font-size: 13px">没有规则，全部同步</p>
                {/each}
                <button type="button" class="btn btn-sm" style="justify-self: start" onclick={() => excludes.push("")}>+ 添加规则</button>
            </div>
        </div>

        <label class="cfg-item">
            <span class="cfg-label">
                <b>大批量删除时先确认</b>
                <span class="hint">其他设备的一次同步要删除或覆盖本机超过这个数量的文件时，先暂停，等你在插件里确认。</span>
            </span>
            <span class="cfg-control num-wrap">超过 <input class="input num" type="number" min="1" max="100000" step="1" required bind:value={guard} /> 个文件</span>
        </label>

        <label class="cfg-item">
            <span class="cfg-label">
                <b>最大文件大小</b>
                <span class="hint">超过这个大小的文件不同步，留在原来的设备上。</span>
            </span>
            <span class="cfg-control num-wrap"><input class="input num" type="number" min="1" max="500" step="1" required bind:value={maxMB} /> MB</span>
        </label>

        <label class="cfg-item">
            <span class="cfg-label">
                <b>停止编辑后多久上传</b>
                <span class="hint">停笔这么久之后才上传，避免每敲一个字就上传一次。越短其他设备越快看到。</span>
            </span>
            <span class="cfg-control num-wrap"><input class="input num" type="number" min="0.5" max="60" step="0.5" required bind:value={debounceSec} /> 秒</span>
        </label>

        <label class="cfg-item">
            <span class="cfg-label"><b>同步插件</b><span class="hint">首次同步的设备建立插件基准。启用状态、快捷键及卸载行为只影响本机；Lite Sync 自身始终排除。</span></span>
            <span class="cfg-control check"><input type="checkbox" bind:checked={syncPlugins} />同步插件代码和版本</span>
        </label>
        <label class="cfg-item">
            <span class="cfg-label"><b>同步插件配置</b><span class="hint">加密同步各插件的 data.json。收到更新时备份本地配置，并重新加载已启用的插件。</span></span>
            <span class="cfg-control check"><input type="checkbox" bind:checked={syncPluginData} disabled={!syncPlugins} />同步配置</span>
        </label>
        <label class="cfg-item">
            <span class="cfg-label"><b>排除的插件</b><span class="hint">填写插件 ID，用逗号分隔。排除的插件仍可在插件页查看。</span></span>
            <input class="input cfg-control" bind:value={excludedPlugins} placeholder="插件 ID，多个用逗号分隔" />
        </label>

        {#if configError}<p class="error">{configError}</p>{/if}
        {#if configNotice}<p class="notice">{configNotice}</p>{/if}
        <div class="row cfg-actions">
            <button class="btn btn-primary" disabled={savingConfig}>{savingConfig ? "正在保存…" : "保存"}</button>
            <button type="button" class="btn btn-quiet" onclick={() => fill(normaliseConfig({ ...$state.snapshot(config), exclude: DEFAULT_CONFIG.exclude, sync: DEFAULT_CONFIG.sync }))}>恢复默认值</button>
        </div>
    </form>
    <details class="advanced">
        <summary>高级：直接编辑 JSON</summary>
        <div class="stack">
            <p class="hint">包含上面的同步设置、手机和电脑分开设置（overrides），以及尚未启用的其他 Obsidian 配置和历史保留设置。</p>
            <label class="field">
                <span class="sr-only">配置 JSON</span>
                <textarea rows="18" spellcheck="false" bind:value={rawText}></textarea>
            </label>
            <button type="button" class="btn" style="justify-self: start" disabled={savingConfig} onclick={saveRaw}>保存 JSON</button>
        </div>
    </details>
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
                <p class="muted" style="font-size: 14px">新浏览器首次登录需要口令和验证码，已验证浏览器后续免验证码。关闭后恢复码也会作废。</p>
                <label class="field">口令<input type="password" autocomplete="current-password" bind:value={offPass} required /></label>
                <label class="field">验证码<input class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" bind:value={offCode} required /></label>
                {#if offError}<p class="error">{offError}</p>{/if}
                <button class="btn btn-danger" style="justify-self: start" disabled={savingOff}>{savingOff ? "正在计算…" : "关闭双重认证"}</button>
            </form>
        {:else if enrolling}
            <Enrol embedded onDone={() => ((enrolling = false), (offNotice = ""))} />
        {:else}
            <p class="muted" style="font-size: 14px">
                现在登录只需要口令。开启后，新浏览器首次登录还需要 Google Authenticator 验证码。
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

<section class="panel" aria-labelledby="browser-title">
    <div class="panel-head"><h2 id="browser-title">此浏览器</h2></div>
    <div class="panel-body stack">
        <p class="muted">解锁有效期为 7 天，到期后需要重新输入口令。浏览器信任凭据最长保留一年，并在登录时续期；信任有效期间无需重复输入验证码。</p>
        <button class="btn btn-danger" style="justify-self: start" onclick={async () => {
            try { await api.post("/forget-browser"); window.dispatchEvent(new Event("lite-sync:expired")); }
            catch (e) { configError = describe(e); }
        }}>撤销此浏览器信任并退出</button>
    </div>
</section>
