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
    const priorRunId = job.runs[0].id;
    job = await store.updateJob(job.id, { runs: [{ ...job.runs[0], status: "done", progress: 100, stage: "Complete", completedAt: new Date().toISOString() }], status: "done", progress: 100, outputFiles: [] });
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
    expect(completedJob.runs.find((run) => run.id === priorRunId)?.status).toBe("done");
    const translated = completedJob.artifacts.find((artifact) => artifact.kind === "translation")!;
    expect(completed.outputArtifactIds).toEqual([translated.id]);
    expect(translated.derivedFrom).toEqual([job.artifacts[0].id]);
    expect(await fs.readFile(path.join(store.jobDir(job.id), translated.path), "utf8")).toContain("Bonjour");
  });

  it("routes an If node using trimmed text artifact content", async () => {
    const store = await import("../store.js");
    await store.initializeData();
    let job = await store.createTextTranslationJob("true\n", "auto-detect", "English");
    job = await store.updateJob(job.id, { runs: [], status: "done", progress: 100, outputFiles: [] });
    const now = new Date().toISOString();
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      id: "text-condition-flow",
      revision: 1,
      name: "Text condition flow",
      description: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ui: { viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        { id: "input", type: "input", position: { x: 0, y: 0 }, config: { accepts: ["text"] } },
        { id: "condition", type: "if", position: { x: 100, y: 0 }, config: { predicate: { fact: "artifact.text", operator: "equal", value: "true" } } },
        { id: "true-end", type: "end", position: { x: 200, y: -50 }, config: {} },
        { id: "false-end", type: "end", position: { x: 200, y: 50 }, config: {} },
      ],
      edges: [
        { id: "input-condition", from: { nodeId: "input", portId: "files" }, to: { nodeId: "condition", portId: "input" }, artifactKinds: ["text"] },
        { id: "condition-true", from: { nodeId: "condition", portId: "true" }, to: { nodeId: "true-end", portId: "input" }, artifactKinds: ["text"] },
        { id: "condition-false", from: { nodeId: "condition", portId: "false" }, to: { nodeId: "false-end", portId: "input" }, artifactKinds: ["text"] },
      ],
    };
    const flows = await import("./store.js");
    const created = await flows.createFlowRun(definition, job.id, [job.artifacts[0].id]);
    const engine = await import("./engine.js");
    const completed = await engine.processFlowRun(job.id, created.id);

    expect(completed.nodes.condition.selectedPortIds).toEqual(["true"]);
    expect(completed.nodes["true-end"].status).toBe("succeeded");
    expect(completed.nodes["false-end"].status).toBe("skipped");
  });

  it("uses a temporary service result downstream and keeps only the saved file", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "Bonjour temporaire." } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("../store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({ ...settings, endpoints: { ...settings.endpoints, translation: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "translator", apiKey: "" } } });
    let job = await store.createTextTranslationJob("Hello temporary world.", "English", "French");
    job = await store.updateJob(job.id, { runs: [], status: "done", progress: 100, outputFiles: [] });
    const sourceId = job.artifacts[0].id;
    const now = new Date().toISOString();
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      id: "temporary-then-save",
      revision: 1,
      name: "Temporary then save",
      description: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ui: { viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        { id: "input", type: "input", position: { x: 0, y: 0 }, config: { accepts: ["text"] } },
        { id: "translate", type: "module", position: { x: 100, y: 0 }, config: { moduleId: "translation", workflowId: "auto", storeResult: false, params: { sourceLanguage: "English", targetLanguage: "French" } } },
        { id: "save", type: "save", position: { x: 200, y: 0 }, config: { mode: "input", fileName: "final.md" } },
      ],
      edges: [
        { id: "input-translate", from: { nodeId: "input", portId: "files" }, to: { nodeId: "translate", portId: "input" }, artifactKinds: ["text"] },
        { id: "translate-save", from: { nodeId: "translate", portId: "output" }, to: { nodeId: "save", portId: "input" }, artifactKinds: ["translation"] },
      ],
    };
    const flows = await import("./store.js");
    const created = await flows.createFlowRun(definition, job.id, [sourceId]);
    const engine = await import("./engine.js");
    const completed = await engine.processFlowRun(job.id, created.id);
    const completedJob = await store.readJob(job.id);
    const saved = completedJob.artifacts.find((artifact) => artifact.path === "output/final.md");

    expect(completed.status).toBe("succeeded");
    expect(completedJob.outputFiles).toEqual(["final.md"]);
    expect(saved).toBeDefined();
    expect(saved?.derivedFrom).toEqual([sourceId]);
    expect(completed.outputArtifactIds).toEqual([saved?.id]);
    expect(completedJob.artifacts.filter((artifact) => artifact.role !== "source")).toHaveLength(1);
    expect(completedJob.runs.flatMap((run) => run.outputArtifactIds)).not.toContain(completed.nodes.translate.outputArtifactIds[0]);
    expect(await fs.readFile(path.join(store.jobDir(job.id), "output/final.md"), "utf8")).toContain("Bonjour temporaire");
  });

  it("saves defined text without exposing the trigger as the result", async () => {
    const store = await import("../store.js");
    await store.initializeData();
    let job = await store.createTextTranslationJob("Trigger", "auto-detect", "English");
    job = await store.updateJob(job.id, { runs: [], status: "done", progress: 100, outputFiles: [] });
    const now = new Date().toISOString();
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      id: "defined-text-file",
      revision: 1,
      name: "Defined text file",
      description: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ui: { viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        { id: "input", type: "input", position: { x: 0, y: 0 }, config: { accepts: ["text"] } },
        { id: "save", type: "save", position: { x: 100, y: 0 }, config: { mode: "text", fileName: "note.md", text: "# Stored note" } },
      ],
      edges: [{ id: "input-save", from: { nodeId: "input", portId: "files" }, to: { nodeId: "save", portId: "input" }, artifactKinds: ["text"] }],
    };
    const flows = await import("./store.js");
    const created = await flows.createFlowRun(definition, job.id, [job.artifacts[0].id]);
    const engine = await import("./engine.js");
    const completed = await engine.processFlowRun(job.id, created.id);

    expect(completed.status).toBe("succeeded");
    expect(await fs.readFile(path.join(store.jobDir(job.id), "output/note.md"), "utf8")).toBe("# Stored note");
  });
});
