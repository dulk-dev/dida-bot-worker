import { describe, expect, it } from "vitest";
import {
  BOT_LIFECYCLE_TAG_SET,
  BOT_NESTED_TAGS,
  BOT_TAG_DOING,
  BOT_TAG_DONE,
  BOT_TAG_FREEZE,
  BOT_TAG_PARENT,
  BOT_TAG_TODO,
  WECHAT_CAPTURE_TAG,
  hasBotLifecycleTag,
  hasFreezeTag,
  isBotLifecycleTag,
  withBotLifecycleTag,
  withFreezeTag,
} from "../src/constants.ts";
import { isTodoClaimCandidate } from "../src/merge-logic.ts";

describe("bot lifecycle tag helpers", () => {
  it("treats only todo/doing/done as lifecycle leaves", () => {
    expect(isBotLifecycleTag(BOT_TAG_TODO)).toBe(true);
    expect(isBotLifecycleTag(BOT_TAG_DOING)).toBe(true);
    expect(isBotLifecycleTag(BOT_TAG_DONE)).toBe(true);
    expect(isBotLifecycleTag(BOT_TAG_PARENT)).toBe(false);
    expect(isBotLifecycleTag(BOT_TAG_FREEZE)).toBe(false);
    expect(isBotLifecycleTag("urgent")).toBe(false);
    expect(BOT_LIFECYCLE_TAG_SET.has("todo")).toBe(true);
    expect(BOT_LIFECYCLE_TAG_SET.has("bot")).toBe(false);
    expect(BOT_LIFECYCLE_TAG_SET.has(BOT_TAG_FREEZE)).toBe(false);
    expect(BOT_NESTED_TAGS).toEqual(["todo", "doing", "done", "freeze"]);
  });

  it("hasBotLifecycleTag is false for missing/empty/unrelated tags", () => {
    expect(hasBotLifecycleTag(undefined)).toBe(false);
    expect(hasBotLifecycleTag(null)).toBe(false);
    expect(hasBotLifecycleTag([])).toBe(false);
    expect(hasBotLifecycleTag(["urgent", BOT_TAG_PARENT])).toBe(false);
    expect(hasBotLifecycleTag(["urgent", BOT_TAG_DOING])).toBe(true);
  });

  it("rewrites to a single lifecycle leaf and keeps unrelated tags", () => {
    expect(
      withBotLifecycleTag(["urgent", BOT_TAG_TODO, BOT_TAG_PARENT], BOT_TAG_DOING),
    ).toEqual(["urgent", BOT_TAG_PARENT, BOT_TAG_DOING]);
    expect(
      withBotLifecycleTag(
        [BOT_TAG_TODO, BOT_TAG_DOING, BOT_TAG_DONE, "keep"],
        BOT_TAG_TODO,
      ),
    ).toEqual(["keep", BOT_TAG_TODO]);
    expect(withBotLifecycleTag(undefined, BOT_TAG_TODO)).toEqual([BOT_TAG_TODO]);
  });

  it("preserves freeze when rewriting lifecycle leaves", () => {
    expect(
      withBotLifecycleTag(
        [WECHAT_CAPTURE_TAG, BOT_TAG_FREEZE, BOT_TAG_TODO],
        BOT_TAG_DOING,
      ),
    ).toEqual([WECHAT_CAPTURE_TAG, BOT_TAG_FREEZE, BOT_TAG_DOING]);
  });
});

describe("freeze classification tag", () => {
  it("detects freeze and appends it without dropping other tags", () => {
    expect(hasFreezeTag(undefined)).toBe(false);
    expect(hasFreezeTag([])).toBe(false);
    expect(hasFreezeTag([WECHAT_CAPTURE_TAG])).toBe(false);
    expect(hasFreezeTag([WECHAT_CAPTURE_TAG, BOT_TAG_FREEZE])).toBe(true);
    expect(withFreezeTag(undefined)).toEqual([BOT_TAG_FREEZE]);
    expect(withFreezeTag([WECHAT_CAPTURE_TAG, "urgent"])).toEqual([
      WECHAT_CAPTURE_TAG,
      "urgent",
      BOT_TAG_FREEZE,
    ]);
    expect(withFreezeTag([BOT_TAG_FREEZE, WECHAT_CAPTURE_TAG])).toEqual([
      BOT_TAG_FREEZE,
      WECHAT_CAPTURE_TAG,
    ]);
  });
});

describe("isTodoClaimCandidate", () => {
  it("claims filter hits with unknown tags or explicit todo", () => {
    expect(isTodoClaimCandidate(undefined)).toBe(true);
    expect(isTodoClaimCandidate([BOT_TAG_TODO])).toBe(true);
    expect(isTodoClaimCandidate(["urgent", BOT_TAG_TODO])).toBe(true);
  });

  it("does not claim doing/done-only or unrelated tags", () => {
    expect(isTodoClaimCandidate([BOT_TAG_DOING])).toBe(false);
    expect(isTodoClaimCandidate([BOT_TAG_DONE])).toBe(false);
    expect(isTodoClaimCandidate(["urgent"])).toBe(false);
    expect(isTodoClaimCandidate([])).toBe(false);
  });
});
