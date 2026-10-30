// The master key lives only in this page's memory. Closing the tab, signing out, or 30 minutes
// without activity drops it.

import type { Bytes, VaultKeys } from "@lite-sync/core";

export const session = $state<{
    keys: VaultKeys | null;
    mk: Bytes | null;
    totpEnabled: boolean;
    recoveryLeft: number;
}>({ keys: null, mk: null, totpEnabled: false, recoveryLeft: 0 });

export function lock() {
    session.mk?.fill(0);
    session.keys = null;
    session.mk = null;
}
