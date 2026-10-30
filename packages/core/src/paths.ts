// Which vault paths are synchronised. Phase 1 covers notes and attachments only.

const ALWAYS_EXCLUDED = [
    /(^|\/)\.DS_Store$/,
    /(^|\/)Thumbs\.db$/,
    /(^|\/)desktop\.ini$/,
    /(^|\/)~\$[^/]*$/, // Office lock files
    /\.(tmp|swp|crdownload|part)$/i,
];

// Glob subset: `**` crosses folders, `*` stays within one segment, `?` is one character.
export function globToRegExp(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === "*") {
            if (glob[i + 1] === "*") {
                i++;
                if (glob[i + 1] === "/") {
                    i++;
                    re += "(?:.*/)?";
                } else re += ".*";
            } else re += "[^/]*";
        } else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}

export class PathFilter {
    private patterns: RegExp[];
    private configDir: string;

    constructor(exclude: string[], configDir = ".obsidian") {
        this.patterns = exclude.map(globToRegExp);
        this.configDir = configDir;
    }

    accepts(path: string): boolean {
        const p = path.normalize("NFC");
        if (p === "" || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "")) return false;
        if (p === this.configDir || p.startsWith(this.configDir + "/")) return false;
        if (p.startsWith(".trash/")) return false;
        if (ALWAYS_EXCLUDED.some((r) => r.test(p))) return false;
        return !this.patterns.some((r) => r.test(p));
    }
}

const TEXT_EXT = new Set(["md", "txt", "canvas", "json", "css", "js", "csv", "yaml", "yml", "html", "svg", "base"]);

export function isMergeableText(path: string): boolean {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return TEXT_EXT.has(ext) && ext !== "json" && ext !== "canvas";
}

export function isJson(path: string): boolean {
    return /\.(json|canvas)$/i.test(path);
}

export function conflictPath(path: string, device: string, at: Date): string {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const hasExt = dot > slash + 1;
    const stem = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;
    const safeDevice = device.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40);
    return `${stem} (冲突 ${safeDevice} ${stamp})${ext}`;
}
