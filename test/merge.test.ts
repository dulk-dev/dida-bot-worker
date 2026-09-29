import { describe, expect, it } from "vitest";
import { SubrequestBudget } from "../src/budget.ts";
import type {
  CreateTagInput,
  DidaApi,
  DidaTag,
  DidaTask,
  TaskUpdateFields,
} from "../src/dida.ts";
import {
  claimTodoTasks,
  dispatchBotWork,
  mergeFragments,
  runMerge,
} from "../src/merge.ts";
import type { MergeTask } from "../src/merge-logic.ts";
import {
  APPEND_SEPARATOR,
  BOT_TAG_DOING,
  BOT_TAG_FREEZE,
  BOT_TAG_TODO,
  MERGE_CLASSIC_COST,
  WECHAT_CAPTURE_TAG,
} from "../src/constants.ts";

class MemoryApi implements DidaApi {
  readonly tasks: Map<string, DidaTask>;
  tags: DidaTag[];
  deleted: string[] = [];
  updates: Array<{ id: string; content: string }> = [];
  tagUpdates: Array<{ id: string; tags: string[] }> = [];
  titleUpdates: Array<{ id: string; title: string }> = [];
  createdTags: CreateTagInput[] = [];
  filterCalls: string[][] = [];
  callLog: string[] = [];

  constructor(
    tasks: DidaTask[],
    tags: DidaTag[] = [],
    private readonly budget?: SubrequestBudget,
  ) {
    this.tasks = new Map(
      tasks.map((t) => [t.id, { ...t, tags: t.tags ? [...t.tags] : undefined }]),
    );
    this.tags = tags.map((t) => ({ ...t }));
  }

  private count(label: string): void {
    this.callLog.push(label);
    this.budget?.record(1);
  }

  async searchUnfinished(): Promise<DidaTask[]> {
    this.count("search");
    return [...this.tasks.values()].filter((t) => (t.status ?? 0) === 0);
  }

  async listInbox(): Promise<DidaTask[]> {
    this.count("inbox");
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  async getTask(_projectId: string, taskId: string): Promise<DidaTask> {
    this.count(`get:${taskId}`);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`missing ${taskId}`);
    return { ...task, tags: task.tags ? [...task.tags] : undefined };
  }

  async updateTask(
    taskId: string,
    projectId: string,
    fields: TaskUpdateFields,
  ): Promise<void> {
    this.count(`update:${taskId}`);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`missing ${taskId}`);
    if (fields.content !== undefined) {
      task.content = fields.content;
      this.updates.push({ id: taskId, content: fields.content });
    }
    if (fields.tags !== undefined) {
      task.tags = [...fields.tags];
      this.tagUpdates.push({ id: taskId, tags: [...fields.tags] });
    }
    if (fields.title !== undefined) {
      task.title = fields.title;
      this.titleUpdates.push({ id: taskId, title: fields.title });
    }
    void projectId;
  }

  async updateTaskContent(
    taskId: string,
    projectId: string,
    content: string,
  ): Promise<void> {
    await this.updateTask(taskId, projectId, { content });
  }

  async updateTaskTags(
    taskId: string,
    projectId: string,
    tags: string[],
  ): Promise<void> {
    await this.updateTask(taskId, projectId, { tags });
  }

  async updateTaskTitle(
    taskId: string,
    projectId: string,
    title: string,
  ): Promise<void> {
    await this.updateTask(taskId, projectId, { title });
  }

  async filterByTag(tags: string[]): Promise<DidaTask[]> {
    this.count("filter");
    this.filterCalls.push([...tags]);
    return [...this.tasks.values()]
      .filter((t) => (t.status ?? 0) === 0)
      .filter((t) => tags.every((tag) => t.tags?.includes(tag)))
      .map((t) => ({ ...t, tags: t.tags ? [...t.tags] : undefined }));
  }

  async listTags(): Promise<DidaTag[]> {
    this.count("listTags");
    return this.tags.map((t) => ({ ...t }));
  }

  async createTag(tag: CreateTagInput): Promise<void> {
    this.count("createTag");
    this.createdTags.push({ ...tag });
    this.tags.push({
      name: tag.name,
      label: tag.label ?? tag.name,
      parent: tag.parent ?? null,
      color: tag.color ?? null,
    });
  }

  async deleteTask(_projectId: string, taskId: string): Promise<void> {
    this.count(`delete:${taskId}`);
    this.tasks.delete(taskId);
    this.deleted.push(taskId);
  }
}

class MemoryKv {
  processed = new Set<string>();
  async isProcessed(id: string): Promise<boolean> {
    return this.processed.has(id);
  }
  async markProcessed(id: string): Promise<void> {
    this.processed.add(id);
  }
}

const lifecycleTags: DidaTag[] = [
  { name: "bot" },
  { name: "todo", parent: "bot" },
  { name: "doing", parent: "bot" },
  { name: "done", parent: "bot" },
  { name: "freeze", parent: "bot" },
];

function mt(
  partial: Partial<MergeTask> & Pick<MergeTask, "id" | "title">,
): MergeTask {
  return {
    projectId: "inbox1",
    content: "",
    createdTime: "2026-09-04T10:11:12+0800",
    status: 0,
    ...partial,
  };
}

function ctx(
  partial: Partial<MergeTask> & Pick<MergeTask, "id" | "title">,
): MergeTask {
  return mt({
    tags: [WECHAT_CAPTURE_TAG],
    content: "聊天正文",
    ...partial,
  });
}

function okWebhook(): ClaimHooks {
  return {
    webhookConfigured: true,
    budget: new SubrequestBudget(),
    postWork: async () => ({ ok: true, status: 200 }),
  };
}

type ClaimHooks = Parameters<typeof claimTodoTasks>[3];

describe("mergeFragments", () => {
  it("appends, verifies, deletes the fragment, tags todo, and records processed id", async () => {
    const context = ctx({
      id: "ctx",
      title: "微信转发",
    });
    const fragment = mt({
      id: "frag",
      title: "@bot 总结",
    });
    const api = new MemoryApi([context, fragment]);
    const kv = new MemoryKv();
    const result = await mergeFragments(api, kv, [context, fragment]);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toMatchObject({
      fragmentId: "frag",
      contextId: "ctx",
    });
    expect(api.deleted).toEqual(["frag"]);
    expect(kv.processed.has("frag")).toBe(true);
    expect(api.tasks.get("ctx")?.content).toBe(
      `聊天正文${APPEND_SEPARATOR}@bot 总结`,
    );
    expect(api.tasks.get("ctx")?.tags).toEqual([
      WECHAT_CAPTURE_TAG,
      BOT_TAG_TODO,
    ]);
  });

  it("rewrites @bot to @not when two capture deps sit in the window", async () => {
    const fragment = mt({ id: "frag", title: "@bot x" });
    const a = ctx({ id: "a", title: "one", content: "a" });
    const b = ctx({
      id: "b",
      title: "two",
      content: "b",
      createdTime: "2026-09-04T10:11:17+0800",
    });
    const api = new MemoryApi([fragment, a, b]);
    const kv = new MemoryKv();
    const result = await mergeFragments(api, kv, [fragment, a, b]);
    expect(result.merges).toEqual([]);
    expect(result.nots).toEqual([{ fragmentId: "frag", title: "@not x" }]);
    expect(api.deleted).toEqual([]);
    expect(api.tasks.get("frag")?.title).toBe("@not x");
    expect(api.tasks.get("frag")?.tags).toEqual([BOT_TAG_FREEZE]);
    expect(api.tasks.has("frag")).toBe(true);
  });

  it("adds freeze on @not rewrite and keeps 微信采集 plus other tags", async () => {
    const fragment = mt({
      id: "frag",
      title: "@bot x",
      tags: [WECHAT_CAPTURE_TAG, "urgent"],
    });
    const a = ctx({ id: "a", title: "one", content: "a" });
    const b = ctx({
      id: "b",
      title: "two",
      content: "b",
      createdTime: "2026-09-04T10:11:17+0800",
    });
    const api = new MemoryApi([fragment, a, b]);
    const kv = new MemoryKv();
    const result = await mergeFragments(api, kv, [fragment, a, b]);
    expect(result.merges).toEqual([]);
    expect(result.nots).toEqual([{ fragmentId: "frag", title: "@not x" }]);
    expect(api.tasks.get("frag")?.title).toBe("@not x");
    expect(api.tasks.get("frag")?.tags).toEqual([
      WECHAT_CAPTURE_TAG,
      "urgent",
      BOT_TAG_FREEZE,
    ]);
    expect(api.titleUpdates).toEqual([{ id: "frag", title: "@not x" }]);
    expect(api.tagUpdates).toEqual([
      { id: "frag", tags: [WECHAT_CAPTURE_TAG, "urgent", BOT_TAG_FREEZE] },
    ]);
  });

  it("does not auto-merge a freeze-tagged fragment even with one dep", async () => {
    const context = ctx({ id: "ctx", title: "chat" });
    const fragment = mt({
      id: "frag",
      title: "@bot x",
      tags: [BOT_TAG_FREEZE],
    });
    const api = new MemoryApi([context, fragment]);
    const kv = new MemoryKv();
    const result = await mergeFragments(api, kv, [context, fragment]);
    expect(result.merges).toEqual([]);
    expect(result.nots).toEqual([]);
    expect(api.deleted).toEqual([]);
    expect(api.tasks.get("frag")?.title).toBe("@bot x");
    expect(api.tasks.get("ctx")?.content).toBe("聊天正文");
    expect(api.tagUpdates).toEqual([]);
    expect(api.titleUpdates).toEqual([]);
  });

  it("skips already-processed fragment ids", async () => {
    const context = ctx({ id: "ctx", title: "chat" });
    const fragment = mt({ id: "frag", title: "@bot x" });
    const api = new MemoryApi([context, fragment]);
    const kv = new MemoryKv();
    kv.processed.add("frag");
    const result = await mergeFragments(api, kv, [context, fragment]);
    expect(result.merges).toEqual([]);
    expect(result.skipped.some((s) => s.reason === "already_processed")).toBe(
      true,
    );
    expect(api.deleted).toEqual([]);
  });

  it("does not delete the fragment if readback verification fails", async () => {
    const context = ctx({ id: "ctx", title: "chat" });
    const fragment = mt({ id: "frag", title: "@bot x" });
    const api = new MemoryApi([context, fragment]);
    const originalUpdate = api.updateTask.bind(api);
    api.updateTask = async (id, projectId, fields) => {
      await originalUpdate(id, projectId, { ...fields, content: "tampered" });
    };
    const kv = new MemoryKv();
    const result = await mergeFragments(api, kv, [context, fragment]);
    expect(result.merges).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("verify_failed");
    expect(api.deleted).toEqual([]);
    expect(kv.processed.has("frag")).toBe(false);
  });

  it("keeps the fragment as main when the only dep is 来自微信的图片", async () => {
    const fragment = mt({ id: "frag", title: "@bot 看看图" });
    const img = ctx({
      id: "img",
      title: "来自微信的图片",
      content: "",
    });
    const api = new MemoryApi([fragment, img]);
    const kv = new MemoryKv();
    const result = await mergeFragments(api, kv, [fragment, img]);
    expect(result.merges[0]).toMatchObject({
      fragmentId: "frag",
      contextId: "frag",
    });
    expect(api.deleted).toEqual([]);
    expect(api.tasks.get("frag")?.content).toContain("来自微信的图片 (taskId: img)");
    expect(api.tasks.get("frag")?.tags).toEqual([BOT_TAG_TODO]);
    expect(api.tasks.has("img")).toBe(true);
  });

  it("unions search @bot hits with inbox neighbors that do not contain @bot", async () => {
    const context = ctx({
      id: "ctx",
      title: "微信转发",
    });
    const fragment = mt({
      id: "frag",
      title: "@bot 总结",
    });
    const api = new MemoryApi([context, fragment]);
    api.searchUnfinished = async () => {
      api.callLog.push("search");
      return [fragment];
    };
    api.listInbox = async () => {
      api.callLog.push("inbox");
      return [context, fragment];
    };
    const kv = new MemoryKv();
    const result = await runMerge(api, kv);
    expect(result.searched).toBe(1);
    expect(result.inbox).toBe(2);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0].contextId).toBe("ctx");
    expect(api.deleted).toEqual(["frag"]);
  });

  it("stops on budget without starting a partial merge", async () => {
    const context = ctx({ id: "ctx", title: "chat" });
    const fragment = mt({ id: "frag", title: "@bot x" });
    const budget = new SubrequestBudget(MERGE_CLASSIC_COST - 1);
    const api = new MemoryApi([context, fragment], [], budget);
    const kv = new MemoryKv();
    const result = await mergeFragments(
      api,
      kv,
      [context, fragment],
      budget,
    );
    expect(result.merges).toEqual([]);
    expect(result.skipped.some((s) => s.reason === "budget")).toBe(true);
    expect(api.updates).toEqual([]);
    expect(api.deleted).toEqual([]);
    expect(api.tasks.get("ctx")?.content).toBe("聊天正文");
    expect(budget.stopped).toBe("budget");
    expect(api.callLog.some((c) => c.startsWith("update:"))).toBe(false);
    expect(api.callLog.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  it("completes one full merge then stops before a second when budget is tight", async () => {
    const ctxA = ctx({
      id: "ctxA",
      title: "one",
      createdTime: "2026-09-04T10:11:12+0800",
    });
    const fragA = mt({
      id: "fragA",
      title: "@bot a",
      createdTime: "2026-09-04T10:11:12+0800",
    });
    const ctxB = ctx({
      id: "ctxB",
      title: "two",
      createdTime: "2026-09-04T10:12:00+0800",
    });
    const fragB = mt({
      id: "fragB",
      title: "@bot b",
      createdTime: "2026-09-04T10:12:00+0800",
    });
    const budget = new SubrequestBudget(MERGE_CLASSIC_COST);
    const api = new MemoryApi([ctxA, fragA, ctxB, fragB], [], budget);
    const kv = new MemoryKv();
    const result = await mergeFragments(
      api,
      kv,
      [ctxA, fragA, ctxB, fragB],
      budget,
    );
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0].fragmentId).toBe("fragA");
    expect(api.deleted).toEqual(["fragA"]);
    expect(api.tasks.has("fragB")).toBe(true);
    expect(api.tasks.get("ctxB")?.content).toBe("聊天正文");
    expect(budget.stopped).toBe("budget");
  });
});

describe("claimTodoTasks webhook-before-doing", () => {
  it("posts webhook before flipping todo to doing", async () => {
    const order: string[] = [];
    const hand = mt({
      id: "hand",
      title: "手工待办",
      content: "没有机器人标记",
      tags: [BOT_TAG_TODO, "keep"],
    });
    const api = new MemoryApi([hand], lifecycleTags);
    const origTags = api.updateTaskTags.bind(api);
    api.updateTaskTags = async (id, projectId, tags) => {
      order.push("doing");
      return origTags(id, projectId, tags);
    };
    const pending = await claimTodoTasks(api, [hand], new Set(), {
      webhookConfigured: true,
      budget: new SubrequestBudget(),
      postWork: async () => {
        order.push("webhook");
        return { ok: true, status: 200 };
      },
    });
    expect(order).toEqual(["webhook", "doing"]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      taskId: "hand",
      reason: "standalone",
      lifecycle: "doing",
    });
    expect(api.tasks.get("hand")?.tags).toEqual(["keep", BOT_TAG_DOING]);
  });

  it("does not flip doing if webhook fails", async () => {
    const hand = mt({
      id: "hand",
      title: "手工待办",
      tags: [BOT_TAG_TODO],
    });
    const api = new MemoryApi([hand], lifecycleTags);
    const pending = await claimTodoTasks(api, [hand], new Set(), {
      webhookConfigured: true,
      budget: new SubrequestBudget(),
      postWork: async () => ({ ok: false, status: 502 }),
    });
    expect(pending).toEqual([]);
    expect(api.tasks.get("hand")?.tags).toEqual([BOT_TAG_TODO]);
    expect(api.tagUpdates).toEqual([]);
  });

  it("skips claim mutations when webhook is not configured", async () => {
    const hand = mt({
      id: "hand",
      title: "手工待办",
      tags: [BOT_TAG_TODO],
    });
    const api = new MemoryApi([hand], lifecycleTags);
    const pending = await claimTodoTasks(api, [hand], new Set(), {
      webhookConfigured: false,
      budget: new SubrequestBudget(),
      postWork: async () => {
        throw new Error("should not post");
      },
    });
    expect(pending).toEqual([]);
    expect(api.tasks.get("hand")?.tags).toEqual([BOT_TAG_TODO]);
  });
});

describe("dispatchBotWork", () => {
  it("creates missing bot lifecycle tags then claims a hand-tagged todo after webhook", async () => {
    const solo = mt({
      id: "solo",
      title: "手工待办",
      content: "没有 @bot 也不该自动打标",
      tags: ["urgent", BOT_TAG_TODO],
    });
    const api = new MemoryApi([solo]);
    const pending = await dispatchBotWork(api, [solo], [], okWebhook());
    expect(api.createdTags).toEqual([
      { name: "bot", label: "bot" },
      { name: "todo", label: "todo", parent: "bot" },
      { name: "doing", label: "doing", parent: "bot" },
      { name: "done", label: "done", parent: "bot" },
      { name: "freeze", label: "freeze", parent: "bot" },
    ]);
    expect(api.filterCalls).toEqual([["todo"]]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      taskId: "solo",
      reason: "standalone",
      lifecycle: "doing",
    });
    expect(api.tasks.get("solo")?.tags).toEqual(["urgent", BOT_TAG_DOING]);
  });

  it("does not re-claim doing tasks and skips unmerged fragments", async () => {
    const doing = mt({
      id: "doing",
      title: "进行中",
      content: "body @bot",
      tags: [BOT_TAG_DOING],
    });
    const frag = mt({
      id: "frag",
      title: "@bot 碎片",
      content: "",
      tags: [BOT_TAG_TODO],
    });
    const api = new MemoryApi([doing, frag], lifecycleTags);
    const pending = await dispatchBotWork(api, [doing, frag], [], okWebhook());
    expect(pending).toEqual([]);
    expect(api.tasks.get("doing")?.tags).toEqual([BOT_TAG_DOING]);
    expect(api.tasks.get("frag")?.tags).toEqual([BOT_TAG_TODO]);
  });

  it("does not auto-todo a standalone @bot title without leaf todo", async () => {
    const solo = mt({
      id: "solo",
      title: "手动任务 @bot",
      content: "说明\n@bot 修 bug",
      tags: ["urgent"],
    });
    const api = new MemoryApi([solo], lifecycleTags);
    const pending = await dispatchBotWork(api, [solo], [], okWebhook());
    expect(pending).toEqual([]);
    expect(api.tasks.get("solo")?.tags).toEqual(["urgent"]);
  });

  it("claims a merged context that already has leaf todo", async () => {
    const ctxTask = ctx({
      id: "ctx",
      title: "微信转发",
      tags: [WECHAT_CAPTURE_TAG, BOT_TAG_TODO],
    });
    const api = new MemoryApi([ctxTask], lifecycleTags);
    const pending = await dispatchBotWork(
      api,
      [ctxTask],
      [{ contextId: "ctx" }],
      okWebhook(),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      taskId: "ctx",
      reason: "merged",
      lifecycle: "doing",
    });
  });
});
