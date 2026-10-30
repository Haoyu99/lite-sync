// Seeds a running local server with demo data: initialises the vault, enrols TOTP, pairs four devices,
// and synchronises notes between them. For trying the admin console locally only.
//
//   node --experimental-strip-types scripts/demo-seed.ts http://localhost:8787 <setup-token>

import {
    DEFAULT_KDF,
    type Platform,
    deriveVaultKeys,
    derivePassphraseKeys,
    masterKeyProof,
    fromUtf8,
    newMasterKey,
    randomBytes,
    toB64,
    utf8,
    wrapMasterKey,
    type Bytes,
} from "@lite-sync/core";
import { currentStep, totpAt } from "../packages/server/src/auth.ts";
import { Api, type Http } from "../packages/plugin/src/api.ts";
import { type LocalFile, type StateStore, type SyncState, SyncEngine, type VaultAdapter } from "../packages/plugin/src/engine.ts";

const [base, setupToken] = process.argv.slice(2).filter((a) => a !== "--");
if (!base || !setupToken) throw new Error("usage: demo-seed.ts <base-url> <setup-token>");

const PASSPHRASE = "河马-台灯-雨伞-星期三-菠萝";
let cookie = "";

async function admin<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + "/admin/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-lite-sync": "1", "content-type": "application/json", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

const http: Http = async (req) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
};

class MemoryVault implements VaultAdapter {
    files = new Map<string, { data: Bytes; mtime: number }>();
    async list(): Promise<LocalFile[]> {
        return [...this.files].map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
    }
    async stat(path: string) {
        const f = this.files.get(path);
        return f ? { path, mtime: f.mtime, size: f.data.byteLength } : null;
    }
    async read(path: string) {
        return this.files.get(path)!.data;
    }
    async write(path: string, data: Bytes, mtime?: number) {
        this.files.set(path, { data, mtime: mtime ?? Date.now() });
        return (await this.stat(path))!;
    }
    async trash(path: string) {
        this.files.delete(path);
    }
    set(path: string, text: string) {
        this.files.set(path, { data: utf8(text), mtime: Date.now() + Math.random() });
    }
    text(path: string) {
        return fromUtf8(this.files.get(path)!.data);
    }
}

class MemoryStore implements StateStore {
    state: SyncState | null = null;
    async load() {
        return this.state;
    }
    async save(s: SyncState) {
        this.state = structuredClone(s);
    }
}

// 1. Initialise the vault and enrol TOTP.
const salt = randomBytes(16);
const pk = await derivePassphraseKeys(PASSPHRASE, salt, DEFAULT_KDF);
const mk = newMasterKey();
await admin("/setup", { setupToken, salt: toB64(salt), kdf: DEFAULT_KDF, loginKey: pk.loginKey, wrappedMk: await wrapMasterKey(pk.kek, mk), mkProof: await masterKeyProof(mk) });
const { secret } = await admin<{ secret: string }>("/totp/begin", {});
await admin("/totp/confirm", { totp: totpAt(secret, currentStep()) });
const keys = await deriveVaultKeys(mk);

// 2. Pair four devices.
async function device(name: string, platform: Platform) {
    const { code } = await admin<{ code: string }>("/pairing-codes", {});
    const { token } = await Api.pair(http, base!, { code, name, platform, clientVersion: "0.1.0" });
    const vault = new MemoryVault();
    const engine = new SyncEngine({
        api: new Api(http, base!, token),
        keys,
        vault,
        store: new MemoryStore(),
        deviceName: name,
        clientVersion: "0.1.0",
        mobile: platform === "ios",
    });
    return { engine, vault };
}

const mac = await device("Mac", "macos");
const win = await device("Windows", "windows");
const phone = await device("iPhone", "ios");
const ubuntu = await device("Ubuntu", "linux");

// 3. Notes shaped like the user's vault.
const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
for (const d of days) mac.vault.set(`1. 『📅 Daily』/${d}.md`, `# ${d}\n\n## 待办\n- [ ] 整理周报\n- [ ] 回顾同步方案\n\n## 记录\n今天主要在推进 lite-sync。\n`);
mac.vault.set("2. 『🗄️ Server』/Caddy 反向代理.md", "# Caddy 反向代理\n\n```caddy\nsync.example.com {\n    reverse_proxy lite-sync:8080\n}\n```\n\nCaddy 会自动申请证书。\n");
mac.vault.set("2. 『🗄️ Server』/Bitwarden 自建.md", "# Bitwarden 自建\n\n- 使用 Vaultwarden 镜像\n- 每天备份 data 目录\n");
mac.vault.set("3. 『🚀 AI & LLM』/Prompt 模板.md", "# Prompt 模板\n\n## 代码审查\n先说结论，再列出问题。\n\n## 翻译\n保留术语，不要意译。\n");
mac.vault.set("3. 『🚀 AI & LLM』/模型对比.md", "# 模型对比\n\n| 模型 | 用途 |\n|---|---|\n| Opus | 复杂任务 |\n| Haiku | 批量处理 |\n");
mac.vault.set("4. 『📚Learning』/SQLite WAL 模式.md", "# SQLite WAL 模式\n\nWAL 让读和写可以并发。\n\n检查点会把 WAL 写回主数据库。\n");
mac.vault.set("4. 『📚Learning』/TOTP 原理.md", "# TOTP 原理\n\n共享密钥 + 当前时间（30 秒一格）→ HMAC-SHA1 → 6 位数。\n");
mac.vault.set("6. 『🛠️Project』/lite-sync/需求.md", "# lite-sync 需求\n\n1. 四个平台都能用\n2. 服务器只存密文\n3. 每个版本都能回滚\n");
mac.vault.set("6. 『🛠️Project』/lite-sync/迁移步骤.md", "# 迁移步骤\n\n1. 所有设备停用 LiveSync\n2. 备份库\n3. 在 Mac 上首次上传\n");
mac.vault.set("8. 『Thinking』/关于工具的复杂度.md", "# 关于工具的复杂度\n\n功能越多，需要对齐的状态就越多。\n");
mac.vault.set("欢迎.md", "# 欢迎\n\n这是你的库。\n");
await mac.engine.sync();
await Promise.all([win.engine.sync(), phone.engine.sync(), ubuntu.engine.sync()]);

// 4. A week of edits from different devices, so history and diffs have something to show.
const req = "6. 『🛠️Project』/lite-sync/需求.md";
phone.vault.set(req, phone.vault.text(req) + "4. 冲突时不弹对话框\n");
await phone.engine.sync();
await mac.engine.sync();
mac.vault.set(req, mac.vault.text(req).replace("3. 每个版本都能回滚", "3. 每个版本都能回滚，回滚本身也能撤销") + "5. 支持 .obsidian 配置同步\n");
await mac.engine.sync();
await win.engine.sync();
win.vault.set(req, win.vault.text(req) + "6. 后台要能看到每台设备的状态\n");
await win.engine.sync();

const daily = "1. 『📅 Daily』/2026-10-30.md";
await phone.engine.sync();
phone.vault.set(daily, phone.vault.text(daily).replace("- [ ] 回顾同步方案", "- [x] 回顾同步方案") + "\n下午在地铁上补了几条想法。\n");
await phone.engine.sync();

const caddy = "2. 『🗄️ Server』/Caddy 反向代理.md";
await ubuntu.engine.sync();
ubuntu.vault.set(caddy, ubuntu.vault.text(caddy) + "\n部署时记得放行 443 端口。\n");
await ubuntu.engine.sync();

// A deletion which can be restored from the console.
await mac.engine.sync();
await mac.vault.trash("3. 『🚀 AI & LLM』/模型对比.md");
await mac.engine.noteDeleted("3. 『🚀 AI & LLM』/模型对比.md");
await mac.engine.sync();

await Promise.all([mac.engine.sync(), win.engine.sync(), phone.engine.sync()]);
// Ubuntu stays behind on purpose, to show a device which has not caught up.
mac.vault.set("1. 『📅 Daily』/2026-10-31.md", "# 2026-10-31\n\n## 待办\n- [ ] 部署 lite-sync\n");
await mac.engine.sync();
await Promise.all([win.engine.sync(), phone.engine.sync()]);

console.log(JSON.stringify({ passphrase: PASSPHRASE, totpSecret: secret }));
