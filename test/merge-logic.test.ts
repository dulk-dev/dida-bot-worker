import { describe, expect, it } from "vitest";
import {
  APPEND_SEPARATOR,
  BOT_TAG_FREEZE,
  DEPENDENCY_WINDOW_AFTER_MS,
  DEPENDENCY_WINDOW_BEFORE_MS,
  NOT_MARKER,
  WECHAT_CAPTURE_TAG,
} from "../src/constants.ts";
import {
  appendFragmentContent,
  chooseMergeMain,
  contentAlreadyHasPayload,
  createdTimeSecond,
  daysUntil,
  findDependencyCandidates,
  fragmentPayload,
  isBotFragment,
  isInDependencyWindow,
  parseCreatedTimeMs,
  planFragmentActions,
  rewriteBotTitleToNot,
  shanghaiCalendarDate,
  shouldSkipAutoMerge,
  type MergeTask,
} from "../src/merge-logic.ts";

function task(
  partial: Partial<MergeTask> & Pick<MergeTask, "id">,
): MergeTask {
  return {
    projectId: "inbox",
    title: "",
    content: "",
    createdTime: "2026-09-04T10:11:12+0800",
    status: 0,
    ...partial,
  };
}

function capture(
  partial: Partial<MergeTask> & Pick<MergeTask, "id">,
): MergeTask {
  return task({
    tags: [WECHAT_CAPTURE_TAG],
    ...partial,
  });
}

describe("createdTimeSecond", () => {
  it("truncates timezone offset to YYYY-MM-DDTHH:MM:SS for display", () => {
    expect(createdTimeSecond("2026-04-07T09:25:00+0800")).toBe(
      "2026-04-07T09:25:00",
    );
  });

  it("drops fractional seconds", () => {
    expect(createdTimeSecond("2026-04-07T09:25:00.123+0000")).toBe(
      "2026-04-07T09:25:00",
    );
  });

  it("handles Z suffix", () => {
    expect(createdTimeSecond("2026-04-07T09:25:00Z")).toBe(
      "2026-04-07T09:25:00",
    );
  });

  it("returns null for missing or malformed values", () => {
    expect(createdTimeSecond(undefined)).toBeNull();
    expect(createdTimeSecond("")).toBeNull();
    expect(createdTimeSecond("not-a-date")).toBeNull();
  });
});

describe("parseCreatedTimeMs", () => {
  it("parses +0800 without a colon as a real instant", () => {
    const ms = parseCreatedTimeMs("2026-09-04T10:11:12+0800");
    expect(ms).toBe(Date.parse("2026-09-04T10:11:12+08:00"));
  });

  it("returns null for missing values", () => {
    expect(parseCreatedTimeMs(undefined)).toBeNull();
    expect(parseCreatedTimeMs("nope")).toBeNull();
  });
});

describe("isInDependencyWindow [T-10s, T+10s]", () => {
  const T = Date.parse("2026-09-04T10:11:12+08:00");

  it("includes the exact anchor T", () => {
    expect(isInDependencyWindow(T, T)).toBe(true);
  });

  it("includes T-BEFORE and T+AFTER bounds", () => {
    expect(isInDependencyWindow(T, T - DEPENDENCY_WINDOW_BEFORE_MS)).toBe(
      true,
    );
    expect(isInDependencyWindow(T, T + DEPENDENCY_WINDOW_AFTER_MS)).toBe(
      true,
    );
  });

  it("excludes 1ms outside either bound", () => {
    expect(
      isInDependencyWindow(T, T - DEPENDENCY_WINDOW_BEFORE_MS - 1),
    ).toBe(false);
    expect(
      isInDependencyWindow(T, T + DEPENDENCY_WINDOW_AFTER_MS + 1),
    ).toBe(false);
  });

  it("includes a neighbor a few seconds later (not same-second truncate)", () => {
    expect(isInDependencyWindow(T, T + 5_000)).toBe(true);
  });

  it("includes context a few seconds before T (forward chat first, then @bot)", () => {
    expect(isInDependencyWindow(T, T - 4_000)).toBe(true);
  });
});

describe("isBotFragment", () => {
  it("requires @bot in the title and empty/null content", () => {
    expect(
      isBotFragment({ title: "forwarded wechat", content: "hello" }),
    ).toBe(false);
    expect(isBotFragment({ title: "@bot summarize", content: "" })).toBe(
      true,
    );
    expect(isBotFragment({ title: "@bot summarize", content: null })).toBe(
      true,
    );
  });

  it("does not treat content-only @bot as a fragment", () => {
    expect(
      isBotFragment({
        title: "微信转发标题",
        content: "@bot 请整理这段聊天",
      }),
    ).toBe(false);
  });

  it("does not treat @bot+body as a fragment (not standalone auto-todo either)", () => {
    expect(
      isBotFragment({
        title: "note @bot",
        content: "long body",
      }),
    ).toBe(false);
  });

  it("long empty-content @bot title is still a fragment", () => {
    expect(
      isBotFragment({ title: `@bot ${"y".repeat(250)}`, content: "" }),
    ).toBe(true);
  });

  it("is case-sensitive on the literal marker", () => {
    expect(isBotFragment({ title: "@BOT hi", content: "" })).toBe(false);
  });

  it("never treats @not titles as fragments", () => {
    expect(isBotFragment({ title: "@not summarize", content: "" })).toBe(
      false,
    );
    expect(
      isBotFragment({ title: "pls @not tidy leftover @bot", content: "" }),
    ).toBe(false);
  });

  it("still treats freeze-tagged empty @bot as a fragment (claim skip)", () => {
    expect(
      isBotFragment({
        title: "@bot x",
        content: "",
        tags: [BOT_TAG_FREEZE],
      }),
    ).toBe(true);
  });
});

describe("shouldSkipAutoMerge", () => {
  it("skips @not titles and freeze-tagged fragments", () => {
    expect(shouldSkipAutoMerge({ title: "@not leftover" })).toBe(true);
    expect(
      shouldSkipAutoMerge({ title: "@bot x", tags: [BOT_TAG_FREEZE] }),
    ).toBe(true);
    expect(shouldSkipAutoMerge({ title: "@bot x", tags: [] })).toBe(false);
    expect(
      shouldSkipAutoMerge({
        title: "@bot x",
        tags: [WECHAT_CAPTURE_TAG],
      }),
    ).toBe(false);
  });
});

describe("rewriteBotTitleToNot", () => {
  it("replaces @bot with @not and keeps the rest", () => {
    expect(rewriteBotTitleToNot("@bot 总结这段")).toBe("@not 总结这段");
    expect(rewriteBotTitleToNot("请 @bot 处理")).toBe("请 @not 处理");
    expect(rewriteBotTitleToNot("@bot a @bot b")).toBe("@not a @not b");
  });
});

describe("appendFragmentContent", () => {
  it("appends with markdown --- separator", () => {
    const { content, appended } = appendFragmentContent(
      "context body",
      "@bot do the thing",
    );
    expect(appended).toBe(true);
    expect(content).toBe(
      `context body${APPEND_SEPARATOR}@bot do the thing`,
    );
    expect(content).toContain("\n\n---\n\n");
  });

  it("is idempotent when the payload is already present", () => {
    const first = appendFragmentContent("ctx", "@bot x").content;
    const second = appendFragmentContent(first, "@bot x");
    expect(second.appended).toBe(false);
    expect(second.content).toBe(first);
    expect(contentAlreadyHasPayload(first, "@bot x")).toBe(true);
  });

  it("treats empty existing content as prefix + separator + payload", () => {
    expect(appendFragmentContent("", "@bot x").content).toBe(
      `${APPEND_SEPARATOR}@bot x`,
    );
  });
});

describe("fragmentPayload", () => {
  it("prefers non-empty content over title", () => {
    expect(
      fragmentPayload(
        task({ id: "1", title: "@bot title", content: "@bot body" }),
      ),
    ).toBe("@bot body");
  });

  it("falls back to title when content is empty", () => {
    expect(
      fragmentPayload(task({ id: "1", title: "@bot title", content: "" })),
    ).toBe("@bot title");
  });
});

describe("chooseMergeMain", () => {
  it("keeps a classic context with substance as main", () => {
    const fragment = task({ id: "frag", title: "@bot 总结" });
    const dep = capture({
      id: "ctx",
      title: "微信转发",
      content: "长正文",
    });
    const choice = chooseMergeMain(fragment, dep);
    expect(choice.main.id).toBe("ctx");
    expect(choice.deleteFragment).toBe(true);
    expect(choice.payload).toBe("@bot 总结");
  });

  it("keeps the fragment as main for 来自微信的图片 and appends a task ref", () => {
    const fragment = task({ id: "frag", title: "@bot 看看图" });
    const dep = capture({
      id: "img",
      title: "来自微信的图片",
      content: "",
    });
    const choice = chooseMergeMain(fragment, dep);
    expect(choice.main.id).toBe("frag");
    expect(choice.deleteFragment).toBe(false);
    expect(choice.payload).toBe("来自微信的图片 (taskId: img)");
  });
});

describe("planFragmentActions candidate counts", () => {
  const t0 = "2026-09-04T10:11:12+0800";
  const tPlus5 = "2026-09-04T10:11:17+0800";
  const tPlus11 = "2026-09-04T10:11:23+0800";
  const tMinus4 = "2026-09-04T10:11:08+0800";
  const tMinus10 = "2026-09-04T10:11:02+0800";
  const tMinus11 = "2026-09-04T10:11:01+0800";

  it("count 0 → waiting_deps (retry next cron)", () => {
    const fragment = task({ id: "frag", title: "@bot x", createdTime: t0 });
    const outside = capture({
      id: "late",
      title: "chat",
      content: "body",
      createdTime: tPlus11,
    });
    const { merges, nots, skipped } = planFragmentActions([
      fragment,
      outside,
    ]);
    expect(merges).toEqual([]);
    expect(nots).toEqual([]);
    expect(skipped).toEqual([{ fragment, reason: "waiting_deps" }]);

    const tooEarly = capture({
      id: "early",
      title: "chat",
      content: "body",
      createdTime: tMinus11,
    });
    const skippedEarly = planFragmentActions([fragment, tooEarly]);
    expect(skippedEarly.skipped).toEqual([
      { fragment, reason: "waiting_deps" },
    ]);
  });

  it("count 1 → merge, including a neighbor 5s later, T-4s, and T-10s", () => {
    const fragment = task({ id: "frag", title: "@bot x", createdTime: t0 });
    const ctx = capture({
      id: "ctx",
      title: "chat",
      content: "body",
      createdTime: tPlus5,
    });
    const { merges, nots, skipped } = planFragmentActions([fragment, ctx]);
    expect(nots).toEqual([]);
    expect(skipped).toEqual([]);
    expect(merges).toHaveLength(1);
    expect(merges[0].fragment.id).toBe("frag");
    expect(merges[0].dep.id).toBe("ctx");

    const early = capture({
      id: "early",
      title: "chat2",
      content: "body",
      createdTime: tMinus4,
    });
    const onlyEarly = planFragmentActions([fragment, early]);
    expect(onlyEarly.merges[0]?.dep.id).toBe("early");

    const bound = capture({
      id: "bound",
      title: "chat3",
      content: "body",
      createdTime: tMinus10,
    });
    const atBound = planFragmentActions([fragment, bound]);
    expect(atBound.merges[0]?.dep.id).toBe("bound");
  });

  it("count 2+ → @not rewrite, do not merge", () => {
    const fragment = task({ id: "frag", title: "@bot x", createdTime: t0 });
    const a = capture({ id: "a", title: "one", content: "a", createdTime: t0 });
    const b = capture({
      id: "b",
      title: "two",
      content: "b",
      createdTime: tPlus5,
    });
    const { merges, nots, skipped } = planFragmentActions([
      fragment,
      a,
      b,
    ]);
    expect(merges).toEqual([]);
    expect(skipped).toEqual([]);
    expect(nots.map((n) => n.id)).toEqual(["frag"]);
  });

  it("skips auto-merge when the fragment already has freeze", () => {
    const fragment = task({
      id: "frag",
      title: "@bot x",
      createdTime: t0,
      tags: [BOT_TAG_FREEZE],
    });
    const ctx = capture({
      id: "ctx",
      title: "chat",
      content: "body",
      createdTime: t0,
    });
    const { merges, nots, skipped } = planFragmentActions([fragment, ctx]);
    expect(merges).toEqual([]);
    expect(nots).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("ignores other empty-content @bot fragments and @not titles as deps", () => {
    const fragment = task({ id: "frag", title: "@bot x", createdTime: t0 });
    const otherFrag = task({
      id: "frag2",
      title: "@bot y",
      createdTime: t0,
    });
    const notted = capture({
      id: "n",
      title: "@not leftover",
      content: "body",
      createdTime: t0,
    });
    const ctx = capture({
      id: "ctx",
      title: "chat",
      content: "body",
      createdTime: t0,
    });
    const candidates = findDependencyCandidates(fragment, [
      fragment,
      otherFrag,
      notted,
      ctx,
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["ctx"]);
  });

  it("requires the same project and 微信采集 tag", () => {
    const fragment = task({ id: "frag", title: "@bot x" });
    const otherProject = capture({
      id: "p2",
      projectId: "other",
      title: "chat",
      content: "body",
    });
    const untagged = task({
      id: "plain",
      title: "chat",
      content: "body",
    });
    expect(
      findDependencyCandidates(fragment, [fragment, otherProject, untagged]),
    ).toEqual([]);
  });
});

describe("shanghaiCalendarDate", () => {
  it("returns YYYY-MM-DD in Asia/Shanghai", () => {
    const utc = new Date("2026-09-04T16:30:00Z");
    expect(shanghaiCalendarDate(utc)).toBe("2026-09-05");
  });
});

describe("daysUntil", () => {
  it("returns fractional days remaining", () => {
    const now = Date.parse("2026-09-04T00:00:00Z");
    const later = Date.parse("2026-09-18T00:00:00Z");
    expect(daysUntil(later, now)).toBe(14);
  });
});

describe("NOT_MARKER", () => {
  it("is @not", () => {
    expect(NOT_MARKER).toBe("@not");
  });
});
