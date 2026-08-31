import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobManifest } from "./models.js";

describe("stored data renaming", () => {
  let root = "";
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-rename-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("renames jobs, output files, source labels, and conversations", async () => {
    const store = await import("./store.js");
    await store.initializeData();
    const id = "rename-job";
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

    expect((await store.renameJob(id, "  Course notes  ")).title).toBe("Course notes");
    const renamedOutput = await store.renameOutputFile(id, "document.md", "Final notes");
    expect(renamedOutput.file).toBe("Final notes.md");
    expect(renamedOutput.job.outputFiles).toEqual(["Final notes.md"]);
    expect(await fs.readFile(path.join(jobRoot, "output", "Final notes.md"), "utf8")).toBe("result");
    await expect(store.renameOutputFile(id, "Final notes.md", "notes.html")).rejects.toMatchObject({ code: "EINVAL" });

    const renamedInput = await store.renameInputFile(id, "001-source.pdf", "Reference material");
    expect(renamedInput.inputs[0].name).toBe("Reference material.pdf");
    expect(await fs.readFile(path.join(jobRoot, "input", "001-source.pdf"), "utf8")).toBe("source");

    const chat = await store.createChat();
    const renamedChat = await store.renameChat(chat.id, "  Research chat  ");
    expect(renamedChat.title).toBe("Research chat");
    expect((await store.readChat(chat.id)).title).toBe("Research chat");
  });
});
