import { diffComm } from "node-diff3";

export type DiffRow = { t: "same" | "add" | "del" | "gap"; text: string; a: number | null; b: number | null };

type Chunk = { common?: string[]; buffer1?: string[]; buffer2?: string[] };

// Line diff from `before` to `after`, keeping `context` unchanged lines around each change.
export function lineDiff(before: string, after: string, context = 3): DiffRow[] {
    const chunks = diffComm(before.split("\n"), after.split("\n")) as Chunk[];
    const rows: DiffRow[] = [];
    let a = 1;
    let b = 1;
    chunks.forEach((c, i) => {
        if (c.common) {
            const lines = c.common;
            const first = i === 0;
            const last = i === chunks.length - 1;
            const head = first ? 0 : context;
            const tail = last ? 0 : context;
            if (lines.length > head + tail + 1) {
                for (let k = 0; k < head; k++) rows.push({ t: "same", text: lines[k]!, a: a + k, b: b + k });
                rows.push({ t: "gap", text: `… ${lines.length - head - tail} 行未变 …`, a: null, b: null });
                for (let k = lines.length - tail; k < lines.length; k++) rows.push({ t: "same", text: lines[k]!, a: a + k, b: b + k });
            } else lines.forEach((text, k) => rows.push({ t: "same", text, a: a + k, b: b + k }));
            a += lines.length;
            b += lines.length;
            return;
        }
        for (const text of c.buffer1 ?? []) rows.push({ t: "del", text, a: a++, b: null });
        for (const text of c.buffer2 ?? []) rows.push({ t: "add", text, a: null, b: b++ });
    });
    return rows;
}
