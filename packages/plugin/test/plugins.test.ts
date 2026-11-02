import assert from "node:assert/strict";
import { it } from "node:test";
import { collectPlugins } from "../src/plugins.ts";
import { deriveVaultKeys, newMasterKey, seal, open, utf8, fromUtf8, parsePluginInventory, pluginInventoryAad } from "@lite-sync/core";

it("collects installed/enabled plugins in a custom config directory without reading settings or itself", async () => {
    const data: Record<string, string> = {
        "settings/community-plugins.json": JSON.stringify(["lite-sync", "calendar"]),
        "settings/plugins/calendar/manifest.json": JSON.stringify({ id: "calendar", name: "Calendar", version: "1.2.3" }),
        "settings/plugins/disabled/manifest.json": JSON.stringify({ id: "disabled", name: "Disabled", version: "2.0" }),
    };
    const reads: string[] = [];
    const inventory = await collectPlugins({
        exists: async (p) => p === "settings/plugins" || p in data,
        list: async () => ({ folders: ["settings/plugins/lite-sync", "settings/plugins/calendar", "settings/plugins/disabled"] }),
        read: async (p) => { reads.push(p); assert.ok(p in data); return data[p]!; },
    }, "settings");
    assert.deepEqual(inventory.plugins, [
        { id: "calendar", name: "Calendar", version: "1.2.3", enabled: true },
        { id: "disabled", name: "Disabled", version: "2.0", enabled: false },
    ]);
    assert.ok(reads.every((p) => !p.includes("lite-sync") && !p.endsWith("data.json")));
});

it("binds encrypted inventories to their device and filters lite-sync after decryption", async () => {
    const keys = await deriveVaultKeys(newMasterKey());
    const input = { plugins: [{ id: "lite-sync", name: "Lite Sync", version: "0.1.1", enabled: true }] };
    const blob = await seal(keys.config, utf8(JSON.stringify(input)), pluginInventoryAad("Mac"));
    await assert.rejects(open(keys.config, blob, pluginInventoryAad("Phone")));
    const result = parsePluginInventory(JSON.parse(fromUtf8(await open(keys.config, blob, pluginInventoryAad("Mac")))));
    assert.deepEqual(result.plugins, []);
    assert.throws(() => parsePluginInventory({ plugins: [{ id: "bad" }] }));
});
