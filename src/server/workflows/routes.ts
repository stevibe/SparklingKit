import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { ARTIFACT_KINDS, WORKFLOW_NODE_TYPES, type JobKind, type JobManifest, type WorkflowDefinition } from "../../shared/contracts.js";
import { createStarterWorkflow, validateWorkflowDefinition, workflowServiceContracts } from "../../shared/workflows.js";
import { DATA_DIR } from "../config.js";
import { enqueueFlowRun, stopFlowWork } from "../queue.js";
import { createJob, createTextToImageJob, readJob, readSettings, updateJob } from "../store.js";
import {
  createFlowRun,
  deleteWorkflowDefinition,
  listJobFlowRuns,
  listWorkflowDefinitions,
  readFlowRun,
  readWorkflowDefinition,
  updateFlowRun,
  writeWorkflowDefinition,
} from "./store.js";

const router = Router();
const upload = multer({ dest: path.join(DATA_DIR, "tmp"), limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 100 } });

const nodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(WORKFLOW_NODE_TYPES),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: z.record(z.string(), z.unknown()),
});
const edgeSchema = z.object({
  id: z.string().min(1).max(100),
  from: z.object({ nodeId: z.string().min(1), portId: z.string().min(1) }),
  to: z.object({ nodeId: z.string().min(1), portId: z.string().min(1) }),
  artifactKinds: z.array(z.enum(ARTIFACT_KINDS)).min(1),
});
const definitionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  revision: z.number().int().min(1).default(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  enabled: z.boolean().default(false),
  nodes: z.array(nodeSchema).max(50),
  edges: z.array(edgeSchema).max(100),
  ui: z.object({ viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.1).max(4) }) }).default({ viewport: { x: 0, y: 0, zoom: 1 } }),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

function parseJsonField(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return value ?? fallback;
  if (!value.trim()) return fallback;
  return JSON.parse(value);
}

function projectedKind(file: Express.Multer.File): JobKind {
  const extension = path.extname(file.originalname).toLowerCase();
  if (file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/") || [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(extension)) return "audio";
  if (file.mimetype === "application/pdf" || extension === ".pdf") return "pdf";
  if (file.mimetype.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(extension)) return "image";
  return "text";
}

function projectedArtifactKind(file: Express.Multer.File) {
  const kind = projectedKind(file);
  return kind === "audio" ? file.mimetype.startsWith("video/") ? "source-video" : "source-audio" : kind === "pdf" ? "source-pdf" : kind === "image" ? "source-image" : "text";
}

async function updateFlowJob(jobId: string, patch: Omit<Partial<JobManifest>, "runs">) {
  const current = await readJob(jobId);
  return updateJob(jobId, { ...patch, runs: current.runs });
}

async function validation(definition: WorkflowDefinition) {
  const settings = await readSettings();
  const result = validateWorkflowDefinition(definition, settings.endpoints.llm.capabilities || ["text"]);
  const serviceWarnings = definition.nodes.flatMap((node) => {
    if (node.type !== "module") return [];
    const serviceId = String(node.config.moduleId || "");
    const providerKind = serviceId === "llm-prompt" || serviceId === "chat" ? "llm" : serviceId === "text-to-image" ? "image-generation" : serviceId === "transcription" ? "stt" : serviceId;
    const endpoint = settings.endpoints[providerKind as keyof typeof settings.endpoints];
    return endpoint?.enabled && endpoint.baseUrl && endpoint.model ? [] : [{ level: "warning" as const, code: "service-unavailable", message: `${serviceId} is not configured on this machine`, nodeId: node.id }];
  });
  return { valid: result.valid, issues: [...result.issues, ...serviceWarnings] };
}

router.get("/workflow-nodes", async (_request, response) => {
  const settings = await readSettings();
  const services = workflowServiceContracts(settings.endpoints.llm.capabilities || ["text"]).map((contract) => {
    const providerKind = contract.id === "llm-prompt" || contract.id === "chat" ? "llm" : contract.id === "text-to-image" ? "image-generation" : contract.id === "transcription" ? "stt" : contract.id;
    const endpoint = settings.endpoints[providerKind as keyof typeof settings.endpoints];
    return { ...contract, configured: Boolean(endpoint?.enabled && endpoint.baseUrl && endpoint.model) };
  });
  response.json({ services, artifactKinds: ARTIFACT_KINDS });
});

router.get("/workflows", async (_request, response) => response.json(await listWorkflowDefinitions()));
router.post("/workflows", async (request, response) => {
  const candidate = definitionSchema.parse(request.body?.definition || request.body || createStarterWorkflow()) as WorkflowDefinition;
  const checked = await validation(candidate);
  if (candidate.enabled && !checked.valid) return response.status(400).json({ error: "Fix workflow validation errors before enabling it", validation: checked });
  response.status(201).json({ definition: await writeWorkflowDefinition(candidate, true), validation: checked });
});
router.get("/workflows/:workflowId", async (request, response) => response.json(await readWorkflowDefinition(request.params.workflowId)));
router.put("/workflows/:workflowId", async (request, response) => {
  const candidate = definitionSchema.parse({ ...request.body, id: request.params.workflowId }) as WorkflowDefinition;
  const checked = await validation(candidate);
  if (candidate.enabled && !checked.valid) return response.status(400).json({ error: "Fix workflow validation errors before enabling it", validation: checked });
  response.json({ definition: await writeWorkflowDefinition(candidate), validation: checked });
});
router.delete("/workflows/:workflowId", async (request, response) => {
  await deleteWorkflowDefinition(request.params.workflowId);
  response.status(204).end();
});
router.post("/workflows/:workflowId/validate", async (request, response) => {
  const candidate = request.body?.nodes ? definitionSchema.parse({ ...request.body, id: request.params.workflowId }) as WorkflowDefinition : await readWorkflowDefinition(request.params.workflowId);
  response.json(await validation(candidate));
});

router.post("/workflows/:workflowId/runs", upload.array("files", 100), async (request, response) => {
  const files = (request.files || []) as Express.Multer.File[];
  try {
    const definition = await readWorkflowDefinition(String(request.params.workflowId));
    const checked = await validation(definition);
    if (!checked.valid) return response.status(400).json({ error: "This workflow is not valid", validation: checked });
    const inputNode = definition.nodes.find((node) => node.type === "input")!;
    const accepts = new Set(Array.isArray(inputNode.config.accepts) ? inputNode.config.accepts : []);
    const maximumFiles = typeof inputNode.config.maximumFiles === "number" ? inputNode.config.maximumFiles : 100;
    const variables = z.record(z.string(), z.unknown()).parse(parseJsonField(request.body?.variables, {}));
    let job: JobManifest;
    let inputArtifactIds: string[];
    const existingJobId = typeof request.body?.jobId === "string" ? request.body.jobId : "";
    if (existingJobId) {
      job = await readJob(existingJobId);
      inputArtifactIds = z.array(z.string()).min(1).parse(parseJsonField(request.body?.inputArtifactIds, []));
      if (inputArtifactIds.some((id) => !job.artifacts.some((artifact) => artifact.id === id))) return response.status(400).json({ error: "One or more workflow inputs do not exist" });
      if (inputArtifactIds.length > maximumFiles || (inputNode.config.multiple === false && inputArtifactIds.length > 1)) return response.status(400).json({ error: "Too many inputs for this workflow" });
    } else if (files.length) {
      if (files.length > maximumFiles || (inputNode.config.multiple === false && files.length > 1) || files.some((file) => !accepts.has(projectedArtifactKind(file)))) {
        await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
        return response.status(400).json({ error: `Input accepts ${[...accepts].join(", ")}` });
      }
      job = await createJob(projectedKind(files[0]), files, { workflowId: definition.id });
      inputArtifactIds = job.artifacts.filter((artifact) => artifact.role === "source").map((artifact) => artifact.id);
      job = await updateJob(job.id, { runs: [], status: "queued", progress: 0, stage: "Waiting for workflow", workflowId: `flow:${definition.id}`, outputFiles: [] });
    } else {
      const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
      if (!text) return response.status(400).json({ error: "Add a file or text input" });
      job = await createTextToImageJob(text, { workflowId: definition.id });
      inputArtifactIds = job.artifacts.filter((artifact) => artifact.role === "source").map((artifact) => artifact.id);
      job = await updateJob(job.id, { runs: [], status: "queued", progress: 0, stage: "Waiting for workflow", workflowId: `flow:${definition.id}`, outputFiles: [], title: typeof request.body?.title === "string" ? request.body.title.slice(0, 160) : job.title });
    }
    const inputs = inputArtifactIds.map((id) => job.artifacts.find((artifact) => artifact.id === id)!);
    if (inputs.some((artifact) => !accepts.has(artifact.kind))) return response.status(400).json({ error: `Input accepts ${[...accepts].join(", ")}` });
    const flow = await createFlowRun(definition, job.id, inputArtifactIds, variables);
    if (existingJobId) job = await updateFlowJob(job.id, { status: "queued", progress: 0, stage: `Waiting for workflow · ${definition.name}`, workflowId: `flow:${definition.id}`, error: undefined, cancelRequested: false, completedAt: undefined });
    try {
      await enqueueFlowRun(job.id, flow.id);
    } catch (error) {
      await updateFlowRun(job.id, flow.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
      await updateFlowJob(job.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    response.status(202).json({ job: await readJob(job.id), flow });
  } catch (error) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    throw error;
  }
});

router.get("/workflow-runs", async (_request, response) => {
  const jobs = await (await import("../store.js")).listJobs();
  const flows = (await Promise.all(jobs.map((job) => listJobFlowRuns(job.id)))).flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  response.json(flows.slice(0, 100));
});
router.get("/jobs/:jobId/flows", async (request, response) => response.json(await listJobFlowRuns(request.params.jobId)));
router.get("/jobs/:jobId/flows/:flowRunId", async (request, response) => response.json(await readFlowRun(request.params.jobId, request.params.flowRunId)));
router.get("/jobs/:jobId/flows/:flowRunId/events", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  let last = "";
  const send = async () => {
    const flow = await readFlowRun(request.params.jobId, request.params.flowRunId);
    const serialized = JSON.stringify(flow);
    if (serialized !== last) { response.write(`data: ${serialized}\n\n`); last = serialized; }
    if (["succeeded", "failed", "cancelled"].includes(flow.status)) { clearInterval(timer); response.end(); }
  };
  const timer = setInterval(() => { void send().catch(() => undefined); }, 750);
  await send();
  request.on("close", () => clearInterval(timer));
});
router.post("/jobs/:jobId/flows/:flowRunId/cancel", async (request, response) => {
  const current = await readFlowRun(request.params.jobId, request.params.flowRunId);
  if (!["queued", "running", "blocked"].includes(current.status)) return response.json(current);
  await stopFlowWork(current.jobId, current.id);
  const flow = await updateFlowRun(current.jobId, current.id, (next) => {
    next.status = "cancelled";
    next.stage = "Stopped";
    next.completedAt = new Date().toISOString();
    for (const node of Object.values(next.nodes)) if (["pending", "ready", "running", "blocked"].includes(node.status)) node.status = "cancelled";
    return next;
  });
  await updateFlowJob(current.jobId, { status: "cancelled", stage: "Stopped", error: undefined, completedAt: new Date().toISOString() });
  response.json(flow);
});
router.post("/jobs/:jobId/flows/:flowRunId/retry", async (request, response) => {
  const current = await readFlowRun(request.params.jobId, request.params.flowRunId);
  if (!["failed", "blocked", "cancelled"].includes(current.status)) return response.status(409).json({ error: "Only stopped workflows can be retried" });
  const flow = await updateFlowRun(current.jobId, current.id, (next) => {
    next.status = "queued";
    next.stage = "Waiting for a worker";
    next.error = undefined;
    next.cancelRequested = false;
    next.completedAt = undefined;
    for (const node of Object.values(next.nodes)) if (node.status !== "succeeded" || node.nodeId === "input") {
      if (node.nodeId !== "input") {
        node.status = "pending";
        node.outputArtifactIds = [];
        node.selectedPortIds = [];
        node.error = undefined;
        node.completedAt = undefined;
      }
    }
    return next;
  });
  await updateFlowJob(current.jobId, { status: "queued", stage: "Waiting for workflow", progress: flow.progress, error: undefined, cancelRequested: false, completedAt: undefined });
  await enqueueFlowRun(current.jobId, current.id);
  response.status(202).json(flow);
});

export { router as workflowRouter };
