// Admin API client. Every request carries X-Lite-Sync, which a cross-site form cannot set.

import { DecryptError } from "@lite-sync/core";

const BASE = "/admin/api";

export class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) {
        super(`${status} ${code}`);
        this.status = status;
        this.code = code;
    }
}

async function call(method: string, path: string, body?: BodyInit | object, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { "x-lite-sync": "1", ...headers };
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob) payload = body as BodyInit;
    else if (body !== undefined) {
        payload = JSON.stringify(body);
        h["content-type"] = "application/json";
    }
    let res: Response;
    try {
        res = await fetch(BASE + path, { method, headers: h, body: payload, credentials: "same-origin", cache: "no-store" });
    } catch {
        throw new ApiError(0, "network");
    }
    if (!res.ok) {
        if (res.status === 401 && !["/login", "/session", "/setup"].includes(path)) window.dispatchEvent(new Event("lite-sync:expired"));
        let code = "unknown";
        try {
            code = String(((await res.json()) as { error?: string }).error ?? code);
        } catch {
            /* non-JSON body */
        }
        throw new ApiError(res.status, code);
    }
    return res;
}

export const api = {
    get: async <T>(path: string) => (await (await call("GET", path)).json()) as T,
    post: async <T>(path: string, body?: object) => (await (await call("POST", path, body ?? {})).json()) as T,
    patch: async <T>(path: string, body: object) => (await (await call("PATCH", path, body)).json()) as T,
    put: async <T>(path: string, body: object) => (await (await call("PUT", path, body)).json()) as T,
    raw: async (path: string) => {
        const res = await call("GET", path);
        return { data: new Uint8Array(await res.arrayBuffer()), rev: Number(res.headers.get("x-rev")), meta: res.headers.get("x-meta") ?? "" };
    },
    putFile: async (id: string, baseRev: number, meta: string, data: Uint8Array) => {
        const res = await call("PUT", `/files/${id}`, data, { "content-type": "application/octet-stream", "x-base-rev": String(baseRev), "x-meta": meta });
        return (await res.json()) as { rev: number; seq: number };
    },
};

const MESSAGES: Record<string, string> = {
    network: "连不上服务器。检查网络，或确认服务器正在运行。",
    bad_credentials: "口令或验证码不正确。",
    bad_totp: "验证码不正确。确认手机时间准确，并使用最新的验证码。",
    locked: "失败次数过多，已锁定 15 分钟。",
    invalid_setup_token: "初始化链接无效或已经使用过。在服务器上运行 docker exec lite-sync lite-sync setup-link 获取新链接。",
    already_initialised: "已经初始化过了，请直接登录。",
    unauthorised: "登录已过期，请重新登录。",
    conflict: "文件刚被其他设备修改过。刷新后再试。",
    not_found: "找不到这项内容，可能已被删除。",
};

export function describe(e: unknown): string {
    if (e instanceof DecryptError) return "口令不正确。";
    if (e instanceof ApiError) return MESSAGES[e.code] ?? `服务器返回错误（${e.status} ${e.code}）。`;
    return e instanceof Error ? e.message : String(e);
}
