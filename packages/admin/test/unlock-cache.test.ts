import assert from "node:assert/strict";
import { it } from "node:test";
import { makeUnlockRecord, readUnlockRecord, UNLOCK_TTL_MS } from "../src/lib/unlock-cache.ts";
import { newMasterKey } from "@lite-sync/core";
it("restores a non-extractable, session-bound unlock for seven days and rejects stale or changed records", async () => {
    const now = Date.now(), mk = newMasterKey();
    const record = structuredClone(await makeUnlockRecord(mk, "wrapped", "session", now + UNLOCK_TTL_MS, now));
    assert.equal(record.key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("raw", record.key));
    assert.deepEqual(await readUnlockRecord(record, "wrapped", "session", now + 86400000), mk);
    assert.equal(await readUnlockRecord(record, "wrapped", "session", now + UNLOCK_TTL_MS), null);
    assert.equal(await readUnlockRecord(record, "changed-passphrase", "session", now), null);
    assert.equal(await readUnlockRecord(record, "wrapped", "other-session", now), null);
    await assert.rejects(readUnlockRecord({ ...record, expiresAt: record.expiresAt - 1 }, "wrapped", "session", now));
});
