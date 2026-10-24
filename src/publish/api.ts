import { setTimeout as sleep } from "node:timers/promises";
import { PublishError, type PublishErrorCode } from "./errors.js";

/** A parsed JSON response. The platforms' shapes are not typed here. */
export type Json = any;

export interface ApiOptions {
  method?: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Sent as an `application/x-www-form-urlencoded` body. */
  form?: Record<string, string>;
  /** Sent as a JSON body. */
  json?: unknown;
  headers?: Record<string, string>;
  body?: BodyInit;
}

function parse(text: string): Json {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Each platform words its errors differently: Google and Meta use { error: { message } },
// OAuth endpoints { error, error_description }, and Meta's upload host { debug_info }.
function errorMessage(data: Json): string | null {
  return data.error?.message || data.error_description || (typeof data.error === "string" ? data.error : null) || data.debug_info?.message || null;
}

// Meta marks an expired or revoked token with code 190 and a missing permission with code 10
// or 200-299. Google flags a missing scope by its reason, and TikTok by its own codes.
function errorCode(status: number, data: Json): PublishErrorCode {
  const error = data.error;
  const code = error?.code;
  if (status === 401 || error === "invalid_grant" || code === 190 || code === "access_token_invalid") return "reconnect";
  if (code === 10 || (code >= 200 && code < 300) || code === "scope_not_authorized" || error?.errors?.[0]?.reason === "insufficientPermissions") {
    return "missing_permission";
  }
  return "platform";
}

/** The error for a refused platform call, with the platform's own message. */
export function platformError(url: string, status: number, text: string, data: Json = parse(text)): PublishError {
  return new PublishError(errorCode(status, data), `${new URL(url).host} answered ${status}: ${errorMessage(data) || text.slice(0, 200)}`);
}

/**
 * Calls a platform API and returns its JSON, throwing a {@link PublishError} when the
 * platform refuses.
 */
export async function api(url: string, { method = "GET", token, form, json, headers = {}, body }: ApiOptions = {}): Promise<Json> {
  const sent: Record<string, string> = { ...headers };
  if (token) sent.Authorization = `Bearer ${token}`;
  if (form) {
    // A string body with an explicit type: fetch's default for URLSearchParams adds
    // ";charset=UTF-8", and TikTok's token endpoint rejects that as malformed.
    body = new URLSearchParams(form).toString();
    sent["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (json !== undefined) {
    body = JSON.stringify(json);
    sent["Content-Type"] = "application/json; charset=UTF-8";
  }
  const res = await fetch(url, { method, headers: sent, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  const data = parse(text);
  // TikTok always sends { error: { code } }, with code "ok" on success.
  const tiktokFailed = data.error?.code && data.error.code !== "ok";
  // TikTok's token endpoint answers 200 with { error: "invalid_grant", ... } when it refuses.
  const oauthFailed = typeof data.error === "string";
  if (!res.ok || tiktokFailed || oauthFailed) throw platformError(url, res.status, text, data);
  return data;
}

/** Polls until `check` returns true. Platforms process an upload before it can be published. */
export async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  { everyMs = 3000, timeoutMs = 10 * 60 * 1000 }: { everyMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Gave up waiting for ${what}`);
    await sleep(everyMs);
  }
}
