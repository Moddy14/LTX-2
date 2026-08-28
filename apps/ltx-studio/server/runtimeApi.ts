import { lstatSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_RUNTIME_API_BASE_URL = "http://127.0.0.1:8878";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
    readonly payload: unknown = null,
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

export function runtimeApiBaseUrl(): string {
  return process.env.DGX_RUNTIME_API_BASE_URL ?? DEFAULT_RUNTIME_API_BASE_URL;
}

export function runtimeToken(): string {
  const direct = process.env.DGX_RUNTIME_API_TOKEN;
  if (direct) return direct;
  const tokenPath = resolve(
    process.env.DGX_RUNTIME_API_TOKEN_FILE ?? `${homedir()}/.config/openclaw/dgx-runtime-api.token`,
  );
  const details = lstatSync(tokenPath);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw new RuntimeApiError("DGX Runtime API Token-Datei ist nicht privat oder kein reguläres File.");
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  if (token.length < 32 || /\s/.test(token)) throw new RuntimeApiError("DGX Runtime API Token ist ungültig.");
  return token;
}

function runtimeUrl(path: string): URL {
  if (!path.startsWith("/") || path.includes("?") || path.includes(";")) {
    throw new RuntimeApiError("DGX Runtime API Pfade müssen absolute Pfade ohne Query oder Path-Parameter sein.");
  }
  const url = new URL(path, runtimeApiBaseUrl());
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new RuntimeApiError("DGX Runtime API muss an Loopback gebunden sein.");
  }
  if (url.search || url.pathname.includes(";")) {
    throw new RuntimeApiError("DGX Runtime API Pfade dürfen keine Query oder Path-Parameter enthalten.");
  }
  return url;
}

function errorMessage(statusCode: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    for (const key of ["message_for_humans", "app_message", "message", "error"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key];
    }
  }
  return `DGX Runtime API antwortete mit ${String(statusCode)}.`;
}

export function runtimeApiJson<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const url = runtimeUrl(path);
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string | number> = {
    Authorization: `Bearer ${runtimeToken()}`,
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };
  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload, "utf8");
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolvePromise(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      rejectPromise(error);
    };
    const requestHandle = request(url, { method, headers, signal: options.signal }, (response) => {
      let responseBody = "";
      let byteLength = 0;
      const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        byteLength += Buffer.byteLength(chunk, "utf8");
        if (byteLength > maxBytes) {
          requestHandle.destroy(new RuntimeApiError("DGX Runtime API Antwort ist zu groß.", response.statusCode ?? null));
          return;
        }
        responseBody += chunk;
      });
      response.once("end", () => {
        let parsed: unknown = null;
        try {
          parsed = responseBody ? JSON.parse(responseBody) : null;
        } catch {
          rejectOnce(new RuntimeApiError("DGX Runtime API lieferte ungültiges JSON.", response.statusCode ?? null));
          return;
        }
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          rejectOnce(new RuntimeApiError(errorMessage(statusCode, parsed), statusCode, parsed));
          return;
        }
        resolveOnce(parsed as T);
      });
      response.once("error", rejectOnce);
      response.once("aborted", () => {
        rejectOnce(new RuntimeApiError("DGX Runtime API Antwort wurde vorzeitig abgebrochen.", response.statusCode ?? null));
      });
    });
    const timeoutMs = options.timeoutMs ?? 120_000;
    deadlineTimer = setTimeout(() => {
      const error = new RuntimeApiError("DGX Runtime API Timeout.", null);
      requestHandle.destroy(error);
      rejectOnce(error);
    }, timeoutMs);
    deadlineTimer.unref();
    requestHandle.once("error", rejectOnce);
    requestHandle.once("close", () => {
      if (settled) clearDeadline();
    });
    requestHandle.end(payload ?? undefined);
  });
}

export function runtimeApiConfigured(): boolean {
  try {
    runtimeUrl("/health");
    runtimeToken();
    return true;
  } catch {
    return false;
  }
}
