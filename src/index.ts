import { runMergeAndNotify } from "./merge.ts";
import {
  adminKeyAuthorized,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  oauthCallbackUrl,
  publicBaseUrl,
  randomState,
} from "./oauth.ts";
import { consumeOAuthState, putOAuthState, storeAccessToken } from "./kv.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function successHtml(expiresAt: string): string {
  const escaped = escapeHtml(expiresAt);
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Dida OAuth</title></head>
<body>
  <h1>授权成功</h1>
  <p>Access token 已加密写入 KV。滴答 Open API 无 refresh_token，到期前需重新打开 <code>/auth</code>。</p>
  <p>expires_at: <code>${escaped}</code></p>
</body>
</html>`;
}

function errorHtml(message: string, status: number): Response {
  return html(
    `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Dida OAuth</title></head>
<body>
  <h1>授权失败</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`,
    status,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (!(await adminKeyAuthorized(request, env.ADMIN_KEY))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const state = randomState();
  await putOAuthState(env.TOKEN_KV, state);
  const redirectUri = oauthCallbackUrl(
    publicBaseUrl(request, env.PUBLIC_BASE_URL),
  );
  const location = buildAuthorizeUrl({
    clientId: env.CLIENT_ID,
    redirectUri,
    scope: env.OAUTH_SCOPE || "tasks:read tasks:write",
    state,
  });
  return Response.redirect(location, 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return errorHtml(`OAuth error: ${error}`, 400);
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) {
    return errorHtml("missing code or state", 400);
  }
  const valid = await consumeOAuthState(env.TOKEN_KV, state);
  if (!valid) {
    return errorHtml("invalid or expired state", 400);
  }
  const redirectUri = oauthCallbackUrl(
    publicBaseUrl(request, env.PUBLIC_BASE_URL),
  );
  try {
    const token = await exchangeAuthorizationCode({
      clientId: env.CLIENT_ID,
      clientSecret: env.CLIENT_SECRET,
      code,
      redirectUri,
      scope: env.OAUTH_SCOPE || "tasks:read tasks:write",
    });
    const stored = await storeAccessToken(
      env.TOKEN_KV,
      env.TOKEN_ENCRYPTION_KEY,
      token.access_token,
      token.expires_in,
    );
    return html(successHtml(stored.expires_at));
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: "oauth_callback_failed",
        error: err instanceof Error ? err.message : "unknown",
      }),
    );
    return errorHtml("token exchange failed", 502);
  }
}

async function handleRun(request: Request, env: Env): Promise<Response> {
  if (!(await adminKeyAuthorized(request, env.ADMIN_KEY))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const result = await runMergeAndNotify(env);
  const status = result.ok ? 200 : result.locked ? 409 : 500;
  return json(result, status);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true });
      }
      if (url.pathname === "/auth" && request.method === "GET") {
        return handleAuth(request, env);
      }
      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return handleCallback(request, env);
      }
      if (url.pathname === "/run" && request.method === "POST") {
        return handleRun(request, env);
      }
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      console.log(
        JSON.stringify({
          msg: "unhandled",
          error: err instanceof Error ? err.message : "unknown",
        }),
      );
      return json({ ok: false, error: "internal" }, 500);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
  ): Promise<void> {
    const result = await runMergeAndNotify(env);
    console.log(
      JSON.stringify({
        msg: "cron_complete",
        cron: controller.cron,
        ok: result.ok,
        subrequests_used: result.subrequestsUsed,
        merged: result.mergedCount,
        notted: result.notted,
        claimed: result.claimed,
        stopped: result.stopped ?? null,
        pending: result.pending.length,
        skipped: result.skipped.length,
        error: result.error ?? null,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;
