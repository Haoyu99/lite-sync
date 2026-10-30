// Device API client. The transport is injected: Obsidian's requestUrl in the plug-in, app.request in tests.

import type {
    BatchOp,
    BatchResponse,
    Bytes,
    ChangePage,
    ConfigDoc,
    ConflictResponse,
    PairRequest,
    PairResponse,
    StatusReport,
    VaultInfo,
} from "@lite-sync/core";
import { fromUtf8, utf8 } from "@lite-sync/core";

export interface HttpRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Bytes;
}
export interface HttpResponse {
    status: number;
    headers: Record<string, string>; // lower-case names
    body: Bytes;
}
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

// The server answered with an unexpected status.
export class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) {
        super(`HTTP ${status} ${code}`);
        this.status = status;
        this.code = code;
    }
}

// The request did not reach the server or no response came back.
export class NetworkError extends Error {}

export type WriteResult = { ok: true; rev: number; seq: number } | { ok: false; conflict: ConflictResponse };

export type RemoteFile = { deleted: false; rev: number; meta: string; data: Bytes } | { deleted: true; rev: number };

export function normaliseBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
}

export class Api {
    private http: Http;
    private base: string;
    private token: string;

    constructor(http: Http, baseUrl: string, token: string) {
        this.http = http;
        this.base = normaliseBaseUrl(baseUrl);
        this.token = token;
    }

    static async pair(http: Http, baseUrl: string, req: PairRequest): Promise<PairResponse> {
        const api = new Api(http, baseUrl, "");
        const res = await api.call("POST", "/v1/pair", req, false);
        if (res.status !== 200) throw api.error(res);
        return api.json<PairResponse>(res);
    }

    private async call(method: string, path: string, body?: unknown, auth = true, extra: Record<string, string> = {}) {
        const headers: Record<string, string> = { ...extra };
        if (auth) headers.authorization = `Bearer ${this.token}`;
        let payload: Bytes | undefined;
        if (body instanceof Uint8Array) {
            payload = body as Bytes;
            headers["content-type"] = "application/octet-stream";
        } else if (body !== undefined) {
            payload = utf8(JSON.stringify(body));
            headers["content-type"] = "application/json";
        }
        let res: HttpResponse;
        try {
            res = await this.http({ method, url: this.base + path, headers, body: payload });
        } catch (e) {
            throw new NetworkError(e instanceof Error ? e.message : String(e));
        }
        if (res.status === 401) throw new ApiError(401, "unauthorised");
        if (res.status >= 500 || res.status === 429) throw new ApiError(res.status, "server");
        return res;
    }

    private json<T>(res: HttpResponse): T {
        return JSON.parse(fromUtf8(res.body)) as T;
    }

    private error(res: HttpResponse): ApiError {
        let code = "unknown";
        try {
            code = String(this.json<{ error?: string }>(res).error ?? code);
        } catch {
            /* non-JSON body */
        }
        return new ApiError(res.status, code);
    }

    async vault(): Promise<VaultInfo> {
        const res = await this.call("GET", "/v1/vault");
        if (res.status !== 200) throw this.error(res);
        return this.json<VaultInfo>(res);
    }

    async changes(since: number): Promise<ChangePage> {
        const res = await this.call("GET", `/v1/changes?since=${since}`);
        if (res.status !== 200) throw this.error(res);
        return this.json<ChangePage>(res);
    }

    // Latest version when `rev` is omitted. Returns null when the file never existed.
    async get(id: string, rev?: number): Promise<RemoteFile | null> {
        const res = await this.call("GET", rev === undefined ? `/v1/files/${id}` : `/v1/files/${id}/versions/${rev}`);
        if (res.status === 404) return null;
        if (res.status === 410) return { deleted: true, rev: this.json<{ rev: number }>(res).rev };
        if (res.status !== 200) throw this.error(res);
        const r = Number(res.headers["x-rev"]);
        const meta = res.headers["x-meta"];
        if (!Number.isInteger(r) || !meta) throw new ApiError(res.status, "missing_headers");
        return { deleted: false, rev: r, meta, data: res.body };
    }

    private writeResult(res: HttpResponse): WriteResult {
        if (res.status === 200) return { ok: true, ...this.json<{ rev: number; seq: number }>(res) };
        if (res.status === 409) return { ok: false, conflict: this.json<ConflictResponse>(res) };
        throw this.error(res);
    }

    async put(id: string, baseRev: number, meta: string, data: Bytes): Promise<WriteResult> {
        const res = await this.call("PUT", `/v1/files/${id}`, data, true, { "x-base-rev": String(baseRev), "x-meta": meta });
        return this.writeResult(res);
    }

    async remove(id: string, baseRev: number): Promise<WriteResult> {
        const res = await this.call("DELETE", `/v1/files/${id}`, undefined, true, { "x-base-rev": String(baseRev) });
        return this.writeResult(res);
    }

    async batch(ops: BatchOp[]): Promise<BatchResponse> {
        const res = await this.call("POST", "/v1/batch", { ops });
        if (res.status !== 200 && res.status !== 409) throw this.error(res);
        return this.json<BatchResponse>(res);
    }

    async config(): Promise<ConfigDoc> {
        const res = await this.call("GET", "/v1/config");
        if (res.status !== 200) throw this.error(res);
        return this.json<ConfigDoc>(res);
    }

    async status(report: StatusReport): Promise<void> {
        await this.call("POST", "/v1/status", report);
    }
}
