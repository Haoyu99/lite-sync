# lite-sync

lite-sync 是一个自托管的个人 Obsidian 同步项目，由 Obsidian 插件、同步服务端和网页管理后台组成。它把多台设备上的笔记和附件同步到你自己的服务器，使用端到端加密保护文件内容和路径，并保留文件版本，方便查看历史和回滚。

适合希望自行掌握服务器和数据存储、在多台设备之间同步个人笔记库的用户。项目面向单用户使用，目前处于第一阶段开发中。

## 主要功能

- **加密同步**：文件在客户端加密后上传，服务器保存密文；网页后台在浏览器内解密。
- **多设备同步**：通过插件同步笔记与附件，使用 WebSocket 通知其他设备获取变更。
- **版本与恢复**：保留文件历史，支持单个文件回滚。
- **冲突处理**：支持三方合并、冲突副本和大批量删除保护。
- **网页管理**：查看文件、设备和活动，管理设备配对、吊销及统一配置。
- **自行部署**：提供 Docker 部署方式，支持口令登录、可选的 TOTP 双重认证和恢复码。

`.obsidian` 配置同步、整库按时间点恢复等功能尚未实现，完整范围见文末。

- 设计：[docs/design.md](docs/design.md)
- 全流程说明：[docs/flow.md](docs/flow.md)

## 目录

| 路径 | 内容 |
|---|---|
| `packages/core` | 加密、协议类型、三方合并、路径规则、统一配置（插件、服务端、后台共用） |
| `packages/server` | 同步 API、后台 API、SQLite、密文存储、TOTP |
| `packages/plugin` | Obsidian 插件，同步引擎在 `src/engine.ts` |
| `packages/admin` | 管理后台（Svelte），构建后由服务端在 `/admin` 提供 |

## 开发

```sh
npm install
npm test          # 核心、服务端、两台模拟设备的同步测试
npm run check     # 类型检查和 svelte-check
npm run build     # 构建后台和插件
```

本地试用后台：

```sh
LITE_SYNC_SERVER_KEY=$(openssl rand -base64 48) LITE_SYNC_DATA_DIR=./data \
LITE_SYNC_INSECURE_COOKIES=1 PORT=28470 npm run dev:server
# 另开一个终端
npm run build -w @lite-sync/admin
```

打开服务端日志里的初始化链接。`LITE_SYNC_INSECURE_COOKIES=1` 只用于本地 HTTP，部署时不要设置。

## 部署

前提：服务器装有 Docker，并有一个负责 HTTPS 的反向代理（例如 1Panel 的网站功能）。

```sh
git clone https://github.com/Haoyu99/lite-sync.git && cd lite-sync
cp .env.example .env
# 编辑 .env：填写 LITE_SYNC_DOMAIN，并用 openssl rand -base64 48 生成 LITE_SYNC_SERVER_KEY
docker compose up -d --build
docker logs lite-sync      # 复制里面的一次性初始化链接
```

服务只监听本机的 `127.0.0.1:28470`，端口可以在 `.env` 里用 `LITE_SYNC_PORT` 修改。在反向代理里为域名新建站点，代理到 `http://127.0.0.1:28470`，并开启 HTTPS。代理还需要满足两点：

- 支持 WebSocket，路径是 `/v1/events`。不支持时同步仍然可用，但其他设备要等每分钟一次的定时同步才能收到修改。
- 允许较大的请求。Nginx 和 OpenResty 默认只允许 1MB，超过的附件会上传失败，建议把 `client_max_body_size` 调到 `100m`。

CSP 等安全响应头由 lite-sync 自己设置，代理里不需要再加。

### 常用命令

```sh
docker exec lite-sync lite-sync setup-link   # 初始化链接丢了，重新生成（只在初始化前有效）
docker exec lite-sync lite-sync reset-2fa    # 验证码和恢复码都丢了，重置后下次登录重新绑定
```

### 备份

需要备份的是 `./data` 目录（SQLite 和密文文件）和 `.env`。备份里只有密文，可以放在任何地方。SQLite 运行在 WAL 模式，备份前先停容器，或者用 `sqlite3 data/lite-sync.db ".backup data/backup.db"`。

## 安装插件（BRAT）

1. 把仓库推到 GitHub（私有仓库也可以）。
2. 构建插件：`npm run build -w @lite-sync/plugin`。
3. 在 GitHub 上新建一个 Release，标签和 `manifest.json` 里的版本号一致（例如 `0.1.0`），上传 `packages/plugin/dist/main.js` 和 `packages/plugin/dist/manifest.json` 两个文件。
4. 在每台设备的 Obsidian 里安装 BRAT，选择「Add beta plugin」，填写仓库地址。私有仓库需要在 BRAT 设置里填一个只读的 GitHub token。
5. 启用 lite-sync，打开设置，填写服务器地址和后台生成的配对码，再输入口令。

更新插件时，修改 `manifest.json` 和 `packages/plugin/manifest.json` 的版本号，重新构建并发布新的 Release，然后在 BRAT 里手动检查更新。

## 从 LiveSync 迁移

1. 在所有设备上停用 LiveSync，并把库复制一份作为备份。
2. 在内容最全的设备上配对 lite-sync，等状态栏显示「✓ 已同步」。
3. 其他设备逐台配对。两边内容不同的文件会另存为冲突副本，不会被覆盖。
4. 在后台检查冲突副本，确认后删除，再卸载 LiveSync。

## 目前的范围（第一阶段）

已完成：加密同步、版本历史和单个文件回滚、冲突合并和冲突副本、大批量删除保护、设备配对和吊销、口令加 Google Authenticator 登录、恢复码、可开关的双重认证、统一配置。

尚未实现：`.obsidian` 配置同步、整库按时间点恢复、主密钥轮换、历史清理、明文导出。
