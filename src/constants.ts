/** Literal marker used by the WeChat assistant split. Case-sensitive. */
export const BOT_MARKER = "@bot";

/** Replaces `@bot` on an ambiguous fragment so it is never auto-merged. */
export const NOT_MARKER = "@not";

/**
 * WeChat inbox source tag. Used only for dependency matching, never as a
 * user dispatch/claim tag.
 */
export const WECHAT_CAPTURE_TAG = "微信采集";

export const APPEND_SEPARATOR = "\n\n---\n\n";

/**
 * Inclusive pairing window around fragment createdTime T:
 * [T − DEPENDENCY_WINDOW_BEFORE_MS, T + DEPENDENCY_WINDOW_AFTER_MS].
 * −10s covers "forward chat first, then @bot"; +10s covers late images.
 */
export const DEPENDENCY_WINDOW_BEFORE_MS = 10_000;
export const DEPENDENCY_WINDOW_AFTER_MS = 10_000;

/**
 * Cloudflare Worker free-tier fetch subrequest budget is ~50/invocation.
 * Soft cap leaves headroom for retries/errors. Counts Dida HTTP + webhook
 * `fetch` only — KV bindings (lock, processed fragment ids, token) are NOT
 * fetch subrequests and are not counted.
 */
export const SOFT_SUBREQUEST_BUDGET = 40;
/** Merges + `@not` title rewrites combined per run. */
export const MAX_MERGE_OR_NOT = 5;
/** Max todo→doing claims per run after a successful work webhook. */
export const MAX_CLAIM = 8;
/** Hydrate only tasks missing createdTime/projectId. */
export const MAX_HYDRATE = 5;

/** GET dep + POST content/tags + GET verify + DELETE fragment. */
export const MERGE_CLASSIC_COST = 4;
/** POST fragment content/tags + GET verify (media-only dep stays). */
export const MERGE_MEDIA_COST = 2;
/** POST title `@bot` → `@not`. */
export const NOT_REWRITE_COST = 1;
export const HYDRATE_COST = 1;
export const CLAIM_WEBHOOK_COST = 1;
export const CLAIM_TAG_COST = 1;

export const DIDA_API_BASE = "https://api.dida365.com/open/v1";
export const DIDA_OAUTH_AUTHORIZE = "https://dida365.com/oauth/authorize";
export const DIDA_OAUTH_TOKEN = "https://dida365.com/oauth/token";

export const KV_TOKEN = "oauth:token";
export const KV_LOCK = "merge:lock";
export const KV_EXPIRY_REMINDER = "webhook:expiry_reminder_date";
export const KV_PROCESSED_PREFIX = "merge:processed:";
export const KV_OAUTH_STATE_PREFIX = "oauth:state:";

/**
 * Nesting parent for bot lifecycle leaves. Grouping/display only — Open API
 * filter matches leaf names (`todo`), not `bot/todo`, and the parent name
 * alone only matches tasks that explicitly have `"bot"` in `tags`.
 */
export const BOT_TAG_PARENT = "bot";
export const BOT_TAG_TODO = "todo";
export const BOT_TAG_DOING = "doing";
export const BOT_TAG_DONE = "done";
/**
 * Classification leaf under `bot` for ambiguous / `@not` fragments.
 * Not a claim lifecycle leaf — `withBotLifecycleTag` must not strip it.
 */
export const BOT_TAG_FREEZE = "freeze";

export const BOT_LIFECYCLE_TAGS = [
  BOT_TAG_TODO,
  BOT_TAG_DOING,
  BOT_TAG_DONE,
] as const;

/** Nested leaves created under parent `bot` (lifecycle + freeze). */
export const BOT_NESTED_TAGS = [
  ...BOT_LIFECYCLE_TAGS,
  BOT_TAG_FREEZE,
] as const;

export type BotLifecycleTag = (typeof BOT_LIFECYCLE_TAGS)[number];

export const BOT_LIFECYCLE_TAG_SET: ReadonlySet<string> = new Set(
  BOT_LIFECYCLE_TAGS,
);

export function isBotLifecycleTag(tag: string): tag is BotLifecycleTag {
  return BOT_LIFECYCLE_TAG_SET.has(tag);
}

/** True when the task already has any lifecycle leaf (todo / doing / done). */
export function hasBotLifecycleTag(
  tags: readonly string[] | undefined | null,
): boolean {
  if (!tags) return false;
  return tags.some(isBotLifecycleTag);
}

/**
 * One task one lifecycle leaf: drop todo/doing/done, keep unrelated tags,
 * then append `next`.
 */
export function withBotLifecycleTag(
  tags: readonly string[] | undefined | null,
  next: BotLifecycleTag,
): string[] {
  const kept = (tags ?? []).filter((tag) => !isBotLifecycleTag(tag));
  return [...kept, next];
}

export function hasFreezeTag(
  tags: readonly string[] | undefined | null,
): boolean {
  if (!tags) return false;
  return tags.includes(BOT_TAG_FREEZE);
}

/** Append `freeze` if missing; keep 微信采集 and every other tag. */
export function withFreezeTag(
  tags: readonly string[] | undefined | null,
): string[] {
  const current = tags ?? [];
  if (current.includes(BOT_TAG_FREEZE)) return [...current];
  return [...current, BOT_TAG_FREEZE];
}

/** Default Open API token lifetime when `expires_in` is absent (~6 months). */
export const DEFAULT_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

export const PROCESSED_TTL_SECONDS = 60 * 24 * 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const MERGE_LOCK_TTL_SECONDS = 120;

export const SHANGHAI_TZ = "Asia/Shanghai";
