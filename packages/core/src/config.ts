// Unified configuration managed in the admin console. See docs/design.md §11.

export interface SyncConfig {
    schema: 1;
    sync: {
        debounceMs: number;
        configScanSeconds: number;
        maxFileSizeMB: number;
        massChangeGuard: number;
    };
    exclude: string[];
    obsidian: {
        enabled: boolean;
        appearance: boolean;
        themes: boolean;
        snippets: boolean;
        hotkeys: boolean;
        corePlugins: boolean;
        communityPlugins: boolean;
        pluginData: boolean;
        excludePlugins: string[];
    };
    overrides: {
        mobile?: DeepPartial<Omit<SyncConfig, "schema" | "overrides">>;
        desktop?: DeepPartial<Omit<SyncConfig, "schema" | "overrides">>;
    };
    history: { keepAllDays: number; thenDaily: boolean; keepDeletedDays: number };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export const DEFAULT_CONFIG: SyncConfig = {
    schema: 1,
    sync: { debounceMs: 2000, configScanSeconds: 30, maxFileSizeMB: 50, massChangeGuard: 20 },
    exclude: [".trash/**", "**/.DS_Store"],
    obsidian: {
        // Phase 3. Off until .obsidian sync ships.
        enabled: false,
        appearance: true,
        themes: true,
        snippets: true,
        hotkeys: true,
        corePlugins: true,
        communityPlugins: true,
        pluginData: true,
        excludePlugins: ["obsidian-livesync"],
    },
    overrides: {},
    history: { keepAllDays: 30, thenDaily: true, keepDeletedDays: 90 },
};

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Keeps only keys and value types known to the defaults, so an older client ignores newer settings
// and a malformed document can never produce an unusable configuration.
function shape<T>(defaults: T, input: unknown): T {
    if (Array.isArray(defaults))
        return (Array.isArray(input) && input.every((x) => typeof x === "string") ? input : defaults) as T;
    if (isObject(defaults)) {
        const src = isObject(input) ? input : {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(defaults)) out[k] = shape(v, src[k]);
        return out as T;
    }
    const valid = typeof input === typeof defaults && (typeof input !== "number" || Number.isFinite(input));
    return (valid ? input : defaults) as T;
}

export function normaliseConfig(input: unknown): SyncConfig {
    const { overrides: _defaultOverrides, ...rest } = DEFAULT_CONFIG;
    const overrides: SyncConfig["overrides"] = {};
    const raw = isObject(input) && isObject(input.overrides) ? input.overrides : {};
    for (const k of ["mobile", "desktop"] as const) if (isObject(raw[k])) overrides[k] = raw[k] as never;
    const base: SyncConfig = { ...shape(rest, input), schema: 1, overrides };
    const s = base.sync;
    s.debounceMs = clamp(s.debounceMs, 500, 60_000);
    s.configScanSeconds = clamp(s.configScanSeconds, 10, 3600);
    s.maxFileSizeMB = clamp(s.maxFileSizeMB, 1, 500);
    s.massChangeGuard = clamp(s.massChangeGuard, 1, 100_000);
    return base;
}

function clamp(n: number, lo: number, hi: number): number {
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function merge<T>(base: T, patch: unknown): T {
    if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = merge((base as Record<string, unknown>)[k], v);
    return out as T;
}

export function effectiveConfig(config: SyncConfig, mobile: boolean): SyncConfig {
    const o = mobile ? config.overrides.mobile : config.overrides.desktop;
    return o ? normaliseConfig({ ...merge(config, o), overrides: config.overrides }) : config;
}
