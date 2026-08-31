import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("workspace search", () => {
  let root = "";
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-search-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("finds jobs, exact artifacts, conversations, and tools from one index", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    const job = await store.createTextToImageJob("A searchable crimson lighthouse");
    const chat = await store.createChat();
    await store.renameChat(chat.id, "Lighthouse planning notes");
    const { searchWorkspace } = await import("./search.js");

    const work = await searchWorkspace("lighthouse", { scope: "work" });
    expect(work.results.some((result) => result.type === "job" && result.url === `/jobs/${job.id}`)).toBe(true);

    const artifact = (await searchWorkspace("Prompt.txt", { scope: "work" })).results.find((result) => result.type === "artifact");
    expect(artifact?.title).toBe("Prompt.txt");
    expect(artifact?.url).toMatch(new RegExp(`^/jobs/${job.id}\\?artifact=`));

    const conversations = await searchWorkspace("planning", { scope: "chats" });
    expect(conversations.results).toEqual([expect.objectContaining({ type: "conversation", title: "Lighthouse planning notes" })]);

    const tools = await searchWorkspace("translate", { scope: "tools" });
    expect(tools.results.some((result) => result.type === "module" && result.moduleId === "translation")).toBe(true);
  });

  it("supports recent and per-module work scopes", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    await store.createTextToImageJob("A moonlit harbor");
    await store.createTextTranslationJob("Good morning", "English", "French");
    const { searchWorkspace } = await import("./search.js");

    const recent = await searchWorkspace("", { scope: "all" });
    expect(recent.results.some((result) => result.group === "work")).toBe(true);
    expect(recent.results.some((result) => result.group === "tools")).toBe(true);

    const imageHistory = await searchWorkspace("", { scope: "work", moduleId: "text-to-image" });
    expect(imageHistory.results).toHaveLength(1);
    expect(imageHistory.results[0].moduleId).toBe("text-to-image");
  });
});
