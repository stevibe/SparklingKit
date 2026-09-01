import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import { ENDPOINT_KINDS, MODEL_INPUT_CAPABILITIES, MODULE_IDS, SEARCH_SCOPES } from "../shared/contracts.js";
import { getModuleContract, moduleAcceptsArtifact, moduleWorkflowForArtifact } from "../shared/module-router.js";
import { checkEndpoint, openChatStream } from "./ai.js";
import { modelMessagesForChat } from "./chat-messages.js";
import { CLIENT_DIR, DATA_DIR, PORT } from "./config.js";
import { jobEvents, publishJob } from "./events.js";
import type { ChatMessage, EndpointKind, JobKind, PromptPreset, Settings } from "./models.js";
import { listModules } from "./modules/registry.js";
import { translateContent } from "./modules/translation/service.js";
import { searchWorkspace } from "./search.js";
import { workflowRouter } from "./workflows/routes.js";
import { closeQueue, enqueueJob, enqueuePreset, enqueueWorkflowRun, pingRedis, startWorker, stopJobWork, stopRunWork } from "./queue.js";
import {
  createChat,
  createFileTranslationJob,
  createGroundingJob,
  createJob,
  createTextTranslationJob,
  createTextToImageJob,
  deleteChat,
  deleteInputFile,
  deleteJob,
  deleteOutputFile,
  initializeData,
  listChats,
  listJobs,
  listPrompts,
  readChat,
  readJob,
  readSettings,
  renameChat,
  renameInputFile,
  renameJob,
  renameOutputFile,
  safeInputPath,
  safeOutputPath,
  updateJob,
  updateWorkflowRun,
  writeChat,
  writePrompt,
  writeSettings,
} from "./store.js";

await initializeData();

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", workflowRouter);

const upload = multer({
  dest: path.join(DATA_DIR, "tmp"),
  limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 100 },
});

const endpointSchema = z.object({
  baseUrl: z.union([z.string().url(), z.literal("")]),
  model: z.string(),
  apiKey: z.string(),
  enabled: z.boolean(),
  capabilities: z.array(z.enum(MODEL_INPUT_CAPABILITIES)).optional(),
}).refine((endpoint) => !endpoint.enabled || Boolean(endpoint.baseUrl && endpoint.model), "Enabled services require a base URL and model");
const settingsSchema = z.object({
  schemaVersion: z.literal(2),
  systemStatus: z.object({ baseUrl: z.union([z.string().url(), z.literal("")]) }),
  endpoints: z.object({ stt: endpointSchema, ocr: endpointSchema, llm: endpointSchema, translation: endpointSchema, grounding: endpointSchema, "image-generation": endpointSchema }),
  audio: z.object({
    chunkTargetSec: z.number().int().min(15).max(3600),
    chunkOverlapSec: z.number().min(0).max(30),
    sampleRate: z.number().int().min(8000).max(48000),
    maxCompletionTokens: z.number().int().min(128).max(32768),
    requestTimeoutSec: z.number().int().min(15).max(3600),
    adaptiveSplit: z.boolean(),
    minAdaptiveChunkSec: z.number().int().min(5).max(300),
  }),
  pdf: z.object({
    dpi: z.number().int().min(72).max(400),
    pagesPerBatch: z.number().int().min(1).max(100),
  }),
  queue: z.object({ workers: z.number().int().min(1).max(16), maxRetriesPerChunk: z.number().int().min(0).max(10) }),
  retention: z.object({ purgeWorkDirAfterDays: z.number().int().min(0).max(3650) }),
  ui: z.object({
    language: z.string().min(2),
    theme: z.enum(["light", "dark", "auto"]),
    timezone: z.string().min(1).refine((timezone) => {
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); return true; } catch { return false; }
    }, "Choose a valid IANA time zone"),
  }),
});
const promptSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().max(500),
  system: z.string().min(1),
  userTemplate: z.string().refine((value) => value.includes("{{text}}"), "Template must contain {{text}}"),
  params: z.object({ temperature: z.number().min(0).max(2), maxTokens: z.number().int().min(1).max(131072) }),
  chunking: z.object({ maxInputTokens: z.number().int().min(1000), strategy: z.enum(["single", "map-reduce"]) }),
});
const renameSchema = z.object({ name: z.string().trim().min(1).max(180) });
const titleSchema = z.object({ title: z.string().trim().min(1).max(160) });
const workflowRunSchema = z.object({
  moduleId: z.enum(MODULE_IDS),
  workflowId: z.string().min(1).max(120),
  inputArtifactIds: z.array(z.string().min(1)).min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});
const textToImageSchema = z.object({
  prompt: z.string().trim().min(1).max(12_000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
});
const groundingQueriesSchema = z.array(z.string().trim().min(1).max(500)).min(1).max(12);
const textTranslationSchema = z.object({
  text: z.string().trim().min(1).max(500_000),
  sourceLanguage: z.string().trim().min(1).max(80).default("auto-detect"),
  targetLanguage: z.string().trim().min(1).max(80),
});
const translationPreviewSchema = textTranslationSchema.extend({ text: z.string().trim().min(1).max(50_000) });
const fileTranslationSchema = textTranslationSchema.omit({ text: true });
const translationFileExtensions = new Set([".txt", ".md", ".markdown", ".html", ".htm"]);
const searchQuerySchema = z.object({
  q: z.string().max(200).default(""),
  scope: z.enum(SEARCH_SCOPES).default("all"),
  moduleId: z.enum(MODULE_IDS).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

app.get("/api/health", async (_request, response) => {
  const settings = await readSettings();
  const [checks, redis] = await Promise.all([
    Promise.all(ENDPOINT_KINDS.map(async (kind) => [kind, await checkEndpoint(kind, settings.endpoints[kind])] as const)),
    pingRedis(),
  ]);
  const endpoints = Object.fromEntries(checks) as Record<EndpointKind, Awaited<ReturnType<typeof checkEndpoint>>>;
  const enabled = Object.values(endpoints).filter((endpoint) => endpoint.enabled);
  response.json({ ok: redis.ok && enabled.every((endpoint) => endpoint.ok), endpoints, redis });
});

app.get("/api/system/status", async (_request, response) => {
  try {
    const { baseUrl } = (await readSettings()).systemStatus;
    if (!baseUrl) return response.status(204).end();
    const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
    const statusUrl = normalizedBaseUrl.endsWith("/v1/status") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1/status`;
    const upstream = await fetch(statusUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) throw new Error(`Status reporter returned ${upstream.status}`);
    response.json(await upstream.json());
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/health/:kind", async (request, response) => {
  const kind = request.params.kind as EndpointKind;
  if (!(ENDPOINT_KINDS as readonly string[]).includes(kind)) return response.status(400).json({ error: "Unknown endpoint" });
  const current = await readSettings();
  const candidate = endpointSchema.parse(request.body?.endpoint || current.endpoints[kind]);
  response.json(await checkEndpoint(kind, candidate));
});

app.get("/api/settings", async (_request, response) => response.json(await readSettings()));
app.put("/api/settings", async (request, response) => {
  const settings = settingsSchema.parse(request.body) as Settings;
  await writeSettings(settings);
  response.json(settings);
});

app.get("/api/modules", async (_request, response) => response.json(listModules(await readSettings())));
app.get("/api/search", async (request, response) => {
  const input = searchQuerySchema.parse(request.query);
  response.json(await searchWorkspace(input.q, input));
});
app.post("/api/modules/translation/preview", async (request, response) => {
  const input = translationPreviewSchema.parse(request.body);
  const settings = await readSettings();
  const module = listModules(settings).find((candidate) => candidate.id === "translation");
  if (!module?.configured) return response.status(409).json({ error: "Configure and enable the Translation service first" });
  response.json({ text: await translateContent(settings.endpoints.translation, input.text, input.sourceLanguage, input.targetLanguage) });
});
app.post("/api/modules/translation/text", async (request, response) => {
  const input = textTranslationSchema.parse(request.body);
  const settings = await readSettings();
  const module = listModules(settings).find((candidate) => candidate.id === "translation");
  if (!module?.configured) return response.status(409).json({ error: "Configure and enable the Translation service first" });
  const job = await createTextTranslationJob(input.text, input.sourceLanguage, input.targetLanguage);
  try {
    await enqueueJob(job.id);
  } catch (error) {
    await updateJob(job.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  response.status(201).json(job);
});
app.post("/api/modules/translation/files", upload.array("files", 1), async (request, response) => {
  const files = (request.files || []) as Express.Multer.File[];
  try {
    const input = fileTranslationSchema.parse(request.body);
    const file = files[0];
    const extension = file ? path.extname(file.originalname).toLowerCase() : "";
    if (files.length !== 1 || !translationFileExtensions.has(extension)) {
      await Promise.all(files.map((candidate) => fs.unlink(candidate.path).catch(() => undefined)));
      return response.status(400).json({ error: "Upload one UTF-8 text, Markdown, or HTML file" });
    }
    const settings = await readSettings();
    const module = listModules(settings).find((candidate) => candidate.id === "translation");
    if (!module?.configured) {
      await fs.unlink(file.path).catch(() => undefined);
      return response.status(409).json({ error: "Configure and enable the Translation service first" });
    }
    const job = await createFileTranslationJob(file, input.sourceLanguage, input.targetLanguage);
    try {
      await enqueueJob(job.id);
    } catch (error) {
      await updateJob(job.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    response.status(201).json(job);
  } catch (error) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    throw error;
  }
});
app.post("/api/modules/grounding/jobs", upload.array("files", 1), async (request, response) => {
  const files = (request.files || []) as Express.Multer.File[];
  try {
    const rawQueries = typeof request.body.queries === "string" ? JSON.parse(request.body.queries) : request.body.queries;
    const queries = groundingQueriesSchema.parse(rawQueries);
    if (files.length !== 1 || !/^image\/(?:png|jpeg|webp)$/.test(files[0].mimetype)) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
      return response.status(400).json({ error: "Upload one PNG, JPEG, or WebP image" });
    }
    const settings = await readSettings();
    const module = listModules(settings).find((candidate) => candidate.id === "grounding");
    if (!module?.configured) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
      return response.status(409).json({ error: "Configure and enable the Grounding service first" });
    }
    const job = await createGroundingJob(files, queries);
    try {
      await enqueueJob(job.id);
    } catch (error) {
      await updateJob(job.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    response.status(201).json(job);
  } catch (error) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    throw error;
  }
});
app.post("/api/modules/text-to-image/jobs", async (request, response) => {
  const input = textToImageSchema.parse(request.body);
  const settings = await readSettings();
  const module = listModules(settings).find((candidate) => candidate.id === "text-to-image");
  if (!module?.configured) return response.status(409).json({ error: "Configure and enable the Image generation service first" });
  const job = await createTextToImageJob(input.prompt, { prompt: input.prompt, size: input.size });
  try {
    await enqueueJob(job.id);
  } catch (error) {
    await updateJob(job.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  response.status(201).json(job);
});

app.get("/api/prompts", async (_request, response) => response.json(await listPrompts()));
app.put("/api/prompts/:slug", async (request, response) => {
  const prompt = promptSchema.parse({ ...request.body, slug: request.params.slug }) as PromptPreset;
  await writePrompt(prompt);
  response.json(prompt);
});

app.get("/api/jobs", async (request, response) => {
  let jobs = await listJobs();
  if (request.query.status) jobs = jobs.filter((job) => job.status === request.query.status);
  if (request.query.type) jobs = jobs.filter((job) => job.type === request.query.type);
  const offset = Math.max(0, Number(request.query.offset || 0));
  const limit = Math.min(100, Math.max(1, Number(request.query.limit || 50)));
  response.json({ jobs: jobs.slice(offset, offset + limit), total: jobs.length });
});

app.post("/api/jobs", upload.array("files"), async (request, response) => {
  const files = (request.files || []) as Express.Multer.File[];
  try {
    const inferred = inferJobKind(files);
    const type = (request.body.type || inferred) as JobKind;
    const requestedModule = request.body.moduleId as string | undefined;
    if (requestedModule && !(MODULE_IDS as readonly string[]).includes(requestedModule)) throw new Error("Unsupported module");
    if (requestedModule === "transcription" && type !== "audio") throw new Error("Transcription accepts audio and video files");
    if (requestedModule === "ocr" && type === "audio") throw new Error("OCR accepts image and PDF files");
    if (!["audio", "image", "pdf"].includes(type)) throw new Error("Unsupported job type");
    if (!inferred) throw new Error("Upload audio, video, image, or PDF files");
    const job = await createJob(type, files, request.body.params ? JSON.parse(request.body.params) : {});
    try {
      await enqueueJob(job.id);
    } catch (error) {
      await updateJob(job.id, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    response.status(201).json(job);
  } catch (error) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    throw error;
  }
});

app.get("/api/jobs/:id", async (request, response) => response.json(await readJob(request.params.id)));
app.get("/api/jobs/:id/artifacts", async (request, response) => response.json((await readJob(request.params.id)).artifacts));
app.get("/api/jobs/:id/runs", async (request, response) => response.json((await readJob(request.params.id)).runs));
app.post("/api/jobs/:id/runs", async (request, response) => {
  const input = workflowRunSchema.parse(request.body);
  const job = await readJob(request.params.id);
  const module = listModules(await readSettings()).find((candidate) => candidate.id === input.moduleId);
  const contract = getModuleContract(input.moduleId);
  if (!module || module.implementation !== "ready") return response.status(409).json({ error: "This module is not ready to run" });
  if (!module.configured) return response.status(409).json({ error: `Configure and enable the ${module.title} service first` });
  if (!contract || contract.handoff.mode !== "workflow") return response.status(400).json({ error: "Unsupported workflow" });
  if (input.inputArtifactIds.length > contract.handoff.maxInputs) return response.status(400).json({ error: `${module.title} accepts at most ${contract.handoff.maxInputs} input${contract.handoff.maxInputs === 1 ? "" : "s"}` });
  const artifacts = input.inputArtifactIds.map((id) => job.artifacts.find((artifact) => artifact.id === id));
  if (artifacts.some((artifact) => !artifact)) return response.status(400).json({ error: "One or more input artifacts do not exist" });
  if (artifacts.some((artifact) => artifact && !moduleAcceptsArtifact(input.moduleId, artifact.kind))) return response.status(400).json({ error: "The selected artifact is not compatible with this module" });
  if (artifacts.some((artifact) => artifact && moduleWorkflowForArtifact(input.moduleId, artifact.kind) !== input.workflowId)) return response.status(400).json({ error: "The selected artifact is not compatible with this workflow" });
  const queued = await enqueueWorkflowRun(job.id, input.moduleId, input.workflowId, input.params, input.inputArtifactIds);
  response.status(202).json(queued);
});
app.post("/api/jobs/:id/runs/:runId/cancel", async (request, response) => {
  const job = await readJob(request.params.id);
  const run = job.runs.find((candidate) => candidate.id === request.params.runId);
  if (!run) return response.status(404).json({ error: "Workflow run not found" });
  if (!["queued", "preparing", "processing", "merging"].includes(run.status)) return response.json({ job, run });
  await updateWorkflowRun(job.id, run.id, { cancelRequested: true, stage: "Stopping…" });
  await stopRunWork(job.id, run.id);
  const stopped = await updateWorkflowRun(job.id, run.id, {
    status: "cancelled",
    stage: "Stopped",
    error: undefined,
    completedAt: new Date().toISOString(),
  });
  publishJob(job.id, stopped.job);
  response.json(stopped);
});
app.patch("/api/jobs/:id", async (request, response) => {
  const { title } = titleSchema.parse(request.body);
  response.json(await renameJob(request.params.id, title));
});
app.delete("/api/jobs/:id", async (request, response) => {
  const job = await readJob(request.params.id);
  if (["queued", "preparing", "processing", "merging"].includes(job.status)) {
    const stopping = await updateJob(job.id, { cancelRequested: true, stage: "Stopping…" });
    publishJob(job.id, stopping);
  }
  await stopJobWork(job.id);
  await deleteJob(job.id);
  response.status(204).end();
});
app.get("/api/jobs/:id/events", async (request, response) => {
  const initial = await readJob(request.params.id);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  send(initial);
  const listener = (payload: unknown) => send(payload);
  jobEvents.on(request.params.id, listener);
  const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    jobEvents.off(request.params.id, listener);
  });
});

app.post("/api/jobs/:id/cancel", async (request, response) => {
  const current = await readJob(request.params.id);
  if (!["queued", "preparing", "processing", "merging"].includes(current.status)) return response.json(current);
  const stopping = await updateJob(current.id, { cancelRequested: true, stage: "Stopping…" });
  publishJob(current.id, stopping);
  await stopJobWork(current.id);
  const latest = await readJob(current.id);
  if (!["queued", "preparing", "processing", "merging"].includes(latest.status)) return response.json(latest);
  const stopped = await updateJob(current.id, {
    status: "cancelled",
    stage: "Stopped",
    detail: undefined,
    error: undefined,
    completedAt: new Date().toISOString(),
  });
  publishJob(current.id, stopped);
  response.json(stopped);
});

app.post("/api/jobs/:id/presets/:slug", async (request, response) => {
  const job = await readJob(request.params.id);
  if (!["done", "done_with_warnings"].includes(job.status)) return response.status(409).json({ error: "The job must finish first" });
  const queued = await enqueuePreset(job.id, request.params.slug);
  response.status(202).json(queued.job);
});

app.get("/api/jobs/:id/files/*file", async (request, response) => {
  const relative = Array.isArray(request.params.file) ? request.params.file.join("/") : request.params.file;
  const file = safeOutputPath(request.params.id, relative);
  await fs.access(file);
  response.sendFile(file);
});

app.delete("/api/jobs/:id/files/*file", async (request, response) => {
  const job = await readJob(request.params.id);
  if (["queued", "preparing", "processing", "merging"].includes(job.status)) return response.status(409).json({ error: "Files cannot be deleted while a job is processing" });
  const relative = Array.isArray(request.params.file) ? request.params.file.join("/") : request.params.file;
  response.json(await deleteOutputFile(job.id, relative));
});
app.patch("/api/jobs/:id/files/*file", async (request, response) => {
  const job = await readJob(request.params.id);
  if (["queued", "preparing", "processing", "merging"].includes(job.status)) return response.status(409).json({ error: "Files cannot be renamed while a job is processing" });
  const relative = Array.isArray(request.params.file) ? request.params.file.join("/") : request.params.file;
  const { name } = renameSchema.parse(request.body);
  response.json(await renameOutputFile(job.id, relative, name));
});

app.get("/api/jobs/:id/input/:file", async (request, response) => {
  const file = safeInputPath(request.params.id, request.params.file);
  await fs.access(file);
  response.sendFile(file);
});

app.delete("/api/jobs/:id/input/:file", async (request, response) => {
  const job = await readJob(request.params.id);
  if (["queued", "preparing", "processing", "merging"].includes(job.status)) return response.status(409).json({ error: "Files cannot be deleted while a job is processing" });
  response.json(await deleteInputFile(job.id, request.params.file));
});
app.patch("/api/jobs/:id/input/:file", async (request, response) => {
  const job = await readJob(request.params.id);
  if (["queued", "preparing", "processing", "merging"].includes(job.status)) return response.status(409).json({ error: "Files cannot be renamed while a job is processing" });
  const { name } = renameSchema.parse(request.body);
  response.json(await renameInputFile(job.id, request.params.file, name));
});

app.get("/api/chats", async (_request, response) => response.json(await listChats()));
app.post("/api/chats", async (request, response) => response.status(201).json(await createChat(request.body?.linkedJobId)));
app.get("/api/chats/:id", async (request, response) => response.json(await readChat(request.params.id)));
app.patch("/api/chats/:id", async (request, response) => {
  const { title } = titleSchema.parse(request.body);
  response.json(await renameChat(request.params.id, title));
});
app.delete("/api/chats/:id", async (request, response) => {
  await deleteChat(request.params.id);
  response.status(204).end();
});
app.post("/api/chats/:id/messages", async (request, response) => {
  const content = z.string().min(1).max(500_000).parse(request.body?.content);
  const chat = await readChat(request.params.id);
  const settings = await readSettings();
  const now = new Date().toISOString();
  const userMessage: ChatMessage = { id: randomUUID(), role: "user", content, createdAt: now };
  chat.messages.push(userMessage);
  if (chat.title === "New conversation") chat.title = content.replace(/\s+/g, " ").slice(0, 54);
  await writeChat(chat);

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  let assistant = "";
  const upstreamController = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) upstreamController.abort();
  });
  try {
    const body = await openChatStream(
      { ...settings.endpoints.llm, model: chat.model || settings.endpoints.llm.model },
      await modelMessagesForChat(chat, settings),
      chat.temperature,
      upstreamController.signal,
    );
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = parsed.choices?.[0]?.delta?.content || "";
          if (delta) {
            assistant += delta;
            response.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {
          // Some compatible servers emit non-JSON bookkeeping events.
        }
      }
      if (done) break;
    }
    if (!assistant.trim()) throw new Error("The language model finished without returning final content");
    const assistantMessage: ChatMessage = { id: randomUUID(), role: "assistant", content: assistant, createdAt: new Date().toISOString() };
    chat.messages.push(assistantMessage);
    await writeChat(chat);
    response.write(`data: ${JSON.stringify({ done: true, message: assistantMessage })}\n\n`);
    response.end();
  } catch (error) {
    response.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
    response.end();
  }
});

if (await fs.stat(CLIENT_DIR).then((value) => value.isDirectory()).catch(() => false)) {
  app.use(express.static(CLIENT_DIR));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api")) return next();
    response.sendFile(path.join(CLIENT_DIR, "index.html"));
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const explicitStatus = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
  const status = explicitStatus || (error instanceof z.ZodError || hasErrorCode(error, "EINVAL") ? 400 : isNotFound(error) ? 404 : hasErrorCode(error, "EEXIST") ? 409 : 500);
  const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join("; ") : error instanceof Error ? error.message : String(error);
  if (status === 500) console.error(error);
  response.status(status).json({ error: message });
});

function inferJobKind(files: Express.Multer.File[]): JobKind | undefined {
  if (!files.length) return undefined;
  const extensions = files.map((file) => path.extname(file.originalname).toLowerCase());
  if (files.every((file) => file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf"))) return "pdf";
  if (files.every((file, index) => file.mimetype.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(extensions[index]))) return "image";
  if (files.every((file, index) => file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/") || [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(extensions[index]))) return "audio";
  return undefined;
}

function isNotFound(error: unknown) {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`SparklingKit listening on http://0.0.0.0:${PORT}`);
  await startWorker();
});

async function shutdown() {
  server.close();
  await closeQueue();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
