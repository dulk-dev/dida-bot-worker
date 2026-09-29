import {
  DIDA_OAUTH_AUTHORIZE,
  DIDA_OAUTH_TOKEN,
  DEFAULT_TOKEN_TTL_SECONDS,
} from "./constants.ts";
import { timingSafeEqualString } from "./crypto.ts";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomState(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

export function publicBaseUrl(request: Request, configured: string): string {
  const trimmed = configured.trim().replace(/\/$/, "");
  if (trimmed.length > 0) return trimmed;
  return new URL(request.url).origin;
}

export function oauthCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/auth/callback`;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(DIDA_OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

function parseExpiresIn(payload: Record<string, unknown>): number | undefined {
  const raw = payload.expires_in;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function exchangeAuthorizationCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  scope: string;
}): Promise<TokenResponse> {
  const basic = btoa(`${params.clientId}:${params.clientSecret}`);
  const body = new URLSearchParams({
    code: params.code,
    grant_type: "authorization_code",
    scope: params.scope,
    redirect_uri: params.redirectUri,
  });
  const response = await fetch(DIDA_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status})`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("OAuth token exchange returned invalid JSON");
  }
  const access_token =
    typeof payload.access_token === "string" ? payload.access_token : "";
  if (!access_token) {
    throw new Error("OAuth token exchange missing access_token");
  }
  return {
    access_token,
    expires_in: parseExpiresIn(payload) ?? DEFAULT_TOKEN_TTL_SECONDS,
    token_type:
      typeof payload.token_type === "string" ? payload.token_type : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}

export async function adminKeyAuthorized(
  request: Request,
  adminKey: string,
): Promise<boolean> {
  if (!adminKey) return false;
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("key") ?? "";
  const fromHeader = request.headers.get("X-Admin-Key") ?? "";
  const bearer = bearerToken(request.headers.get("Authorization"));
  const candidates = [fromQuery, fromHeader, bearer].filter((v) => v.length > 0);
  if (candidates.length === 0) return false;
  for (const candidate of candidates) {
    if (await timingSafeEqualString(candidate, adminKey)) return true;
  }
  return false;
}

function bearerToken(header: string | null): string {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
