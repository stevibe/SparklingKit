import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "../../shared/contracts.js";

describe("file-based workflow engine", () => {
  let root = "";
  let server: Server | undefined;
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-flow-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve());
    server = undefined;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("executes service nodes and preserves artifact lineage", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "Bonjour le monde." } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("../store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({ ...settings, endpoints: { ...settings.endpoints, translation: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "translator", apiKey: "" } } });
    let job = await store.createTextTranslationJob("Hello world.", "English", "French");
    job = await store.updateJob(job.id, { runs: [], status: "queued", progress: 0, outputFiles: [] });
    const now = new Date().toISOString();
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      id: "translate-flow",
      revision: 1,
      name: "Translate flow",
      description: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ui: { viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        { id: "input", type: "input", position: { x: 0, y: 0 }, config: { accepts: ["text"] } },
        { id: "translate", type: "module", position: { x: 100, y: 0 }, config: { moduleId: "translation", workflowId: "auto", params: { sourceLanguage: "English", targetLanguage: "French" } } },
        { id: "end", type: "end", position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [
        { id: "one", from: { nodeId: "input", portId: "files" }, to: { nodeId: "translate", portId: "input" }, artifactKinds: ["text"] },
        { id: "two", from: { nodeId: "translate", portId: "output" }, to: { nodeId: "end", portId: "input" }, artifactKinds: ["translation"] },
      ],
    };
    const flows = await import("./store.js");
    const created = await flows.createFlowRun(definition, job.id, job.artifacts.map((artifact) => artifact.id));
    const engine = await import("./engine.js");
    const completed = await engine.processFlowRun(job.id, created.id);
    const completedJob = await store.readJob(job.id);

    expect(completed.status).toBe("succeeded");
    expect(completed.outputArtifactIds).toHaveLength(1);
    expect(completedJob.status).toBe("done");
    const translated = completedJob.artifacts.find((artifact) => artifact.kind === "translation")!;
    expect(completed.outputArtifactIds).toEqual([translated.id]);
    expect(translated.derivedFrom).toEqual([job.artifacts[0].id]);
    expect(await fs.readFile(path.join(store.jobDir(job.id), translated.path), "utf8")).toContain("Bonjour");
  });
});
