import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("linked chat context", () => {
  let root = "";
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-chat-context-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("creates a linked conversation for an image-only generation job", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    const job = await store.createTextToImageJob("A red kite above a quiet beach", { size: "1024x1024" });

    const chat = await store.createChat(job.id);

    expect(chat.linkedJobId).toBe(job.id);
    expect(chat.title).toBe(`Chat · ${job.title}`);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe("system");
    expect(chat.messages[0].content).toContain("A red kite above a quiet beach");
    expect(chat.messages[0].content).toContain("configured language model accepts image input");
  });
});
