import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobManifest } from "./models.js";

describe("stored data deletion", () => {
  let root = "";
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-delete-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("deletes output files, source files, and their job", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    const id = "test-job";
    const jobRoot = store.jobDir(id);
    await Promise.all(["input", "work", "output"].map((folder) => fs.mkdir(path.join(jobRoot, folder), { recursive: true })));
    await fs.writeFile(path.join(jobRoot, "input", "001-source.pdf"), "source");
    await fs.writeFile(path.join(jobRoot, "output", "document.md"), "result");
    const now = new Date().toISOString();
    const job: JobManifest = {
      id,
      type: "pdf",
      status: "done",
      createdAt: now,
      updatedAt: now,
      title: "Source.pdf",
      progress: 100,
      stage: "Complete",
      inputs: [{ name: "Source.pdf", storedName: "001-source.pdf", mimeType: "application/pdf", size: 6 }],
      outputFiles: ["document.md"],
      warnings: [],
      params: {},
    };
    await store.atomicWriteJson(path.join(jobRoot, "job.json"), job);

    const withoutOutput = await store.deleteOutputFile(id, "document.md");
    expect(withoutOutput.outputFiles).toEqual([]);
    await expect(fs.access(path.join(jobRoot, "output", "document.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const withoutInput = await store.deleteInputFile(id, "001-source.pdf");
    expect(withoutInput.inputs).toEqual([]);
    await expect(fs.access(path.join(jobRoot, "input", "001-source.pdf"))).rejects.toMatchObject({ code: "ENOENT" });

    await store.deleteJob(id);
    await expect(fs.access(jobRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a conversation directory", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    const chat = await store.createChat();
    await store.deleteChat(chat.id);
    await expect(store.readChat(chat.id)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
