import {
  APPEND_SEPARATOR,
  BOT_MARKER,
  BOT_TAG_TODO,
  DEPENDENCY_WINDOW_AFTER_MS,
  DEPENDENCY_WINDOW_BEFORE_MS,
  hasFreezeTag,
  NOT_MARKER,
  WECHAT_CAPTURE_TAG,
} from "./constants.ts";

export interface MergeTask {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdTime?: string;
  status?: number;
  tags?: string[];
}

export type SkipReason = "no_created_time" | "waiting_deps" | "already_processed";

export interface DepMerge {
  fragment: MergeTask;
  dep: MergeTask;
}

export interface SkippedFragment {
  fragment: MergeTask;
  reason: SkipReason;
}

export interface FragmentPlan {
  merges: DepMerge[];
  nots: MergeTask[];
  skipped: SkippedFragment[];
}

/**
 * Truncate a Dida `createdTime` string to second precision for display.
 * Pairing no longer uses this — see parseCreatedTimeMs / isInDependencyWindow.
 */
export function createdTimeSecond(
  createdTime: string | undefined | null,
): string | null {
  if (!createdTime) return null;
  const match = createdTime.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : null;
}

/**
 * Parse Dida `createdTime` to epoch ms. Normalizes `+0800` → `+08:00`.
 * Returns null when missing or unparseable.
 */
export function parseCreatedTimeMs(
  createdTime: string | undefined | null,
): number | null {
  if (!createdTime) return null;
  const normalized = createdTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** Inclusive real-time window [T−BEFORE, T+AFTER] around fragment createdTime T. */
export function isInDependencyWindow(
  anchorMs: number,
  candidateMs: number,
): boolean {
  const delta = candidateMs - anchorMs;
  return (
    delta >= -DEPENDENCY_WINDOW_BEFORE_MS &&
    delta <= DEPENDENCY_WINDOW_AFTER_MS
  );
}

export function isContentEmpty(
  content: string | null | undefined,
): boolean {
  return content == null || content.length === 0;
}

export function hasNotMarker(title: string | null | undefined): boolean {
  return (title ?? "").includes(NOT_MARKER);
}

/**
 * Belt and suspenders: never auto-merge already-`@not` or already-`freeze`
 * fragments. `@not` is also excluded by `isBotFragment`.
 */
export function shouldSkipAutoMerge(task: {
  title?: string | null;
  tags?: readonly string[] | null;
}): boolean {
  return hasNotMarker(task.title) || hasFreezeTag(task.tags);
}

export function hasWeChatCaptureTag(
  tags: readonly string[] | undefined | null,
): boolean {
  if (!tags) return false;
  return tags.includes(WECHAT_CAPTURE_TAG);
}

/**
 * Dependency fragment: title contains `@bot`, content empty/null, and not `@not`.
 * Long empty-content `@bot` titles are still fragments. Non-empty content is not.
 * Already-`freeze` fragments are still fragments (claim skip) but auto-merge
 * is gated by `shouldSkipAutoMerge`.
 */
export function isBotFragment(task: {
  title?: string | null;
  content?: string | null;
  tags?: readonly string[] | null;
}): boolean {
  const title = task.title ?? "";
  if (hasNotMarker(title)) return false;
  if (!title.includes(BOT_MARKER)) return false;
  return isContentEmpty(task.content);
}

/** Instruction text to append: prefer non-empty content, else title. */
export function fragmentPayload(task: MergeTask): string {
  if (task.content.length > 0) return task.content;
  return task.title;
}

export function rewriteBotTitleToNot(title: string): string {
  return title.replaceAll(BOT_MARKER, NOT_MARKER);
}

const WECHAT_MEDIA_TITLE = /^来自微信的(图片|文件|视频|语音|链接)/;

/** Media-only WeChat stub: known title and empty content. */
export function isWeChatMediaOnly(task: {
  title?: string | null;
  content?: string | null;
}): boolean {
  const content = task.content ?? "";
  const title = (task.title ?? "").trim();
  return content.length === 0 && WECHAT_MEDIA_TITLE.test(title);
}

/** Non-fragment has usable text (not a media-only stub). */
export function depHasSubstance(task: MergeTask): boolean {
  if (isWeChatMediaOnly(task)) return false;
  if ((task.content ?? "").trim().length > 0) return true;
  return (task.title ?? "").trim().length > 0;
}

export function mediaOrTaskRef(task: MergeTask): string {
  const title = (task.title ?? "").trim() || "微信依赖";
  return `${title} (taskId: ${task.id})`;
}

export interface MergeMainChoice {
  main: MergeTask;
  payload: string;
  deleteFragment: boolean;
}

/**
 * Prefer the non-fragment as main when it has substance (classic context).
 * Media-only deps (e.g. 来自微信的图片) keep the fragment as main and append a ref.
 */
export function chooseMergeMain(
  fragment: MergeTask,
  dep: MergeTask,
): MergeMainChoice {
  if (depHasSubstance(dep)) {
    return {
      main: dep,
      payload: fragmentPayload(fragment),
      deleteFragment: true,
    };
  }
  return {
    main: fragment,
    payload: mediaOrTaskRef(dep),
    deleteFragment: false,
  };
}

/**
 * Append fragment payload to context content with a markdown `---` separator.
 * Idempotent: if the payload is already present, return the existing content.
 */
export function appendFragmentContent(
  existing: string | undefined | null,
  payload: string,
): { content: string; appended: boolean } {
  const base = existing ?? "";
  if (payload.length > 0 && contentAlreadyHasPayload(base, payload)) {
    return { content: base, appended: false };
  }
  return { content: `${base}${APPEND_SEPARATOR}${payload}`, appended: true };
}

export function contentAlreadyHasPayload(
  content: string,
  payload: string,
): boolean {
  if (payload.length === 0) return true;
  if (content.includes(`${APPEND_SEPARATOR}${payload}`)) return true;
  if (content === payload) return true;
  return false;
}

export function findDependencyCandidates(
  fragment: MergeTask,
  pool: MergeTask[],
): MergeTask[] {
  const anchorMs = parseCreatedTimeMs(fragment.createdTime);
  if (anchorMs === null) return [];
  return pool.filter((task) => {
    if (task.id === fragment.id) return false;
    if (task.projectId !== fragment.projectId) return false;
    if (!hasWeChatCaptureTag(task.tags)) return false;
    if (isBotFragment(task)) return false;
    if (hasNotMarker(task.title)) return false;
    const ms = parseCreatedTimeMs(task.createdTime);
    if (ms === null) return false;
    return isInDependencyWindow(anchorMs, ms);
  });
}

/**
 * Plan merge / `@not` / skip for each dependency fragment.
 * 0 candidates → skip this run (retry next Cron).
 * 1 candidate → merge.
 * ≥2 candidates → rewrite `@bot` → `@not` and tag `freeze` (caller writes).
 * Already `@not` or `freeze` → do not auto-merge.
 */
export function planFragmentActions(tasks: MergeTask[]): FragmentPlan {
  const fragments = tasks
    .filter((task) => isBotFragment(task))
    .slice()
    .sort((a, b) => {
      const am = parseCreatedTimeMs(a.createdTime) ?? Number.POSITIVE_INFINITY;
      const bm = parseCreatedTimeMs(b.createdTime) ?? Number.POSITIVE_INFINITY;
      if (am !== bm) return am - bm;
      return a.id.localeCompare(b.id);
    });

  const merges: DepMerge[] = [];
  const nots: MergeTask[] = [];
  const skipped: SkippedFragment[] = [];

  for (const fragment of fragments) {
    if (shouldSkipAutoMerge(fragment)) {
      continue;
    }
    const anchorMs = parseCreatedTimeMs(fragment.createdTime);
    if (anchorMs === null) {
      skipped.push({ fragment, reason: "no_created_time" });
      continue;
    }
    const candidates = findDependencyCandidates(fragment, tasks);
    if (candidates.length === 0) {
      skipped.push({ fragment, reason: "waiting_deps" });
      continue;
    }
    if (candidates.length >= 2) {
      nots.push(fragment);
      continue;
    }
    merges.push({ fragment, dep: candidates[0] });
  }

  return { merges, nots, skipped };
}

export function shanghaiCalendarDate(
  at: Date,
  timeZone = "Asia/Shanghai",
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function daysUntil(expiresAtMs: number, nowMs: number): number {
  return (expiresAtMs - nowMs) / (24 * 60 * 60 * 1000);
}

/** Prefer filter hits; unknown tags are still claimable (filter asked for todo). */
export function isTodoClaimCandidate(tags: string[] | undefined): boolean {
  if (tags === undefined) return true;
  return tags.includes(BOT_TAG_TODO);
}
