import { describe, expect, it } from "vitest";
import {
  normalizeInboxTasks,
  normalizeSearchTasks,
  normalizeTags,
} from "../src/dida.ts";
import { buildAuthorizeUrl, oauthCallbackUrl } from "../src/oauth.ts";
import { parseWebhookAuthStyle, webhookHeaders } from "../src/webhook.ts";

describe("normalizeSearchTasks", () => {
  it("accepts a bare array", () => {
    const tasks = normalizeSearchTasks([
      { id: "1", projectId: "p", title: "@bot", content: "" },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("1");
  });

  it("accepts { tasks: [...] } wrappers", () => {
    const tasks = normalizeSearchTasks({
      tasks: [{ id: "2", projectId: "p", title: "x" }],
    });
    expect(tasks.map((t) => t.id)).toEqual(["2"]);
  });

  it("parses leaf tag names and leaves tags undefined when omitted", () => {
    const tagged = normalizeSearchTasks([
      { id: "1", projectId: "p", title: "x", tags: ["todo", "urgent"] },
    ]);
    expect(tagged[0].tags).toEqual(["todo", "urgent"]);
    const omitted = normalizeSearchTasks([{ id: "2", projectId: "p" }]);
    expect(omitted[0].tags).toBeUndefined();
  });
});

describe("normalizeInboxTasks", () => {
  it("unions tasks and undoneTasks without duplicating ids", () => {
    const tasks = normalizeInboxTasks({
      tasks: [{ id: "1", projectId: "inbox", title: "a" }],
      undoneTasks: [
        { id: "1", projectId: "inbox", title: "a" },
        { id: "2", projectId: "inbox", title: "b" },
      ],
    });
    expect(tasks.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });
});

describe("normalizeTags", () => {
  it("parses name and parent, treating empty parent as null", () => {
    const tags = normalizeTags([
      { name: "bot", label: "bot", parent: null },
      { name: "todo", parent: "bot" },
      { name: "top3", parent: "" },
    ]);
    expect(tags).toEqual([
      { name: "bot", label: "bot", parent: null, color: null },
      { name: "todo", label: undefined, parent: "bot", color: null },
      { name: "top3", label: undefined, parent: null, color: null },
    ]);
  });
});

describe("oauth helpers", () => {
  it("builds the Dida authorize URL with space-separated scopes", () => {
    const url = buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://worker.example/auth/callback",
      scope: "tasks:read tasks:write",
      state: "abc",
    });
    expect(url).toContain("https://dida365.com/oauth/authorize?");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=tasks%3Aread+tasks%3Awrite");
    expect(oauthCallbackUrl("https://worker.example/")).toBe(
      "https://worker.example/auth/callback",
    );
  });
});

describe("webhook auth style", () => {
  it("sends both Authorization Bearer and X-Webhook-Secret by default", () => {
    const headers = webhookHeaders("s3cret", parseWebhookAuthStyle("both"));
    expect(headers).toMatchObject({
      Authorization: "Bearer s3cret",
      "X-Webhook-Secret": "s3cret",
      "Content-Type": "application/json",
    });
  });
});
