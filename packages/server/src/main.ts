// Server entry point.
//
//   node src/main.ts             start the server
//   node src/main.ts setup-link  print a fresh one-time setup link (before initialisation only)
//   node src/main.ts reset-2fa   remove TOTP and recovery codes; the next login re-enrols

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer } from "ws";
import { ServerKey } from "./auth.ts";
import { createApp, issueSetupToken, reset2fa } from "./app.ts";
import { Db } from "./db.ts";

const env = process.env;
const dataDir = resolve(env.LITE_SYNC_DATA_DIR ?? "./data");
const port = Number(env.PORT ?? 28470);
const publicUrl = (env.LITE_SYNC_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
const adminDir = resolve(env.LITE_SYNC_ADMIN_DIR ?? new URL("../../admin/dist", import.meta.url).pathname);

const secret = env.LITE_SYNC_SERVER_KEY;
if (!secret) {
    console.error("LITE_SYNC_SERVER_KEY is not set. Generate one with: openssl rand -base64 48");
    process.exit(1);
}

const db = new Db(dataDir);
const serverKey = new ServerKey(secret);

function printSetupLink() {
    const token = issueSetupToken(db);
    if (!token) return false;
    console.log("\n  lite-sync is not initialised yet. Open this one-time link to set it up:\n");
    console.log(`  ${publicUrl}/admin/#/setup/${token}\n`);
    return true;
}

const command = process.argv[2];
if (command === "reset-2fa") {
    reset2fa(db);
    console.log("Two-factor authentication was reset. Sign in with the passphrase and enrol again.");
    process.exit(0);
}
if (command === "setup-link") {
    if (!printSetupLink()) console.log("The vault is already initialised.");
    process.exit(0);
}
if (command) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

const { app } = createApp({ db, serverKey, insecureCookies: env.LITE_SYNC_INSECURE_COOKIES === "1",
    eventsRoute: (events) => upgradeWebSocket(() => events()) });

if (existsSync(adminDir)) {
    app.get("/", (c) => c.redirect("/admin/"));
    app.get("/admin", (c) => c.redirect("/admin/"));
    app.use(
        "/admin/*",
        serveStatic({ root: adminDir, rewriteRequestPath: (p) => p.replace(/^\/admin/, "") || "/" })
    );
} else {
    console.warn(`Admin console not found at ${adminDir}; only the API is served.`);
}

const wss = new WebSocketServer({ noServer: true });
serve({ fetch: app.fetch, port, websocket: { server: wss } }, (info) => {
    console.log(`lite-sync listening on :${info.port}, data in ${dataDir}`);
    printSetupLink();
});

for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
        db.sql.close();
        process.exit(0);
    });
