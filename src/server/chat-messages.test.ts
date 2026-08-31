import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("chat model messages", () => {
  let root = "";
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-chat-messages-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("attaches linked raster artifacts only when image input is enabled", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    settings.endpoints.llm.capabilities = ["text", "image"];
    await store.writeSettings(settings);

    const created = await store.createTextToImageJob("A white ceramic cup", { size: "1024x1024" });
    await fs.mkdir(path.dirname(store.safeOutputPath(created.id, "generated-image.png")), { recursive: true });
    await fs.writeFile(store.safeOutputPath(created.id, "generated-image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const job = await store.updateJob(created.id, { outputFiles: ["generated-image.png"], status: "done", progress: 100 });
    expect(job.artifacts.some((artifact) => artifact.kind === "generated-image")).toBe(true);

    const chat = await store.createChat(job.id);
    chat.messages.push({ id: "user-1", role: "user", content: "What is in this image?", createdAt: new Date().toISOString() });
    const { modelMessagesForChat } = await import("./chat-messages.js");
    const messages = await modelMessagesForChat(chat, settings);
    const userContent = messages.at(-1)?.content;

    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent).toEqual([
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ]);

    settings.endpoints.llm.capabilities = ["text"];
    expect((await modelMessagesForChat(chat, settings)).at(-1)?.content).toBe("What is in this image?");
  });
});
