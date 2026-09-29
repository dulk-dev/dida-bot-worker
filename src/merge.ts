import { SubrequestBudget } from "./budget.ts";
import {
  BOT_MARKER,
  BOT_NESTED_TAGS,
  BOT_TAG_DOING,
  BOT_TAG_PARENT,
  BOT_TAG_TODO,
  CLAIM_TAG_COST,
  CLAIM_WEBHOOK_COST,
  DIDA_API_BASE,
  HYDRATE_COST,
  MAX_CLAIM,
  MAX_HYDRATE,
  MAX_MERGE_OR_NOT,
  MERGE_CLASSIC_COST,
  MERGE_MEDIA_COST,
  NOT_REWRITE_COST,
  SHANGHAI_TZ,
  withBotLifecycleTag,
  withFreezeTag,
} from "./constants.ts";
import type { CreateTagInput, DidaApi, DidaTask } from "./dida.ts";
import { DidaApiError, DidaClient } from "./dida.ts";
import {
  acquireMergeLock,
  getExpiryReminderDate,
  isFragmentProcessed,
  loadAccessToken,
  markFragmentProcessed,
  releaseMergeLock,
  setExpiryReminderDate,
} from "./kv.ts";
import {
  appendFragmentContent,
  chooseMergeMain,
  contentAlreadyHasPayload,
  createdTimeSecond,
  daysUntil,
    isBotFragment,
    isTodoClaimCandidate,
    planFragmentActions,
    rewriteBotTitleToNot,
    shanghaiCalendarDate,
    shouldSkipAutoMerge,
    type DepMerge,
  type MergeTask,
  type SkipReason,
} from "./merge-logic.ts";
import {
  parseWebhookAuthStyle,
  postWebhook,
  type MergeSummaryItem,
  type PendingBotItem,
} from "./webhook.ts";

export interface MergeRunResult {
  ok: boolean;
  locked?: boolean;
  error?: string;
  searched: number;
  inbox: number;
  pool: number;
  fragments: number;
  mergedCount: number;
  notted: number;
  claimed: number;
  subrequestsUsed: number;
  stopped?: "budget";
  skipped: Array<{ fragmentId: string; reason: SkipReason | string }>;
  merges: MergeSummaryItem[];
  nots: Array<{ fragmentId: string; title: string }>;
  pending: PendingBotItem[];
  webhook?: { work?: number; expiry?: number };
  tokenExpiresAt?: string;
}

interface MergeKv {
  isProcessed(fragmentId: string): Promise<boolean>;
  markProcessed(fragmentId: string): Promise<void>;
}

function emptyResult(
  extra: Partial<MergeRunResult> & Pick<MergeRunResult, "ok">,
): MergeRunResult {
  return {
    searched: 0,
    inbox: 0,
    pool: 0,
    fragments: 0,
    mergedCount: 0,
    notted: 0,
    claimed: 0,
    subrequestsUsed: 0,
    skipped: [],
    merges: [],
    nots: [],
    pending: [],
    ...extra,
  };
}

function toMergeTask(task: DidaTask): MergeTask | null {
  if (!task.id || !task.projectId) return null;
  const status = task.status ?? 0;
  if (status !== 0) return null;
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title ?? "",
    content: task.content ?? "",
    createdTime: task.createdTime ?? undefined,
    status,
    tags: task.tags,
  };
}

function needsDetail(task: DidaTask): boolean {
  // Free Workers allow only ~50 external subrequests. Inbox list payloads
  // often omit `content`; do NOT hydrate the whole inbox for that.
  // Pairing needs createdTime + projectId; content is fetched in executeMerge.
  return !task.createdTime || !task.projectId;
}

function unionTasks(search: DidaTask[], inbox: DidaTask[]): DidaTask[] {
  const map = new Map<string, DidaTask>();
  for (const task of [...search, ...inbox]) {
    const existing = map.get(task.id);
    if (!existing) {
      map.set(task.id, task);
      continue;
    }
    map.set(task.id, {
      ...existing,
      ...task,
      title: task.title ?? existing.title,
      content: task.content ?? existing.content,
      createdTime: task.createdTime ?? existing.createdTime,
      projectId: task.projectId || existing.projectId,
      tags: task.tags ?? existing.tags,
    });
  }
  return [...map.values()];
}

async function hydrateMissing(
  api: DidaApi,
  tasks: DidaTask[],
  skipped: MergeRunResult["skipped"],
  budget: SubrequestBudget,
): Promise<DidaTask[]> {
  const out: DidaTask[] = [];
  let hydrates = 0;
  for (const task of tasks) {
    if (!needsDetail(task) || !task.projectId) {
      out.push(task);
      continue;
    }
    if (hydrates >= MAX_HYDRATE || !budget.canAfford(HYDRATE_COST)) {
      if (!budget.canAfford(HYDRATE_COST)) budget.markStopped();
      out.push(task);
      continue;
    }
    hydrates += 1;
    try {
      const detail = await api.getTask(task.projectId, task.id);
      out.push({
        ...task,
        ...detail,
        title: detail.title ?? task.title,
        content: detail.content ?? task.content,
        createdTime: detail.createdTime ?? task.createdTime,
        projectId: detail.projectId || task.projectId,
        tags: detail.tags ?? task.tags,
      });
    } catch (error) {
      skipped.push({
        fragmentId: task.id,
        reason: `hydrate_failed:${error instanceof Error ? error.message : "unknown"}`,
      });
      out.push(task);
    }
  }
  return out;
}

export async function mergeFragments(
  api: DidaApi,
  kv: MergeKv,
  tasks: MergeTask[],
  budget: SubrequestBudget = new SubrequestBudget(),
): Promise<{
  merges: MergeSummaryItem[];
  nots: Array<{ fragmentId: string; title: string }>;
  skipped: MergeRunResult["skipped"];
}> {
  const skipped: MergeRunResult["skipped"] = [];
  const eligible: MergeTask[] = [];

  for (const task of tasks) {
    if (!isBotFragment(task)) {
      eligible.push(task);
      continue;
    }
    if (shouldSkipAutoMerge(task)) {
      continue;
    }
    if (await kv.isProcessed(task.id)) {
      skipped.push({ fragmentId: task.id, reason: "already_processed" });
      continue;
    }
    eligible.push(task);
  }

  const planned = planFragmentActions(eligible);
  for (const item of planned.skipped) {
    skipped.push({ fragmentId: item.fragment.id, reason: item.reason });
  }

  const actions: Array<
    | { kind: "merge"; merge: DepMerge }
    | { kind: "not"; fragment: MergeTask }
  > = [];
  for (const merge of planned.merges) {
    actions.push({ kind: "merge", merge });
  }
  for (const fragment of planned.nots) {
    actions.push({ kind: "not", fragment });
  }
  actions.sort((a, b) => {
    const aTask = a.kind === "merge" ? a.merge.fragment : a.fragment;
    const bTask = b.kind === "merge" ? b.merge.fragment : b.fragment;
    const at = aTask.createdTime ?? "";
    const bt = bTask.createdTime ?? "";
    if (at !== bt) return at.localeCompare(bt);
    return aTask.id.localeCompare(bTask.id);
  });

  const merges: MergeSummaryItem[] = [];
  const nots: Array<{ fragmentId: string; title: string }> = [];
  let acted = 0;

  for (const action of actions) {
    if (acted >= MAX_MERGE_OR_NOT) break;
    if (action.kind === "merge") {
      const choice = chooseMergeMain(action.merge.fragment, action.merge.dep);
      const cost = choice.deleteFragment ? MERGE_CLASSIC_COST : MERGE_MEDIA_COST;
      if (!budget.canAfford(cost)) {
        budget.markStopped();
        skipped.push({
          fragmentId: action.merge.fragment.id,
          reason: "budget",
        });
        break;
      }
      const result = await executeMerge(api, kv, action.merge);
      if (result.ok) {
        merges.push(result.merge);
        acted += 1;
      } else if (result.reason === "budget") {
        budget.markStopped();
        break;
      } else {
        skipped.push({
          fragmentId: action.merge.fragment.id,
          reason: result.reason,
        });
      }
      continue;
    }

    if (!budget.canAfford(NOT_REWRITE_COST)) {
      budget.markStopped();
      skipped.push({ fragmentId: action.fragment.id, reason: "budget" });
      break;
    }
    const rewritten = await executeNotRewrite(api, action.fragment);
    if (rewritten.ok) {
      nots.push(rewritten.not);
      acted += 1;
    } else if (rewritten.reason === "budget") {
      budget.markStopped();
      break;
    } else {
      skipped.push({
        fragmentId: action.fragment.id,
        reason: rewritten.reason,
      });
    }
  }

  return { merges, nots, skipped };
}

async function executeNotRewrite(
  api: DidaApi,
  fragment: MergeTask,
): Promise<
  | { ok: true; not: { fragmentId: string; title: string } }
  | { ok: false; reason: string }
> {
  const nextTitle = rewriteBotTitleToNot(fragment.title);
  const nextTags = withFreezeTag(fragment.tags);
  const titleChanged = nextTitle !== fragment.title;
  const tagsChanged =
    JSON.stringify(fragment.tags ?? []) !== JSON.stringify(nextTags);
  if (!titleChanged && !tagsChanged) {
    return { ok: false, reason: "not_rewrite_noop" };
  }
  try {
    await api.updateTask(fragment.id, fragment.projectId, {
      ...(titleChanged ? { title: nextTitle } : {}),
      ...(tagsChanged ? { tags: nextTags } : {}),
    });
    return { ok: true, not: { fragmentId: fragment.id, title: nextTitle } };
  } catch (error) {
    return {
      ok: false,
      reason: `not_error:${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

async function executeMerge(
  api: DidaApi,
  kv: MergeKv,
  pair: DepMerge,
): Promise<
  | { ok: true; merge: MergeSummaryItem }
  | { ok: false; reason: string }
> {
  const choice = chooseMergeMain(pair.fragment, pair.dep);
  try {
    let main: MergeTask = choice.main;
    if (choice.deleteFragment) {
      const detail = await api.getTask(pair.dep.projectId, pair.dep.id);
      main = {
        ...pair.dep,
        content: detail.content ?? pair.dep.content,
        title: detail.title ?? pair.dep.title,
        createdTime: detail.createdTime ?? pair.dep.createdTime,
        projectId: detail.projectId || pair.dep.projectId,
        tags: detail.tags ?? pair.dep.tags,
      };
    }

    const { content: nextContent } = appendFragmentContent(
      main.content,
      choice.payload,
    );
    const nextTags = withBotLifecycleTag(main.tags, BOT_TAG_TODO);
    const needContent = !contentAlreadyHasPayload(main.content, choice.payload);
    const needTags =
      JSON.stringify(main.tags ?? []) !== JSON.stringify(nextTags);
    if (needContent || needTags) {
      await api.updateTask(main.id, main.projectId, {
        content: nextContent,
        tags: nextTags,
      });
    }

    const readback = await api.getTask(main.projectId, main.id);
    const readContent = readback.content ?? "";
    if (
      !contentAlreadyHasPayload(readContent, choice.payload) &&
      !readContent.includes(choice.payload)
    ) {
      return { ok: false, reason: "verify_failed" };
    }

    if (choice.deleteFragment) {
      await api.deleteTask(pair.fragment.projectId, pair.fragment.id);
    }
    await kv.markProcessed(pair.fragment.id);

    return {
      ok: true,
      merge: {
        fragmentId: pair.fragment.id,
        contextId: main.id,
        fragmentTitle: pair.fragment.title,
        contextTitle: main.title,
        createdSecond:
          createdTimeSecond(pair.fragment.createdTime) ??
          pair.fragment.createdTime ??
          "",
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `merge_error:${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

async function createTagIfMissing(
  api: DidaApi,
  tag: CreateTagInput,
): Promise<void> {
  try {
    await api.createTag(tag);
  } catch (error) {
    if (
      error instanceof DidaApiError &&
      (error.status === 400 || error.status === 409)
    ) {
      console.log(
        JSON.stringify({
          msg: "dida_create_tag_exists",
          name: tag.name,
          status: error.status,
        }),
      );
      return;
    }
    throw error;
  }
}

/** GET /tag then POST /tag for missing parent `bot` and nested leaves. */
export async function ensureBotTags(api: DidaApi): Promise<void> {
  const existing = await api.listTags();
  const names = new Set(existing.map((tag) => tag.name));
  if (!names.has(BOT_TAG_PARENT)) {
    await createTagIfMissing(api, {
      name: BOT_TAG_PARENT,
      label: BOT_TAG_PARENT,
    });
    names.add(BOT_TAG_PARENT);
  }
  for (const leaf of BOT_NESTED_TAGS) {
    if (names.has(leaf)) continue;
    await createTagIfMissing(api, {
      name: leaf,
      label: leaf,
      parent: BOT_TAG_PARENT,
    });
    names.add(leaf);
  }
}

/** @alias ensureBotTags */
export const ensureBotLifecycleTags = ensureBotTags;

async function resolveTaskTags(
  api: DidaApi,
  task: { id: string; projectId: string; tags?: string[] },
): Promise<{ tags: string[]; projectId: string } | null> {
  if (task.tags !== undefined && task.projectId) {
    return { tags: task.tags, projectId: task.projectId };
  }
  if (!task.projectId) return null;
  const detail = await api.getTask(task.projectId, task.id);
  return {
    tags: detail.tags ?? [],
    projectId: detail.projectId || task.projectId,
  };
}

export interface ClaimWorkOptions {
  webhookConfigured: boolean;
  postWork: (
    pending: PendingBotItem[],
  ) => Promise<{ ok: boolean; status: number }>;
  budget: SubrequestBudget;
  maxClaim?: number;
}

/**
 * Webhook first, then todo→doing only if the webhook succeeds.
 * If no webhook URL is configured, skip claim mutations.
 * Does not re-claim doing/done. Skips unmerged @bot fragments.
 */
export async function claimTodoTasks(
  api: DidaApi,
  todoTasks: DidaTask[],
  mergedIds: Set<string>,
  options: ClaimWorkOptions,
): Promise<PendingBotItem[]> {
  if (!options.webhookConfigured) {
    return [];
  }

  const maxClaim = options.maxClaim ?? MAX_CLAIM;
  const seen = new Set<string>();
  const candidates: DidaTask[] = [];
  for (const task of todoTasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (!isTodoClaimCandidate(task.tags)) continue;
    if (isBotFragment({ title: task.title, content: task.content, tags: task.tags })) continue;
    candidates.push(task);
    if (candidates.length >= maxClaim) break;
  }

  if (candidates.length === 0) return [];

  const affordable = Math.min(
    candidates.length,
    Math.max(0, options.budget.remaining() - CLAIM_WEBHOOK_COST) /
      CLAIM_TAG_COST,
  );
  const take = Math.floor(affordable);
  if (take < 1 || !options.budget.canAfford(CLAIM_WEBHOOK_COST + CLAIM_TAG_COST)) {
    options.budget.markStopped();
    return [];
  }

  const selected = candidates.slice(0, take);
  const pendingPreview: PendingBotItem[] = [];
  const resolved: Array<{
    task: DidaTask;
    tags: string[];
    projectId: string;
    next: string[];
  }> = [];

  for (const task of selected) {
    try {
      const info = await resolveTaskTags(api, task);
      if (!info) continue;
      if (!isTodoClaimCandidate(info.tags)) continue;
      const next = withBotLifecycleTag(info.tags, BOT_TAG_DOING);
      resolved.push({ task, tags: info.tags, projectId: info.projectId, next });
      pendingPreview.push({
        taskId: task.id,
        projectId: info.projectId,
        title: task.title ?? "",
        reason: mergedIds.has(task.id) ? "merged" : "standalone",
        tags: next,
        lifecycle: "doing",
      });
    } catch (error) {
      console.log(
        JSON.stringify({
          msg: "claim_resolve_failed",
          taskId: task.id,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  if (pendingPreview.length === 0) return [];

  if (
    !options.budget.canAfford(
      CLAIM_WEBHOOK_COST + pendingPreview.length * CLAIM_TAG_COST,
    )
  ) {
    options.budget.markStopped();
    return [];
  }

  const posted = await options.postWork(pendingPreview);
  options.budget.record(CLAIM_WEBHOOK_COST);
  if (!posted.ok) {
    console.log(
      JSON.stringify({
        msg: "webhook_work_failed",
        status: posted.status,
        pending: pendingPreview.length,
      }),
    );
    return [];
  }

  const claimed: PendingBotItem[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    try {
      await api.updateTaskTags(item.task.id, item.projectId, item.next);
      claimed.push(pendingPreview[i]);
    } catch (error) {
      console.log(
        JSON.stringify({
          msg: "claim_doing_failed",
          taskId: item.task.id,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
  return claimed;
}

/**
 * Ensure tags → filter todo → webhook → doing.
 * Does not auto-todo standalone `@bot` titles (those are fragments or user-tagged).
 */
export async function dispatchBotWork(
  api: DidaApi,
  poolTasks: MergeTask[],
  merges: Array<{ contextId: string }>,
  options: ClaimWorkOptions,
): Promise<PendingBotItem[]> {
  if (!options.budget.canAfford(1)) {
    options.budget.markStopped();
    return [];
  }
  await ensureBotTags(api);
  if (!options.webhookConfigured) {
    return [];
  }
  if (!options.budget.canAfford(1)) {
    options.budget.markStopped();
    return [];
  }
  const filtered = await api.filterByTag([BOT_TAG_TODO]);
  const byId = new Map<string, DidaTask>();
  for (const task of filtered) {
    byId.set(task.id, task);
  }
  const mergedIds = new Set(merges.map((item) => item.contextId));
  for (const task of poolTasks) {
    if (!mergedIds.has(task.id)) continue;
    if (byId.has(task.id)) continue;
    byId.set(task.id, {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      content: task.content,
      createdTime: task.createdTime,
      status: task.status,
      tags: task.tags?.includes(BOT_TAG_TODO)
        ? task.tags
        : withBotLifecycleTag(task.tags, BOT_TAG_TODO),
    });
  }
  return claimTodoTasks(api, [...byId.values()], mergedIds, options);
}

function kvAdapter(namespace: KVNamespace): MergeKv {
  return {
    isProcessed: (id) => isFragmentProcessed(namespace, id),
    markProcessed: (id) => markFragmentProcessed(namespace, id),
  };
}

export async function runMerge(
  api: DidaApi,
  kv: MergeKv,
  budget: SubrequestBudget = new SubrequestBudget(),
): Promise<{
  searched: number;
  inbox: number;
  pool: number;
  fragments: number;
  merges: MergeSummaryItem[];
  nots: Array<{ fragmentId: string; title: string }>;
  skipped: MergeRunResult["skipped"];
  poolTasks: MergeTask[];
}> {
  const skipped: MergeRunResult["skipped"] = [];
  const searched = await api.searchUnfinished(BOT_MARKER);
  const inbox = await api.listInbox();
  const combined = unionTasks(searched, inbox);
  const hydrated = await hydrateMissing(api, combined, skipped, budget);
  let pool = hydrated
    .map(toMergeTask)
    .filter((task): task is MergeTask => task !== null);

  const { merges, nots, skipped: mergeSkipped } = await mergeFragments(
    api,
    kv,
    pool,
    budget,
  );

  const deletedFragmentIds = new Set(
    merges
      .filter((m) => m.fragmentId !== m.contextId)
      .map((m) => m.fragmentId),
  );
  pool = pool.filter((task) => !deletedFragmentIds.has(task.id));
  for (const merge of merges) {
    const main = pool.find((task) => task.id === merge.contextId);
    if (main) {
      main.tags = withBotLifecycleTag(main.tags, BOT_TAG_TODO);
    }
  }

  return {
    searched: searched.length,
    inbox: inbox.length,
    pool: pool.length,
    fragments: pool.filter((task) => isBotFragment(task)).length,
    merges,
    nots,
    skipped: [...skipped, ...mergeSkipped],
    poolTasks: pool,
  };
}

function parseRemindDays(raw: string | undefined): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 14;
}

export async function runMergeAndNotify(env: Env): Promise<MergeRunResult> {
  const locked = await acquireMergeLock(env.TOKEN_KV);
  if (!locked) {
    return emptyResult({
      ok: false,
      locked: true,
      error: "merge_locked",
    });
  }

  const budget = new SubrequestBudget();

  try {
    const token = await loadAccessToken(
      env.TOKEN_KV,
      env.TOKEN_ENCRYPTION_KEY,
    );
    if (!token) {
      return emptyResult({
        ok: false,
        error: "missing_access_token",
      });
    }

    const api = new DidaClient(token.access_token, DIDA_API_BASE, () => {
      budget.record(1);
    });
    const result = await runMerge(api, kvAdapter(env.TOKEN_KV), budget);
    const mergedCount = result.merges.length;
    const notted = result.nots.length;
    const webhook: MergeRunResult["webhook"] = {};

    const webhookUrl = env.BOT_WEBHOOK_URL?.trim() ?? "";
    const webhookSecret = env.BOT_WEBHOOK_SECRET ?? "";
    const authStyle = parseWebhookAuthStyle(env.BOT_WEBHOOK_AUTH_STYLE);

    let workWebhookStatus: number | undefined;
    const pending = await dispatchBotWork(
      api,
      result.poolTasks,
      result.merges,
      {
        webhookConfigured: webhookUrl.length > 0,
        budget,
        postWork: async (items) => {
          const posted = await postWebhook(
            webhookUrl,
            webhookSecret,
            authStyle,
            {
              event: "dida_bot_work",
              source: "dida-bot-merge-worker",
              mergedCount,
              merges: result.merges,
              pending: items,
            },
          );
          workWebhookStatus = posted.status;
          return posted;
        },
      },
    );
    if (workWebhookStatus !== undefined) {
      webhook.work = workWebhookStatus;
    }

    const now = new Date();
    const expiresAtMs = Date.parse(token.expires_at);
    const remindDays = parseRemindDays(env.TOKEN_EXPIRY_REMIND_DAYS);
    if (Number.isFinite(expiresAtMs) && webhookUrl) {
      const remaining = daysUntil(expiresAtMs, now.getTime());
      if (remaining <= remindDays && budget.canAfford(1)) {
        const today = shanghaiCalendarDate(now, SHANGHAI_TZ);
        const last = await getExpiryReminderDate(env.TOKEN_KV);
        if (last !== today) {
          const posted = await postWebhook(
            webhookUrl,
            webhookSecret,
            authStyle,
            {
              event: "dida_token_expiry_reminder",
              source: "dida-bot-merge-worker",
              expiresAt: token.expires_at,
              daysRemaining: Math.max(0, Math.ceil(remaining)),
              shanghaiDate: today,
            },
          );
          budget.record(1);
          webhook.expiry = posted.status;
          if (posted.ok) {
            await setExpiryReminderDate(env.TOKEN_KV, today);
          } else {
            console.log(
              JSON.stringify({
                msg: "webhook_expiry_failed",
                status: posted.status,
              }),
            );
          }
        }
      }
    }

    const claimed = pending.length;
    console.log(
      JSON.stringify({
        msg: "merge_run",
        subrequests_used: budget.used,
        merged: mergedCount,
        notted,
        claimed,
        stopped: budget.stopped,
        searched: result.searched,
        inbox: result.inbox,
        pool: result.pool,
        fragments: result.fragments,
        skipped: result.skipped.length,
      }),
    );

    return {
      ok: true,
      searched: result.searched,
      inbox: result.inbox,
      pool: result.pool,
      fragments: result.fragments,
      mergedCount,
      notted,
      claimed,
      subrequestsUsed: budget.used,
      stopped: budget.stopped ?? undefined,
      skipped: result.skipped,
      merges: result.merges,
      nots: result.nots,
      pending,
      webhook,
      tokenExpiresAt: token.expires_at,
    };
  } finally {
    await releaseMergeLock(env.TOKEN_KV);
  }
}
