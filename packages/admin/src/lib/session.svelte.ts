// In-memory keys can be restored from the seven-day, session-bound browser unlock cache.

import { clearRememberedUnlock } from "./unlock-cache";
import type { Bytes, VaultKeys } from "@lite-sync/core";

export const session = $state<{
    cacheWarning: string;
    expiresAt: number;
    sessionTag: string;
    keys: VaultKeys | null;
    mk: Bytes | null;
    totpEnabled: boolean;
    recoveryLeft: number;
}>({ cacheWarning: "", expiresAt: 0, sessionTag: "", keys: null, mk: null, totpEnabled: false, recoveryLeft: 0 });

export function lock() {
    session.mk?.fill(0);
    session.keys = null;
    session.mk = null;
    session.cacheWarning = "";
    session.expiresAt = 0;
    session.sessionTag = "";
    void clearRememberedUnlock().catch(() => {});
}
