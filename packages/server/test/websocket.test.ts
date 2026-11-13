import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "../src/app.ts";
import { Db } from "../src/db.ts";
import { ServerKey, newToken, sha256Hex } from "../src/auth.ts";

it("upgrades without HTTP credentials, authenticates the first message and sends notifications", { timeout: 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lite-sync-ws-"));
    const db = new Db(dir);
    const token = newToken();
    db.run("INSERT INTO devices(id,name,platform,client_version,token_hash,created_at) VALUES('test','Test','linux','0.2.0',?,0)", sha256Hex(token));
    const { app, notify, sockets } = createApp({ db, serverKey: new ServerKey("x".repeat(40)),
        eventsRoute: (events) => upgradeWebSocket(() => events()) });
    const wss = new WebSocketServer({ noServer: true });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } });
    const clients: WebSocket[] = [];
    try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const url = `ws://127.0.0.1:${address.port}/v1/events`;
        assert.equal((await app.request("/v1/vault")).status, 401, "ordinary device APIs still require a Bearer header");
        const connect = async () => {
            const client = new WebSocket(url);
            clients.push(client);
            await once(client, "open");
            return client;
        };
        const client = await connect();
        assert.equal(sockets.size, 0, "unauthenticated connections do not receive notifications");
        const initial = once(client, "message");
        client.send(JSON.stringify({ token }));
        assert.deepEqual(JSON.parse(String((await initial)[0])), { head: 0 });
        assert.equal(sockets.size, 1);
        const changed = once(client, "message");
        db.put({ id: "a".repeat(64), baseRev: 0, deviceId: null }, "meta", Buffer.alloc(64));
        notify();
        assert.deepEqual(JSON.parse(String((await changed)[0])), { head: 1 });
        const invalid = await connect();
        const invalidClosed = once(invalid, "close");
        invalid.send(JSON.stringify({ token: "invalid" }));
        assert.equal((await invalidClosed)[0], 4401);
        db.run("UPDATE devices SET revoked_at = 1 WHERE id = 'test'");
        const revoked = await connect();
        const revokedClosed = once(revoked, "close");
        revoked.send(JSON.stringify({ token }));
        assert.equal((await revokedClosed)[0], 4401);
    } finally {
        for (const client of clients) client.terminate();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        db.sql.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
