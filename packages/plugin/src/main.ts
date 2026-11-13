// Obsidian integration: vault adapter, events, WebSocket notifications, status bar, and settings.

import {
    type App,
    Modal,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    normalizePath,
    requestUrl,
} from "obsidian";
import {
    type Bytes,
    type Platform as DevicePlatform,
    type VaultKeys,
    DecryptError,
    derivePassphraseKeys,
    deriveVaultKeys,
    fromB64,
    toB64,
    unwrapMasterKey,
    seal,
    utf8,
    pluginInventoryAad,
} from "@lite-sync/core";
import { Api, ApiError, type Http, normaliseBaseUrl } from "./api.ts";
import { type LocalFile, type StateStore, type SyncState, type SyncStatus, SyncEngine, type VaultAdapter } from "./engine.ts";

import { PluginSync, type PluginSyncState } from "./plugin-sync.ts";
import { PluginFiles, type PluginRuntime } from "./plugin-files.ts";
import { collectPlugins } from "./plugins.ts";
import { SyncNotice } from "./sync-notice.ts";

const VERSION = "0.2.2";
const MK_STORAGE_KEY = "lite-sync-mk";

interface Settings {
    serverUrl: string;
    deviceName: string;
    token: string;
    deviceId: string;
}

const DEFAULT_SETTINGS: Settings = { serverUrl: "", deviceName: "", token: "", deviceId: "" };

const http: Http = async (req) => {
    const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body ? (req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength) as ArrayBuffer) : undefined,
        throw: false,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
    return { status: res.status, headers, body: new Uint8Array(res.arrayBuffer) };
};

function devicePlatform(): DevicePlatform {
    if (Platform.isIosApp) return "ios";
    if (Platform.isAndroidApp) return "android";
    if (Platform.isMacOS) return "macos";
    if (Platform.isWin) return "windows";
    if (Platform.isLinux) return "linux";
    return "unknown";
}

function defaultDeviceName(): string {
    return { ios: "iPhone", android: "Android", macos: "Mac", windows: "Windows", linux: "Linux", unknown: "设备" }[devicePlatform()];
}

class ObsidianVault implements VaultAdapter {
    private app: App;
    constructor(app: App) {
        this.app = app;
    }

    async list(): Promise<LocalFile[]> {
        return this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
    }

    async exists(path: string): Promise<boolean> {
        return !!this.app.vault.getAbstractFileByPath(normalizePath(path));
    }

    async stat(path: string): Promise<LocalFile | null> {
        const f = this.app.vault.getFileByPath(normalizePath(path));
        return f ? { path: f.path, mtime: f.stat.mtime, size: f.stat.size } : null;
    }

    async read(path: string): Promise<Bytes> {
        const f = this.app.vault.getFileByPath(normalizePath(path));
        if (!f) throw new Error(`File not found: ${path}`);
        return new Uint8Array(await this.app.vault.readBinary(f));
    }

    async write(path: string, data: Bytes, mtime?: number): Promise<LocalFile> {
        const p = normalizePath(path);
        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        const opts = mtime ? { mtime } : undefined;
        const existing = this.app.vault.getFileByPath(p);
        if (existing) await this.app.vault.modifyBinary(existing, buf, opts);
        else {
            const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
            if (dir && !this.app.vault.getFolderByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
            await this.app.vault.createBinary(p, buf, opts);
        }
        return (await this.stat(p))!;
    }

    async trash(path: string): Promise<void> {
        const f = this.app.vault.getFileByPath(normalizePath(path));
        // Uses Obsidian's configured deletion behaviour, so the file goes to the system or vault trash.
        if (f) await this.app.fileManager.trashFile(f);
    }
}

// Sync state lives in IndexedDB, outside the vault, so iCloud and other tools never copy it to another device.
class IdbStore implements StateStore {
    private name: string;
    private connection: Promise<IDBDatabase> | null = null;
    constructor(vaultId: string) { this.name = `lite-sync-${vaultId}`; }
    private db(): Promise<IDBDatabase> {
        return this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(this.name, 1);
            req.onupgradeneeded = () => req.result.createObjectStore("kv");
            req.onsuccess = () => {
                req.result.onversionchange = () => { req.result.close(); this.connection = null; };
                resolve(req.result);
            };
            req.onerror = () => { this.connection = null; reject(req.error); };
        });
    }
    async close() {
        const connection = this.connection;
        this.connection = null;
        (await connection)?.close();
    }
    private async read<T>(key: string): Promise<T | null> {
        const db = await this.db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("kv");
            const req = tx.objectStore("kv").get(key);
            tx.oncomplete = () => resolve((req.result as T | undefined) ?? null);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("同步索引读取中断"));
        });
    }
    private async write(key: string, value: SyncState | PluginSyncState) {
        const db = await this.db();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("kv", "readwrite");
            tx.objectStore("kv").put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("同步索引保存中断"));
        });
    }
    load() { return this.read<SyncState>("state"); }
    save(state: SyncState) { return this.write("state", state); }
    loadPlugins() { return this.read<PluginSyncState>("plugins"); }
    savePlugins(state: PluginSyncState) { return this.write("plugins", state); }
    async clear(): Promise<void> {
        await this.close();
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(this.name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error("同步索引仍被其他窗口使用，请关闭其他窗口后重试"));
        });
    }
}

const PHASE_LABEL: Record<SyncStatus["phase"], string> = {
    idle: "✓ 已同步",
    syncing: "⟳ 同步中",
    offline: "⚠ 离线",
    error: "⚠ 同步出错",
    "needs-confirm": "⚠ 需确认",
    revoked: "⚠ 设备已吊销",
};

export default class LiteSyncPlugin extends Plugin {
    settings: Settings = { ...DEFAULT_SETTINGS };
    engine: SyncEngine | null = null;
    private store: IdbStore | null = null;
    private statusEl: HTMLElement | null = null;
    private debounce: number | null = null;
    private ws: WebSocket | null = null;
    private wsRetry = 0;
    private wsTimer: number | null = null;
    private lastEdit = new Map<string, number>();
    private feedback = new SyncNotice((message) => new Notice(`lite-sync: ${message}`, 0));
    private firstSyncComplete = false;
    private inventoryBusy = false;
    private pluginSync: PluginSync | null = null;
    private pluginProgress = "";
    private syncRunning: Promise<void> | null = null;
    private syncAgain = false;
    private lastScan = 0;
    private pluginProblem = "";
    private inventoryJson = "";
    private logLines: string[] = [];

    async onload() {
        this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<Settings> | null) };
        if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName();
        this.store = new IdbStore(this.app.vault.getName() + "-" + (this.app as unknown as { appId?: string }).appId);

        this.statusEl = this.addStatusBarItem();
        this.statusEl.addClass("mod-clickable");
        this.statusEl.onClickEvent(() => this.onStatusClick());
        this.renderStatus();

        this.addSettingTab(new LiteSyncSettingTab(this.app, this));
        this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncAll(true) });
        this.addCommand({ id: "confirm-mass-change", name: "确认大批量删除或覆盖", callback: () => this.confirmMassChange() });
        this.addCommand({ id: "show-log", name: "显示同步日志", callback: () => this.showLog() });

        // Registered once here, because start() runs again after unlocking or re-pairing.
        this.registerInterval(window.setInterval(() => {
            if (Date.now() - this.lastScan >= (this.engine?.settings.sync.configScanSeconds ?? 30) * 1000) void this.syncAll();
        }, 5000));
        this.registerDomEvent(document, "visibilitychange", () => {
            if (document.visibilityState !== "visible" || !this.engine) return;
            void this.syncAll();
            if (!this.ws) this.connectSocket();
        });

        this.app.workspace.onLayoutReady(async () => {
            this.registerVaultEvents();
            await this.start();
        });
    }

    onunload() {
        this.engine = null;
        this.pluginSync = null;
        this.feedback.clear();
        void this.store?.close();
        this.stopSocket();
        if (this.debounce) window.clearTimeout(this.debounce);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private log(msg: string) {
        const line = `${new Date().toLocaleTimeString()} ${msg}`;
        this.logLines.push(line);
        if (this.logLines.length > 300) this.logLines.shift();
        console.debug("[lite-sync]", msg);
    }

    get paired(): boolean {
        return !!(this.settings.serverUrl && this.settings.token);
    }

    get unlocked(): boolean {
        return !!this.app.loadLocalStorage(MK_STORAGE_KEY);
    }

    private api(): Api {
        return new Api(http, this.settings.serverUrl, this.settings.token);
    }

    // Builds the engine once the device is paired and holds the master key.
    async start() {
        this.stopSocket();
        this.engine = null;
        this.pluginSync = null;
        this.feedback.clear();
        const mk = this.app.loadLocalStorage(MK_STORAGE_KEY) as string | null;
        if (!this.paired || !mk) return this.renderStatus();
        let keys: VaultKeys;
        try {
            keys = await deriveVaultKeys(fromB64(mk));
        } catch {
            this.app.saveLocalStorage(MK_STORAGE_KEY, null);
            return this.renderStatus();
        }
        this.firstSyncComplete = false;
        this.pluginProblem = "";
        this.inventoryJson = "";
        this.engine = new SyncEngine({
            api: this.api(),
            keys,
            vault: new ObsidianVault(this.app),
            store: this.store!,
            deviceName: this.settings.deviceName,
            clientVersion: VERSION,
            mobile: Platform.isMobile,
            isBusy: (p) => this.isBusy(p),
            windows: Platform.isWin,
            log: (m) => this.log(m),
            onStatus: (s) => { if (this.engine?.status === s) this.onStatus(s); },
        });
        // Plugin lifecycle operations are isolated behind a checked compatibility boundary.
        // Obsidian exposes this manager at runtime; it is not part of the public App typings.
        const manager = (this.app as unknown as { plugins?: {
            plugins: Record<string, unknown>;
            unloadPlugin?: (id: string) => Promise<void>;
            loadPlugin?: (id: string) => Promise<void>;
            loadManifests?: () => Promise<void>;
        } }).plugins;
        const runtime: PluginRuntime = {
            loaded: (id) => {
                if (!manager?.plugins) throw new Error("当前 Obsidian 不支持安全安装插件");
                return !!manager.plugins[id];
            },
            pause: async (id) => {
                if (!manager?.unloadPlugin || !manager?.loadPlugin) throw new Error("当前 Obsidian 无法安全重载插件，请先停用要更新的插件后重试");
                await manager.unloadPlugin(id);
            },
            resume: async (id) => {
                await manager?.loadManifests?.();
                await manager?.loadPlugin?.(id);
            },
        };
        const pluginFiles = new PluginFiles(this.app.vault.adapter, this.app.vault.configDir, runtime);
        try { await pluginFiles.recover(); }
        catch (e) { this.log(String(e)); new Notice(`lite-sync: ${String(e)}`, 10000); return; }
        this.pluginSync = new PluginSync({
            api: this.api(), keys, deviceId: this.settings.deviceId, mobile: Platform.isMobile,
            host: pluginFiles, load: () => this.store!.loadPlugins(), save: (state) => this.store!.savePlugins(state),
            progress: (message, active = true) => {
                this.pluginProgress = message;
                if (active || !this.firstSyncComplete) this.feedback.progress(message);
                this.renderStatus();
            },
            log: (message) => this.log(message),
        });
        this.connectSocket();
        void this.syncAll();
    }

    syncAll(manual = false): Promise<void> {
        if (this.syncRunning) { this.syncAgain = true; return this.syncRunning; }
        this.syncRunning = (async () => {
            do {
                this.syncAgain = false;
                this.lastScan = Date.now();
                const engine = this.engine;
                const plugins = this.pluginSync;
                if (!engine) return;
                this.feedback.begin();
                this.pluginProgress = "";
                this.pluginProblem = "";
                await engine.sync();
                if (this.engine !== engine) continue;
                let pluginSummary = "";
                if (plugins && ["idle", "needs-confirm"].includes(engine.status.phase)) {
                    this.pluginProgress = "正在检查插件";
                    this.renderStatus();
                    try {
                        const result = await plugins.sync(engine.settings);
                        this.pluginProblem = result.waiting ? "插件同步等待首台设备或并发修改，下次重试" : "";
                        if (result.uploaded || result.applied) pluginSummary = `；插件上传 ${result.uploaded}，安装 / 更新 ${result.applied}${result.conflicts ? `，${result.conflicts} 处冲突已备份` : ""}。新插件请在本机设置中启用`;
                        if (result.waiting) this.log(this.pluginProblem);
                    } catch (e) {
                        this.pluginProblem = `插件同步未完成: ${String(e)}`;
                        this.log(this.pluginProblem);
                    }
                }
                if (this.engine !== engine) continue;
                const s = engine.status;
                const changed = s.uploaded + s.downloaded + s.updated + s.deleted > 0 || !!pluginSummary;
                const problem = s.message || this.pluginProblem || (s.pending ? `${s.pending} 个文件等待下一次同步` : "");
                const complete = s.phase === "idle" && !problem;
                const summary = complete ? `同步完成 · 上传 ${s.uploaded}，下载 ${s.downloaded}，更新 ${s.updated}，删除 ${s.deleted}${pluginSummary}`
                    : `同步未完成 · ${[s.message, this.pluginProblem, !s.message && s.pending ? `${s.pending} 个文件等待下一次同步` : ""].filter(Boolean).join("；")}${pluginSummary}`;
                this.feedback.finish(!complete || !this.firstSyncComplete || manual || changed ? summary : null);
                if (complete) this.firstSyncComplete = true;
                this.pluginProgress = "";
                await this.reportPlugins();
            } while (this.syncAgain);
        })().finally(() => { this.syncRunning = null; this.renderStatus(); });
        return this.syncRunning;
    }

    private async reportPlugins() {
        if (!this.engine || this.inventoryBusy) return;
        this.inventoryBusy = true;
        const deviceId = this.settings.deviceId;
        const engine = this.engine;
        try {
            const json = JSON.stringify(await collectPlugins(this.app.vault.adapter, this.app.vault.configDir));
            if (json === this.inventoryJson) return;
            const mk = this.app.loadLocalStorage(MK_STORAGE_KEY) as string;
            const keys = await deriveVaultKeys(fromB64(mk));
            const blob = toB64(await seal(keys.config, utf8(json), pluginInventoryAad(deviceId)));
            if (this.engine !== engine || this.settings.deviceId !== deviceId) return;
            await this.api().reportPlugins(blob);
            if (this.engine === engine) this.inventoryJson = json;
        } catch (e) {
            this.log(`插件清单暂未更新，下次重试: ${String(e)}`);
        } finally {
            this.inventoryBusy = false;
        }
    }

    private registerVaultEvents() {
        const schedule = () => {
            if (!this.engine) return;
            if (this.debounce) window.clearTimeout(this.debounce);
            this.debounce = window.setTimeout(() => void this.syncAll(), this.engine.settings.sync.debounceMs);
        };
        this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && schedule()));
        this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && schedule()));
        this.registerEvent(
            this.app.vault.on("delete", (f) => {
                void this.engine?.noteDeleted(f.path).then(schedule);
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", (f, oldPath) => {
                void this.engine?.noteRenamed(oldPath, f.path).then(schedule);
            })
        );
        this.registerEvent(
            this.app.workspace.on("editor-change", (_e, info) => {
                if (info.file) this.lastEdit.set(info.file.path, Date.now());
            })
        );
    }

    // Avoids replacing a note while the user is typing in it.
    private isBusy(path: string): boolean {
        const at = this.lastEdit.get(path.normalize("NFC")) ?? this.lastEdit.get(path);
        return at !== undefined && Date.now() - at < 5000;
    }

    private connectSocket() {
        if (!this.engine || this.ws) return;
        const url = normaliseBaseUrl(this.settings.serverUrl).replace(/^http/, "ws") + "/v1/events";
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            return this.retrySocket();
        }
        this.ws = ws;
        ws.onopen = () => {
            this.wsRetry = 0;
            ws.send(JSON.stringify({ token: this.settings.token }));
        };
        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(String(ev.data)) as { head?: number; config?: number };
                if ((msg.head !== undefined && this.engine && msg.head > this.engine.cursor) || msg.config !== undefined)
                    void this.syncAll();
            } catch {
                /* ignore malformed messages */
            }
        };
        ws.onclose = () => {
            if (this.ws === ws) this.ws = null;
            this.retrySocket();
        };
    }

    private retrySocket() {
        if (!this.engine || this.wsTimer) return;
        const delay = Math.min(60_000, 1000 * 2 ** this.wsRetry++);
        this.wsTimer = window.setTimeout(() => {
            this.wsTimer = null;
            this.connectSocket();
        }, delay);
    }

    private stopSocket() {
        if (this.wsTimer) window.clearTimeout(this.wsTimer);
        this.wsTimer = null;
        const ws = this.ws;
        this.ws = null;
        ws?.close();
    }

    private onStatus(s: SyncStatus) {
        this.renderStatus();
        if (s.phase === "syncing") {
            // Inspecting unchanged local files does not open a progress notification.
            const hasWork = s.uploaded + s.downloaded + s.updated + s.deleted > 0
                || (!!s.progress?.path && s.progress.action !== "正在检查");
            if (!this.firstSyncComplete || hasWork) this.feedback.progress(this.progressText(s));
        }
        if (s.phase === "revoked") this.stopSocket();
    }

    private progressText(s: SyncStatus): string {
        const p = s.progress;
        if (!p) return "正在同步…";
        return `${p.action}${p.total ? ` ${p.completed}/${p.total}` : ""}${p.path ? ` · ${p.path}` : ""}`;
    }

    renderStatus() {
        if (!this.statusEl) return;
        if (!this.paired) return void this.statusEl.setText("lite-sync: 未配对");
        if (!this.engine) return void this.statusEl.setText("lite-sync: 未解锁");
        const s = this.engine.status;
        let text = this.pluginProgress ? `⟳ ${this.pluginProgress}` : s.phase === "syncing" ? `⟳ ${this.progressText(s)}` : s.phase === "idle" && s.pending ? "⏳ 等待同步" : PHASE_LABEL[s.phase];
        if (s.pending > 0 && s.phase !== "syncing") text += ` ↑${s.pending}`;
        if (s.conflicts.length > 0) text += ` · ${s.conflicts.length} 个冲突副本`;
        if (!this.pluginProgress && s.phase !== "syncing" && this.pluginProblem) text += " · ⚠ 插件待同步";
        this.statusEl.setText(text);
        this.statusEl.setAttr("aria-label", this.pluginProblem || s.message || (s.lastSyncAt ? `上次同步 ${new Date(s.lastSyncAt).toLocaleTimeString()}` : ""));
    }

    private onStatusClick() {
        const s = this.engine?.status;
        if (s?.phase === "needs-confirm") return this.confirmMassChange();
        if (this.pluginProblem || s?.message) new Notice(`lite-sync: ${this.pluginProblem || s?.message}`);
        void this.syncAll(true);
    }

    confirmMassChange() {
        const s = this.engine?.status;
        if (!s || s.phase !== "needs-confirm") return void new Notice("lite-sync: 没有等待确认的变更");
        new ConfirmModal(this.app, `其他设备的同步将删除或覆盖本机 ${s.guardCount} 个未修改的文件。服务器保留所有历史版本，可以在后台恢复。继续吗？`, () => {
            this.engine?.confirmMassChange();
            void this.syncAll();
        }).open();
    }

    showLog() {
        new LogModal(this.app, this.logLines.length ? this.logLines.join("\n") : "暂无日志").open();
    }

    // ---- setup actions used by the settings tab ---------------------------------------------

    async pair(code: string) {
        // A master key or sync index left from an earlier pairing belongs to another vault or server.
        this.stopSocket();
        this.engine = null;
        this.pluginSync = null;
        this.feedback.clear();
        this.app.saveLocalStorage(MK_STORAGE_KEY, null);
        await this.store?.clear();
        const res = await Api.pair(http, this.settings.serverUrl, {
            code,
            name: this.settings.deviceName,
            platform: devicePlatform(),
            clientVersion: VERSION,
        });
        this.settings.token = res.token;
        this.settings.deviceId = res.deviceId;
        await this.saveSettings();
    }

    async unlock(passphrase: string) {
        const v = await this.api().vault();
        const pk = await derivePassphraseKeys(passphrase, fromB64(v.salt), v.kdf);
        const mk = await unwrapMasterKey(pk.kek, v.wrappedMk); // throws DecryptError on a wrong passphrase
        this.app.saveLocalStorage(MK_STORAGE_KEY, toB64(mk));
        await this.start();
    }

    async unpair() {
        this.stopSocket();
        this.engine = null;
        this.pluginSync = null;
        this.feedback.clear();
        this.app.saveLocalStorage(MK_STORAGE_KEY, null);
        await this.store?.clear();
        this.settings = { ...DEFAULT_SETTINGS, deviceName: this.settings.deviceName, serverUrl: this.settings.serverUrl };
        await this.saveSettings();
        this.renderStatus();
    }
}

function describeError(e: unknown): string {
    if (e instanceof DecryptError) return "口令不正确";
    if (e instanceof ApiError) {
        const map: Record<string, string> = {
            invalid_code: "配对码无效或已过期",
            rate_limited: "尝试次数过多，请稍后再试",
            bad_totp: "验证码不正确",
            locked: "尝试次数过多，已临时锁定 15 分钟",
            unauthorised: "设备令牌无效或已被吊销",
            not_initialised: "服务器尚未初始化",
            server: "服务器暂时不可用",
        };
        return map[e.code] ?? `服务器返回错误 (${e.status} ${e.code})`;
    }
    return e instanceof Error ? e.message : String(e);
}

class ConfirmModal extends Modal {
    private text: string;
    private onYes: () => void;
    constructor(app: App, text: string, onYes: () => void) {
        super(app);
        this.text = text;
        this.onYes = onYes;
    }
    onOpen() {
        this.titleEl.setText("lite-sync");
        this.contentEl.createEl("p", { text: this.text });
        new Setting(this.contentEl)
            .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
            .addButton((b) =>
                b.setButtonText("继续").setWarning().onClick(() => {
                    this.close();
                    this.onYes();
                })
            );
    }
}

class LogModal extends Modal {
    private text: string;
    constructor(app: App, text: string) {
        super(app);
        this.text = text;
    }
    onOpen() {
        this.titleEl.setText("lite-sync 日志");
        const pre = this.contentEl.createEl("pre", { text: this.text });
        pre.style.whiteSpace = "pre-wrap";
        pre.style.maxHeight = "60vh";
        pre.style.overflow = "auto";
        pre.style.fontSize = "12px";
    }
}

class LiteSyncSettingTab extends PluginSettingTab {
    private plugin: LiteSyncPlugin;

    constructor(app: App, plugin: LiteSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl: el } = this;
        const p = this.plugin;
        el.empty();

        const run = async (btn: { setDisabled(d: boolean): unknown }, fn: () => Promise<void>, ok?: string) => {
            btn.setDisabled(true);
            try {
                await fn();
                if (ok) new Notice(ok);
                this.display();
            } catch (e) {
                new Notice(`lite-sync: ${describeError(e)}`, 8000);
            } finally {
                btn.setDisabled(false);
            }
        };

        if (!p.paired) {
            new Setting(el).setName("第一步：配对").setHeading();
            new Setting(el)
                .setName("服务器地址")
                .setDesc("例如 https://sync.example.com")
                .addText((t) =>
                    t.setValue(p.settings.serverUrl).onChange(async (v) => {
                        p.settings.serverUrl = normaliseBaseUrl(v);
                        await p.saveSettings();
                    })
                );
            new Setting(el)
                .setName("设备名")
                .setDesc("显示在后台和冲突副本的文件名里")
                .addText((t) =>
                    t.setValue(p.settings.deviceName).onChange(async (v) => {
                        p.settings.deviceName = v.trim() || defaultDeviceName();
                        await p.saveSettings();
                    })
                );
            let code = "";
            new Setting(el)
                .setName("配对码")
                .setDesc("在后台点「添加设备」获得，10 分钟内有效")
                .addText((t) => t.setPlaceholder("K7QM-29XD").onChange((v) => (code = v)))
                .addButton((b) =>
                    b.setButtonText("配对").setCta().onClick(() => {
                        if (!/^https?:\/\//.test(p.settings.serverUrl)) return void new Notice("请先填写以 https:// 开头的服务器地址");
                        void run(b, () => p.pair(code), "配对成功，请输入口令解锁");
                    })
                );
            return;
        }

        if (!p.unlocked) {
            new Setting(el).setName("第二步：输入口令").setHeading();
            el.createEl("p", {
                text: "口令只在本机用于解开主密钥，不会发送到服务器。解锁后主密钥保存在本机，之后不再需要输入。",
                cls: "setting-item-description",
            });
            let pass = "";
            new Setting(el)
                .setName("口令")
                .addText((t) => {
                    t.inputEl.type = "password";
                    t.inputEl.autocomplete = "current-password";
                    t.onChange((v) => (pass = v));
                })
                .addButton((b) => b.setButtonText("解锁").setCta().onClick(() => void run(b, () => p.unlock(pass), "已解锁，开始同步")));
            this.dangerZone(el, run);
            return;
        }

        const s = p.engine?.status;
        new Setting(el).setName("同步").setHeading();
        new Setting(el)
            .setName("状态")
            .setDesc(
                s
                    ? `${PHASE_LABEL[s.phase]}${s.pending ? `，${s.pending} 个待同步` : ""}${s.lastSyncAt ? `，上次同步 ${new Date(s.lastSyncAt).toLocaleString()}` : ""}${s.message ? `。${s.message}` : ""}`
                    : "未启动"
            )
            .addButton((b) => b.setButtonText("立即同步").setCta().onClick(() => void run(b, async () => p.syncAll(true))))
            .addButton((b) => b.setButtonText("日志").onClick(() => p.showLog()));
        if (s?.phase === "needs-confirm")
            new Setting(el)
                .setName("等待确认")
                .setDesc(s.message ?? "")
                .addButton((b) => b.setButtonText("确认").setWarning().onClick(() => p.confirmMassChange()));
        if (s && s.conflicts.length > 0) {
            const c = new Setting(el).setName("本次生成的冲突副本").setDesc("对比后保留需要的内容，再删除副本。");
            const list = c.descEl.createEl("ul");
            for (const path of s.conflicts) list.createEl("li", { text: path });
        }
        new Setting(el).setName("服务器").setDesc(`${p.settings.serverUrl} · 设备「${p.settings.deviceName}」`);
        new Setting(el)
            .setName("重新检查所有文件")
            .setDesc("从头比对服务器和本地的每个文件。不会覆盖本地修改，两边不同时生成冲突副本。")
            .addButton((b) =>
                b.setButtonText("重新检查").onClick(() =>
                    void run(b, async () => {
                        await p.engine?.rescan();
                        await p.syncAll();
                    }, "已完成重新检查")
                )
            );

        this.dangerZone(el, run);
    }

    private dangerZone(el: HTMLElement, run: (b: { setDisabled(d: boolean): unknown }, fn: () => Promise<void>, ok?: string) => Promise<void>) {
        new Setting(el).setName("解除配对").setHeading();
        new Setting(el)
            .setName("解除本机配对")
            .setDesc("删除本机的设备令牌、主密钥和同步索引。库里的文件和服务器上的数据都不受影响。")
            .addButton((b) =>
                b.setButtonText("解除配对").setWarning().onClick(() =>
                    new ConfirmModal(this.app, "确定解除本机配对吗？之后需要新的配对码和口令才能再次同步。", () => void run(b, () => this.plugin.unpair(), "已解除配对")).open()
                )
            );
    }
}
