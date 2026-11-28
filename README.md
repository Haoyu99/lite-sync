# Lite Sync

English · [简体中文](README.zh-CN.md)

Sync your Obsidian vault across devices through your own server. File contents and paths are encrypted on the client before upload. The server stores encrypted objects and version history, and provides a web admin interface. Lite Sync supports conflict copies, three-way text merging, device pairing and revocation, and optional TOTP for the admin interface.

This is an early-development, single-user project. Test it with a separate vault and keep independent backups before using it for important notes. Desktop and mobile are declared supported; automated tests use simulated devices and do not replace testing on real Obsidian clients.

## Requirements and disclosures

- **Hosting and accounts.** Deploy the included server with Docker and an HTTPS reverse proxy. You provide hosting, storage, and a domain. There is no developer-operated sync service, developer account, or paid subscription. Set an admin passphrase, generate a pairing code, and unlock each device with the passphrase.
- **Network.** The plugin connects to the server URL you configure using HTTPS and WebSocket for pairing, encrypted sync, version history, and status reporting. It does not use advertising, analytics, or telemetry services. Obsidian or BRAT may contact GitHub to install or update plugins.
- **Data sent to the server.** The client encrypts notes, attachments, paths, plugin inventory, and plugin bundles before upload. The server can see operational metadata such as device names, platforms, client versions, device IDs, sync times, sizes, versions, and activity records. The server and reverse proxy can observe connection IP addresses. The operator controls server data and logs.
- **Local storage.** The plugin reads and writes the current vault and its configuration directory. Obsidian's local storage holds the unlocked master key, plugin settings hold the device token, and IndexedDB holds sync indexes. Unpairing clears these local credentials and indexes. The plugin does not scan user files outside the vault.
- **Community plugin sync.** New servers enable plugin code and configuration sync by default. Standard plugin files (`main.js`, `manifest.json`, optional `styles.css` and `data.json`) are encrypted and copied between devices. Other plugins' settings may contain credentials. Enable newly copied plugins on each device where you want to use them. Lite Sync unloads and reloads already-enabled plugins when their files are updated. Use the web admin to disable plugin sync, disable settings sync, or exclude plugin IDs. Lite Sync and LiveSync are excluded.
- **Development releases.** Future test releases that change the server schema may require reinitializing server data according to their release notes. Normal server restarts preserve existing data.

## Deploy your server

1. Install Docker and configure a domain with an HTTPS reverse proxy.
2. Clone `https://github.com/Haoyu99/lite-sync.git` and enter the repository.
3. Copy `.env.example` to `.env`. Set `LITE_SYNC_DOMAIN` and generate `LITE_SYNC_SERVER_KEY` using `openssl rand -base64 48`.
4. Run `docker compose up -d --build`.
5. Proxy your HTTPS domain to `http://127.0.0.1:28470`. Enable WebSocket support for `/v1/events` and a sufficient request size (for example `client_max_body_size 100m` with Nginx).
6. Run `docker logs lite-sync` and open the one-time initialization link. Set the admin passphrase and configure authentication.

Back up both the server's `data` directory and `.env`. Stop the container or use SQLite's backup command to obtain a consistent database backup. Do not run multiple sync tools on the same vault concurrently.

## Install and pair the plugin

Install the plugin from GitHub Releases or through BRAT.

1. In Obsidian, install BRAT and use **Add beta plugin** with `https://github.com/Haoyu99/lite-sync`.
2. Alternatively, download the plugin ZIP from [Releases](https://github.com/Haoyu99/lite-sync/releases), extract the plugin files to `<vault>/<configDir>/plugins/lite-sync/` (normally `.obsidian/plugins/lite-sync/`), and enable Lite Sync. GitHub's automatic source archives are not installable plugins.
3. Open Lite Sync settings. Enter the HTTPS server URL (**服务器地址**) and a device name (**设备名**).
4. Generate a pairing code with **添加设备** in the web admin, enter it as **配对码**, and select **配对**.
5. Enter the vault passphrase (**口令**) and select **解锁**. The first sync starts automatically. The current plugin interface is in Chinese.
6. Pair additional devices one at a time. Files with divergent changes can produce conflict copies. Review sync status and the admin interface before removing any independent backups.

Use **立即同步** to sync immediately and **显示同步日志** to inspect recent local sync logs. Devices poll periodically and also receive WebSocket notifications while connected. Mobile operating systems may suspend Obsidian in the background.

Updates are available through BRAT or by replacing the release's plugin files while preserving `data.json`. If Lite Sync appears in Obsidian's community plugin browser, you can install and update it there.

## Update an existing server

Version 0.2.6 updates the Hono server dependencies. Pull the updated repository and run `docker compose up -d --build` on the server to apply the security fixes. Keep your existing `.env` and `data` directory. Devices can keep their existing pairing.

## Develop and verify

Use Node.js 24. Run `npm ci`, then `npm test`, `npm run check`, `npm run lint:plugin`, and `npm run build` from the repository root.

## Source and license

The repository contains `packages/plugin` (Obsidian integration), `packages/core` (shared protocol and cryptography), `packages/server`, and `packages/admin`. Read the [sync behavior](docs/plugin-sync.md), [design](docs/design.md), and [community submission guide](docs/community-submission.md).

Licensed under the [MIT License](LICENSE). Bundled dependencies retain their licenses. See the [third-party notices](THIRD_PARTY_NOTICES.md).
