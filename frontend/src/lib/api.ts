"use client";

/**
 * Browser API client. The access token lives in memory only; the refresh token is an HttpOnly
 * cookie scoped to /api/auth, so a page script can never read it. A 401 triggers one silent refresh.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((fn) => fn(token));
}

export function hasToken() {
  return accessToken !== null;
}

export function onTokenChange(fn: (token: string | null) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Uploads a file with progress (fetch cannot report upload progress). Returns the JSON reply. */
export function uploadWithProgress<T>(path: string, file: File, onProgress: (fraction: number) => void, retried = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Requested-With", "pixcart");
    if (accessToken) xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, "network", "The upload stopped. Check your connection and try again."));
    xhr.onload = async () => {
      if (xhr.status === 401 && !retried && (await refreshSession())) {
        uploadWithProgress<T>(path, file, onProgress, true).then(resolve, reject);
        return;
      }
      let data: { error?: { code?: string; message?: string; fields?: Record<string, string> } } & Record<string, unknown> = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data.error?.code ?? "error", data.error?.message ?? (xhr.status === 413 ? "The file is too large" : `Upload failed (${xhr.status})`), data.error?.fields ?? {}));
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/**
 * Catch handler for background loads (page data, lists). A lost session (401 after a failed refresh) is
 * handled by SessionProvider, which signs the person out and the layout sends them to sign in, so it is
 * ignored here; anything else is logged instead of crashing the page.
 */
export function quietly(e: unknown): void {
  if (e instanceof ApiError && e.status === 401) return;
  console.error(e);
}

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch("/api/auth/refresh", { method: "POST", headers: { "X-Requested-With": "pixcart" }, credentials: "same-origin" });
        if (!res.ok) {
          setAccessToken(null);
          return false;
        }
        const data = await res.json();
        setAccessToken(data.access_token);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  headers?: Record<string, string>; // extra headers, e.g. the shop chat's guest key
};

function buildUrl(path: string, query?: Options["query"]) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function api<T = unknown>(path: string, opts: Options = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}), "X-Requested-With": "pixcart" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method: opts.method ?? "GET", headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "You appear to be offline. Check your connection and try again.");
  }
  if (res.status === 401 && !retried && !path.startsWith("/api/auth/")) {
    if (await refreshSession()) return api<T>(path, opts, true);
  }
  if (!res.ok) {
    let data: { error?: { code?: string; message?: string; fields?: Record<string, string> } } = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON error */
    }
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? `Something went wrong (${res.status}). Try again.`, e.fields ?? {});
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Keeps only a plain file name from what the server suggests (no paths, no odd characters). */
function safeFilename(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return safeFilename(decodeURIComponent(star[1].replace(/^"|"$/g, "")), fallback);
    } catch {
      /* fall back to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1] ? safeFilename(plain[1], fallback) : fallback;
}

/**
 * Downloads a file the API generates (CSV, PDF) with the signed-in user's token, and saves it under the
 * name the server suggests. Errors carry the API's own message, e.g. "Export at most 366 days at a time".
 */
export async function downloadFile(path: string, query?: Options["query"], fallback = "download"): Promise<string> {
  const url = buildUrl(path, query);
  const go = () => fetch(url, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: "same-origin" });
  let res = await go();
  if (res.status === 401 && (await refreshSession())) res = await go();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? "download_failed", e.message ?? "Could not download the file. Try again.", e.fields ?? {});
  }
  const name = filenameFrom(res.headers.get("content-disposition"), fallback);
  const href = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
  return name;
}

function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}

/** POSTs JSON and saves the file the server returns (e.g. a ZIP of several reports). */
export async function downloadPost(path: string, body: unknown, fallback = "download"): Promise<string> {
  const go = () => fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "pixcart", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
  let res = await go();
  if (res.status === 401 && (await refreshSession())) res = await go();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? "download_failed", e.message ?? "Could not download the file. Try again.", e.fields ?? {});
  }
  const name = filenameFrom(res.headers.get("content-disposition"), fallback);
  saveBlob(await res.blob(), name);
  return name;
}

/**
 * Streams Server-Sent Events from a POST (the AI assistant). Calls onEvent for each JSON event.
 * Pass an AbortSignal to stop; the server saves what was said so far.
 */
export async function streamPost(path: string, body: unknown, onEvent: (ev: Record<string, unknown>) => void, signal?: AbortSignal,
  extraHeaders: Record<string, string> = {}): Promise<void> {
  const go = () => fetch(path, {
    method: "POST", credentials: "same-origin", signal,
    headers: { ...extraHeaders, "Content-Type": "application/json", Accept: "text/event-stream", "X-Requested-With": "pixcart", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
  let res = await go();
  if (res.status === 401 && (await refreshSession())) res = await go();
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? "The assistant could not answer. Try again.", e.fields ?? {});
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) {
        try { onEvent(JSON.parse(data)); } catch { /* ignore a broken event */ }
      }
    }
  }
}

export async function downloadBlob(path: string): Promise<Blob> {
  const go = () => fetch(path, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  let res = await go();
  if (res.status === 401 && (await refreshSession())) res = await go();
  if (!res.ok) throw new ApiError(res.status, "download_failed", "Could not open the file");
  return res.blob();
}

/**
 * Applies only the newest response. When filters or tabs change quickly, an older, slower request can
 * otherwise finish last and overwrite the screen with stale rows.
 */
export function latestOnly() {
  let seq = 0;
  return function track<T>(promise: Promise<T>, apply: (value: T) => void): Promise<T> {
    const id = ++seq;
    return promise.then((value) => {
      if (id === seq) apply(value);
      return value;
    });
  };
}
