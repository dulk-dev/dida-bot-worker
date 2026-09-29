export interface MergeSummaryItem {
  fragmentId: string;
  contextId: string;
  fragmentTitle: string;
  contextTitle: string;
  createdSecond: string;
}

export type PendingReason = "merged" | "standalone";

export interface PendingBotItem {
  taskId: string;
  projectId: string;
  title: string;
  reason: PendingReason;
  /** Tags after claim (`todo` → `doing`). */
  tags?: string[];
  /** Worker claims work as `doing` before webhook. */
  lifecycle?: "doing";
}

/** Unified wake: fires when there is merge work and/or pending @bot tasks to execute. */
export interface WorkWebhookPayload {
  event: "dida_bot_work";
  source: "dida-bot-merge-worker";
  mergedCount: number;
  merges: MergeSummaryItem[];
  pending: PendingBotItem[];
}

/** @deprecated kept for type-compat in tests; prefer WorkWebhookPayload */
export interface MergeWebhookPayload {
  event: "dida_bot_merge";
  source: "dida-bot-merge-worker";
  mergedCount: number;
  merges: MergeSummaryItem[];
}

export interface ExpiryWebhookPayload {
  event: "dida_token_expiry_reminder";
  source: "dida-bot-merge-worker";
  expiresAt: string;
  daysRemaining: number;
  shanghaiDate: string;
}

export type WebhookAuthStyle = "bearer" | "header" | "both";

export function parseWebhookAuthStyle(raw: string | undefined): WebhookAuthStyle {
  const value = (raw ?? "both").trim().toLowerCase();
  if (value === "bearer" || value === "header" || value === "both") return value;
  return "both";
}

export function webhookHeaders(
  secret: string,
  style: WebhookAuthStyle,
): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (style === "bearer" || style === "both") {
    headers.Authorization = `Bearer ${secret}`;
  }
  if (style === "header" || style === "both") {
    headers["X-Webhook-Secret"] = secret;
  }
  return headers;
}

export async function postWebhook(
  url: string,
  secret: string,
  style: WebhookAuthStyle,
  payload: WorkWebhookPayload | ExpiryWebhookPayload | MergeWebhookPayload,
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, {
    method: "POST",
    headers: webhookHeaders(secret, style),
    body: JSON.stringify(payload),
  });
  return { ok: response.ok, status: response.status };
}
