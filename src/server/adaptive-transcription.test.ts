import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobManifest } from "./models.js";

describe("adaptive transcription recovery", () => {
  let root = "";
  let server: Server | undefined;
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-adaptive-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve());
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("divides only a pathological window and completes the transcript", async () => {
    let requests = 0;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.setHeader("Content-Type", "application/json");
        const text = requests === 1 ? "repeated-block!".repeat(24) : requests === 2 ? "First recovered section." : "Second recovered section.";
        response.end(JSON.stringify({ text }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    const media = await import("./media.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({
      ...settings,
      endpoints: { ...settings.endpoints, stt: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-asr", apiKey: "" } },
      audio: { ...settings.audio, chunkTargetSec: 15, chunkOverlapSec: 1, maxCompletionTokens: 512, requestTimeoutSec: 5, adaptiveSplit: true, minAdaptiveChunkSec: 5 },
      queue: { ...settings.queue, maxRetriesPerChunk: 0 },
    });

    const id = "adaptive-job";
    const jobRoot = store.jobDir(id);
    await Promise.all(["input", "work", "output"].map((folder) => fs.mkdir(path.join(jobRoot, folder), { recursive: true })));
    const input = path.join(jobRoot, "input", "001-source.wav");
    await media.runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "20", "-c:a", "pcm_s16le", input], 5000);
    const now = new Date().toISOString();
    const job: JobManifest = {
      id,
      type: "audio",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      title: "Source.wav",
      progress: 0,
      stage: "Waiting for a worker",
      inputs: [{ name: "Source.wav", storedName: "001-source.wav", mimeType: "audio/wav", size: (await fs.stat(input)).size }],
      outputFiles: [],
      warnings: [],
      params: {},
    };
    await store.atomicWriteJson(path.join(jobRoot, "job.json"), job);

    const processor = await import("./processor.js");
    await processor.processJob(id);

    const completed = await store.readJob(id);
    expect(completed.status).toBe("done");
    expect(requests).toBe(3);
    expect(await fs.readFile(path.join(jobRoot, "output", "transcript.md"), "utf8")).toContain("First recovered section");
    expect((await fs.readdir(path.join(jobRoot, "work", "adaptive-0001"))).length).toBeGreaterThanOrEqual(2);
  });
});
