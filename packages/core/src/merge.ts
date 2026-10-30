// Three-way merge used when two devices changed the same file. See docs/design.md §9.1.
// Merging never discards an edit: when a merge is not clean the caller keeps a conflict copy.

import { diff3Merge } from "node-diff3";

// Splitting on "\n" and joining with "\n" round-trips exactly: CR stays on its line and a final newline
// becomes a trailing empty line. Appending to a note without a final newline is then a pure insertion
// instead of an edit to its last line.
export type TextMergeResult = { ok: true; text: string } | { ok: false };

export function mergeText(base: string, local: string, remote: string): TextMergeResult {
    if (local === remote || remote === base) return { ok: true, text: local };
    if (local === base) return { ok: true, text: remote };
    const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
        excludeFalseConflicts: true,
    }) as { ok?: string[]; conflict?: unknown }[];
    const lines: string[] = [];
    for (const r of regions) {
        if (!r.ok) return { ok: false };
        lines.push(...r.ok);
    }
    return { ok: true, text: lines.join("\n") };
}

export type JsonMergeResult = { ok: true; text: string; conflicts: number } | { ok: false };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is { [k: string]: Json } {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function canonical(v: unknown): string {
    if (v === undefined) return "\u0000missing";
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (isObj(v))
        return `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
            .join(",")}}`;
    return JSON.stringify(v);
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// `undefined` stands for an absent key. Arrays are treated as single values.
function merge3(base: Json | undefined, local: Json | undefined, remote: Json | undefined, st: { conflicts: number }) {
    if (same(local, remote) || same(remote, base)) return local;
    if (same(local, base)) return remote;
    if (isObj(local) && isObj(remote) && (base === undefined || isObj(base))) {
        const b = base ?? {};
        const out: { [k: string]: Json } = {};
        const keys = [...Object.keys(remote), ...Object.keys(local).filter((k) => !(k in remote))];
        for (const k of keys) {
            const v = merge3(b[k], local[k], remote[k], st);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    st.conflicts++;
    return remote;
}

function stringifyLike(sample: string, value: unknown): string {
    const indent = /^[[{]\r?\n([ \t]+)/.exec(sample)?.[1];
    const text = indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    return sample.endsWith("\n") ? text + "\n" : text;
}

// Merges JSON by key. Keys changed differently on both sides take the remote value and are counted in
// `conflicts`, so the caller can decide whether that is acceptable or a conflict copy is required.
export function mergeJson(base: string, local: string, remote: string): JsonMergeResult {
    let b: Json, l: Json, r: Json;
    try {
        b = JSON.parse(base) as Json;
        l = JSON.parse(local) as Json;
        r = JSON.parse(remote) as Json;
    } catch {
        return { ok: false };
    }
    const st = { conflicts: 0 };
    const merged = merge3(b, l, r, st);
    if (same(merged, r)) return { ok: true, text: remote, conflicts: st.conflicts };
    if (same(merged, l)) return { ok: true, text: local, conflicts: st.conflicts };
    return { ok: true, text: stringifyLike(remote, merged), conflicts: st.conflicts };
}
