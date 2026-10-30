import type { Platform } from "@lite-sync/core";

export function bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function stamp(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${time}`;
    const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
    return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export function ago(ts: number | null, now = Date.now()): string {
    if (ts === null) return "从未连接";
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} 天前`;
    return stamp(ts);
}

export const PLATFORM: Record<Platform, string> = {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
    ios: "iOS",
    android: "Android",
    unknown: "未知平台",
};

export function splitPath(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf("/");
    return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

const TEXT = /\.(md|txt|canvas|json|css|js|csv|ya?ml|html|base)$/i;
const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };

export function kindOf(path: string): { kind: "text" | "image" | "binary"; mime: string } {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (IMAGE[ext]) return { kind: "image", mime: IMAGE[ext]! };
    if (TEXT.test(path)) return { kind: "text", mime: "text/plain;charset=utf-8" };
    return { kind: "binary", mime: "application/octet-stream" };
}

export function downloadBlob(data: Uint8Array, name: string, mime = "application/octet-stream") {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
