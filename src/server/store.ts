import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lookup as mimeLookup } from "mime-types";
import { DATA_DIR, defaultPrompts, defaultSettings } from "./config.js";
import { moduleForLegacyJob } from "./modules/registry.js";
import { ENDPOINT_KINDS } from "../shared/contracts.js";
import type { Artifact, ArtifactKind, ChatRecord, JobKind, JobManifest, JobStatus, ModuleId, PromptPreset, Settings, WorkflowRun } from "./models.js";

const settingsPath = path.join(DATA_DIR, "config", "settings.json");
const secretsPath = path.join(DATA_DIR, "config", "secrets.json");

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

export async function initializeData() {
  for (const folder of ["config/prompts", "config/workflows", "jobs", "chats", "logs", "tmp"]) {
    await fs.mkdir(path.join(DATA_DIR, folder), { recursive: true });
  }
  if (!(await exists(settingsPath))) {
    const safe = structuredClone(defaultSettings);
    for (const endpoint of Object.values(safe.endpoints)) endpoint.apiKey = "";
    await atomicWriteJson(settingsPath, safe);
  } else {
    const saved = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Partial<Settings> & { pdf?: Partial<Settings["pdf"]> & { skipOcrIfTextLayer?: boolean } };
    let changed = false;
    if (!saved.setup) {
      const hasConfiguredService = Object.values(saved.endpoints || {}).some((endpoint) => Boolean(endpoint?.baseUrl && endpoint?.model));
      saved.setup = { completed: hasConfiguredService || defaultSettings.setup.completed, mode: defaultSettings.setup.mode, onboardingVersion: 1, ...(hasConfiguredService || defaultSettings.setup.completed ? { completedAt: new Date().toISOString() } : {}) };
      changed = true;
    }
    if (saved.pdf && "skipOcrIfTextLayer" in saved.pdf) {
      delete saved.pdf.skipOcrIfTextLayer;
      changed = true;
    }
    changed = migrateBundledServiceDefaults(saved) || changed;
    if (changed) await atomicWriteJson(settingsPath, saved);
  }
  if (!(await exists(secretsPath))) {
    await atomicWriteJson(secretsPath, Object.fromEntries(ENDPOINT_KINDS.map((kind) => [kind, ""])));
    await fs.chmod(secretsPath, 0o600).catch(() => undefined);
  }
  for (const prompt of defaultPrompts) {
    const file = path.join(DATA_DIR, "config", "prompts", `${prompt.slug}.json`);
    if (!(await exists(file))) await atomicWriteJson(file, prompt);
  }
  const settings = await readSettings();
  if (settings.schemaVersion !== 2) throw new Error("Settings migration failed");
  await writeSettings(settings);
}

function migrateBundledServiceDefaults(saved: Partial<Settings>) {
  if (!saved.endpoints) saved.endpoints = {} as Settings["endpoints"];
  let changed = false;
  const move = (kind: keyof Settings["endpoints"], previousBaseUrls: string[], provisionIfEmpty = false) => {
    const current = saved.endpoints?.[kind];
    const replacement = defaultSettings.endpoints[kind];
    if (!replacement.baseUrl) return;
    const isEmpty = !current?.baseUrl && !current?.model;
    if (!current || previousBaseUrls.includes(current.baseUrl) || (provisionIfEmpty && isEmpty)) {
      saved.endpoints![kind] = { ...replacement, apiKey: "" };
      changed = true;
    }
  };
  move("llm", ["http://192.0.2.10:8000/v1", "http://192.0.2.10:8330/v1"]);
  move("ocr", ["http://192.0.2.10:8222/v1", "http://192.0.2.10:8331/v1"]);
  move("stt", ["http://192.0.2.10:8332/v1"]);
  move("translation", ["http://192.0.2.10:8333/v1", "http://192.0.2.10:8444/v1", "http://192.0.2.10:8444"], true);
  move("grounding", ["http://192.0.2.10:8334/v1", "http://192.0.2.10:8555/v1", "http://192.0.2.10:8555"], true);
  move("image-generation", ["http://192.0.2.10:8335/v1", "http://192.0.2.10:8666/v1", "http://192.0.2.10:8666"], true);
  return changed;
}

export async function readSettings(): Promise<Settings> {
  const saved = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Partial<Settings>;
  const secrets = JSON.parse(await fs.readFile(secretsPath, "utf8")) as Record<string, string>;
  const endpoints = Object.fromEntries(ENDPOINT_KINDS.map((kind) => [
    kind,
    {
      ...defaultSettings.endpoints[kind],
      ...saved.endpoints?.[kind],
      apiKey: secrets[kind] || "",
      enabled: saved.endpoints?.[kind]?.enabled ?? defaultSettings.endpoints[kind].enabled,
    },
  ])) as Settings["endpoints"];
  const merged: Settings = {
    ...structuredClone(defaultSettings),
    ...saved,
    schemaVersion: 2,
    setup: { ...defaultSettings.setup, ...saved.setup },
    systemStatus: { ...defaultSettings.systemStatus, ...saved.systemStatus },
    endpoints,
    audio: { ...defaultSettings.audio, ...saved.audio },
    pdf: { ...defaultSettings.pdf, ...saved.pdf },
    queue: { ...defaultSettings.queue, ...saved.queue },
    retention: { ...defaultSettings.retention, ...saved.retention },
    ui: { ...defaultSettings.ui, ...saved.ui },
  };
  return merged;
}

export async function writeSettings(settings: Settings) {
  const safe = structuredClone(settings);
  safe.schemaVersion = 2;
  const secrets = Object.fromEntries(ENDPOINT_KINDS.map((kind) => [kind, safe.endpoints[kind].apiKey]));
  for (const endpoint of Object.values(safe.endpoints)) endpoint.apiKey = "";
  await atomicWriteJson(settingsPath, safe);
  await atomicWriteJson(secretsPath, secrets);
  await fs.chmod(secretsPath, 0o600).catch(() => undefined);
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 48) || "untitled";
}

function timestampId(timeZone: string) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(" ", "_")
    .replaceAll(":", "")
    .replaceAll("-", "-");
  return parts;
}

export function jobDir(id: string) {
  assertSafeName(id);
  return path.join(DATA_DIR, "jobs", id);
}

function stableArtifactId(role: "source" | "output", value: string) {
  return `${role}-${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

function sourceArtifactKind(input: { name: string; mimeType: string }): ArtifactKind {
  const name = input.name.toLowerCase();
  if (input.mimeType.startsWith("audio/")) return "source-audio";
  if (input.mimeType.startsWith("video/")) return "source-video";
  if (input.mimeType.startsWith("image/")) return "source-image";
  if (input.mimeType === "application/pdf" || name.endsWith(".pdf")) return "source-pdf";
  return "text";
}

function outputArtifactKind(file: string): ArtifactKind {
  const lower = file.toLowerCase();
  if (lower === "mindmap.json" || lower.endsWith(".mindmap.json")) return "mindmap";
  if (lower.includes("grounding") && /\.(?:svg|png|jpe?g|webp)$/.test(lower)) return "grounded-image";
  if (/\.(?:png|jpe?g|webp|gif|avif)$/.test(lower)) return "generated-image";
  if (/\.(?:srt|vtt)$/.test(lower)) return "subtitle";
  if (lower.endsWith(".json")) return lower.includes("ground") ? "annotations" : "structured-data";
  if (lower.includes("translation")) return "translation";
  if (lower.includes("redacted")) return "redacted-document";
  if (lower.includes("transcript")) return "transcript";
  if (lower.endsWith(".md") || lower.endsWith(".html") || lower.endsWith(".txt")) return "document";
  return "text";
}

function sourceArtifacts(inputs: JobManifest["inputs"], createdAt: string): Artifact[] {
  return inputs.map((input) => ({
    id: stableArtifactId("source", input.storedName),
    name: input.name,
    path: `input/${input.storedName}`,
    kind: sourceArtifactKind(input),
    mimeType: input.mimeType || String(mimeLookup(input.name) || "application/octet-stream"),
    role: "source",
    createdAt,
    derivedFrom: [],
    metadata: { size: input.size, storedName: input.storedName },
  }));
}

function syncOutputArtifacts(job: JobManifest, outputFiles: string[], runId?: string): Artifact[] {
  const visible = userFacingOutputFiles(outputFiles);
  const sourceIds = job.artifacts.filter((artifact) => artifact.role === "source").map((artifact) => artifact.id);
  const existing = new Map(job.artifacts.filter((artifact) => artifact.role !== "source").map((artifact) => [artifact.path, artifact]));
  const producingRun = runId ? job.runs.find((run) => run.id === runId) : undefined;
  const generated = visible.map((file, index) => {
    const artifactPath = `output/${file}`;
    const current = existing.get(artifactPath);
    return current || {
      id: stableArtifactId("output", file),
      name: path.posix.basename(file),
      path: artifactPath,
      kind: outputArtifactKind(file),
      mimeType: String(mimeLookup(file) || "text/plain"),
      role: index === 0 ? "primary" as const : "supplementary" as const,
      createdAt: job.completedAt || job.updatedAt,
      createdByRunId: runId,
      derivedFrom: producingRun?.inputArtifactIds.length ? producingRun.inputArtifactIds : sourceIds,
      metadata: {},
    };
  });
  return [...job.artifacts.filter((artifact) => artifact.role === "source"), ...generated];
}

function runStatus(status: JobStatus): WorkflowRun["status"] {
  return status;
}

function normalizeJobManifest(raw: Partial<JobManifest> & Pick<JobManifest, "id" | "type" | "status" | "createdAt" | "updatedAt" | "title" | "progress" | "stage" | "inputs" | "outputFiles" | "warnings" | "params">): JobManifest {
  const mapping = moduleForLegacyJob(raw.type);
  const moduleId = raw.moduleId || mapping.moduleId;
  const workflowId = raw.workflowId || mapping.workflowId;
  const initialArtifacts = raw.artifacts?.length ? raw.artifacts : sourceArtifacts(raw.inputs, raw.createdAt);
  const base: JobManifest = {
    ...raw,
    schemaVersion: 2,
    moduleId,
    workflowId,
    artifacts: initialArtifacts,
    runs: raw.runs !== undefined ? raw.runs : [{
      id: "initial",
      moduleId,
      workflowId,
      status: runStatus(raw.status),
      progress: raw.progress,
      stage: raw.stage,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
      inputArtifactIds: initialArtifacts.filter((artifact) => artifact.role === "source").map((artifact) => artifact.id),
      outputArtifactIds: [],
      params: raw.params,
      steps: [],
      warnings: raw.warnings,
      error: raw.error,
      cancelRequested: raw.cancelRequested,
    }],
  } as JobManifest;
  base.outputFiles = userFacingOutputFiles(base.outputFiles);
  base.artifacts = syncOutputArtifacts(base, base.outputFiles, base.runs.at(-1)?.id);
  const artifactIds = base.artifacts.filter((artifact) => artifact.role !== "source").map((artifact) => artifact.id);
  if (base.runs.length && !base.runs.at(-1)!.outputArtifactIds.length) base.runs.at(-1)!.outputArtifactIds = artifactIds;
  return base;
}

export async function createJob(
  type: JobKind,
  files: Express.Multer.File[],
  params: Record<string, unknown> = {},
): Promise<JobManifest> {
  if (!files.length) throw new Error("At least one file is required");
  const settings = await readSettings();
  const title = files.length === 1 ? files[0].originalname : `${files[0].originalname} +${files.length - 1}`;
  const id = `${timestampId(settings.ui.timezone)}_${slugify(path.parse(files[0].originalname).name)}-${randomUUID().slice(0, 6)}`;
  const root = jobDir(id);
  await Promise.all(["input", "work", "output"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  const inputs = [];
  for (const [index, file] of files.entries()) {
    const ext = path.extname(file.originalname).toLowerCase();
    const storedName = `${String(index + 1).padStart(3, "0")}-${slugify(path.parse(file.originalname).name)}${ext}`;
    await fs.rename(file.path, path.join(root, "input", storedName));
    inputs.push({ name: file.originalname, storedName, mimeType: file.mimetype, size: file.size });
  }
  const now = new Date().toISOString();
  const mapping = moduleForLegacyJob(type);
  const artifacts = sourceArtifacts(inputs, now);
  const run: WorkflowRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    moduleId: mapping.moduleId,
    workflowId: mapping.workflowId,
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds: artifacts.map((artifact) => artifact.id),
    outputArtifactIds: [],
    params,
    steps: [],
    warnings: [],
  };
  const manifest: JobManifest = {
    schemaVersion: 2,
    id,
    type,
    moduleId: mapping.moduleId,
    workflowId: mapping.workflowId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    title,
    progress: 0,
    stage: "Waiting for a worker",
    inputs,
    outputFiles: [],
    artifacts,
    runs: [run],
    warnings: [],
    params,
  };
  await atomicWriteJson(path.join(root, "job.json"), manifest);
  return manifest;
}

export async function createTextToImageJob(prompt: string, params: Record<string, unknown> = {}): Promise<JobManifest> {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) throw invalid("Enter an image description");
  const title = normalizedPrompt.replace(/\s+/g, " ").slice(0, 80);
  const settings = await readSettings();
  const id = `${timestampId(settings.ui.timezone)}_${slugify(title)}-${randomUUID().slice(0, 6)}`;
  const root = jobDir(id);
  await Promise.all(["input", "work", "output"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  const storedName = "prompt.txt";
  await fs.writeFile(path.join(root, "input", storedName), `${normalizedPrompt}\n`, "utf8");
  const inputs = [{ name: "Prompt.txt", storedName, mimeType: "text/plain", size: Buffer.byteLength(`${normalizedPrompt}\n`) }];
  const now = new Date().toISOString();
  const artifacts = sourceArtifacts(inputs, now);
  const run: WorkflowRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    moduleId: "text-to-image",
    workflowId: "text-to-image.default",
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds: artifacts.map((artifact) => artifact.id),
    outputArtifactIds: [],
    params: { ...params, prompt: normalizedPrompt },
    steps: [],
    warnings: [],
  };
  const manifest: JobManifest = {
    schemaVersion: 2,
    id,
    type: "text",
    moduleId: "text-to-image",
    workflowId: "text-to-image.default",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    title,
    progress: 0,
    stage: "Waiting for a worker",
    inputs,
    outputFiles: [],
    artifacts,
    runs: [run],
    warnings: [],
    params: { ...params, prompt: normalizedPrompt },
  };
  await atomicWriteJson(path.join(root, "job.json"), manifest);
  return manifest;
}

export async function createMindMapJob(subject: string, params: Record<string, unknown> = {}): Promise<JobManifest> {
  const normalizedSubject = subject.trim();
  if (!normalizedSubject) throw invalid("Enter a topic or source notes");
  const subjectTitle = normalizedSubject.replace(/\s+/g, " ").slice(0, 72);
  const title = `Mind map · ${subjectTitle}`;
  const settings = await readSettings();
  const id = `${timestampId(settings.ui.timezone)}_${slugify(title)}-${randomUUID().slice(0, 6)}`;
  const root = jobDir(id);
  await Promise.all(["input", "work", "output"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  const storedName = "source.txt";
  await fs.writeFile(path.join(root, "input", storedName), `${normalizedSubject}\n`, "utf8");
  const inputs = [{ name: "Mind map source.txt", storedName, mimeType: "text/plain", size: Buffer.byteLength(`${normalizedSubject}\n`) }];
  const now = new Date().toISOString();
  const artifacts = sourceArtifacts(inputs, now);
  const runParams = { ...params, artifactId: artifacts[0].id, subject: normalizedSubject };
  const run: WorkflowRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    moduleId: "mindmap",
    workflowId: "mindmap.default",
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds: artifacts.map((artifact) => artifact.id),
    outputArtifactIds: [],
    params: runParams,
    steps: [],
    warnings: [],
  };
  const manifest: JobManifest = {
    schemaVersion: 2,
    id,
    type: "text",
    moduleId: "mindmap",
    workflowId: "mindmap.default",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    title,
    progress: 0,
    stage: "Waiting for a worker",
    inputs,
    outputFiles: [],
    artifacts,
    runs: [run],
    warnings: [],
    params: runParams,
  };
  await atomicWriteJson(path.join(root, "job.json"), manifest);
  return manifest;
}

export async function createTextTranslationJob(text: string, sourceLanguage: string, targetLanguage: string): Promise<JobManifest> {
  const normalizedText = text.trim();
  if (!normalizedText) throw invalid("Enter text to translate");
  if (!targetLanguage.trim()) throw invalid("Choose a target language");
  const title = `Translation to ${targetLanguage.trim()} · ${normalizedText.replace(/\s+/g, " ").slice(0, 64)}`;
  const settings = await readSettings();
  const id = `${timestampId(settings.ui.timezone)}_${slugify(title)}-${randomUUID().slice(0, 6)}`;
  const root = jobDir(id);
  await Promise.all(["input", "work", "output"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  const storedName = "source.txt";
  await fs.writeFile(path.join(root, "input", storedName), `${normalizedText}\n`, "utf8");
  const inputs = [{ name: "Source text.txt", storedName, mimeType: "text/plain", size: Buffer.byteLength(`${normalizedText}\n`) }];
  const now = new Date().toISOString();
  const artifacts = sourceArtifacts(inputs, now);
  const params = { artifactId: artifacts[0].id, sourceLanguage: sourceLanguage.trim() || "auto-detect", targetLanguage: targetLanguage.trim() };
  const run: WorkflowRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    moduleId: "translation",
    workflowId: "translation.default",
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds: [artifacts[0].id],
    outputArtifactIds: [],
    params,
    steps: [],
    warnings: [],
  };
  const manifest: JobManifest = {
    schemaVersion: 2,
    id,
    type: "text",
    moduleId: "translation",
    workflowId: "translation.default",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    title,
    progress: 0,
    stage: "Waiting for a worker",
    inputs,
    outputFiles: [],
    artifacts,
    runs: [run],
    warnings: [],
    params,
  };
  await atomicWriteJson(path.join(root, "job.json"), manifest);
  return manifest;
}

export async function createFileTranslationJob(file: Express.Multer.File, sourceLanguage: string, targetLanguage: string): Promise<JobManifest> {
  if (!targetLanguage.trim()) throw invalid("Choose a target language");
  if (file.size > 25 * 1024 * 1024) throw invalid("Text files for translation must be 25 MB or smaller");
  const sample = await fs.readFile(file.path);
  if (sample.includes(0)) throw invalid("Choose a UTF-8 text, Markdown, or HTML file");
  const settings = await readSettings();
  const title = `Translation to ${targetLanguage.trim()} · ${file.originalname}`;
  const id = `${timestampId(settings.ui.timezone)}_${slugify(title)}-${randomUUID().slice(0, 6)}`;
  const root = jobDir(id);
  await Promise.all(["input", "work", "output"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  const extension = path.extname(file.originalname).toLowerCase() || ".txt";
  const storedName = `source-${slugify(path.parse(file.originalname).name)}${extension}`;
  await fs.rename(file.path, path.join(root, "input", storedName));
  const inputs = [{ name: file.originalname, storedName, mimeType: file.mimetype || String(mimeLookup(file.originalname) || "text/plain"), size: file.size }];
  const now = new Date().toISOString();
  const artifacts = sourceArtifacts(inputs, now);
  const params = { artifactId: artifacts[0].id, sourceLanguage: sourceLanguage.trim() || "auto-detect", targetLanguage: targetLanguage.trim() };
  const run: WorkflowRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    moduleId: "translation",
    workflowId: "translation.default",
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds: [artifacts[0].id],
    outputArtifactIds: [],
    params,
    steps: [],
    warnings: [],
  };
  const manifest: JobManifest = {
    schemaVersion: 2,
    id,
    type: "text",
    moduleId: "translation",
    workflowId: "translation.default",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    title,
    progress: 0,
    stage: "Waiting for a worker",
    inputs,
    outputFiles: [],
    artifacts,
    runs: [run],
    warnings: [],
    params,
  };
  await atomicWriteJson(path.join(root, "job.json"), manifest);
  return manifest;
}

export async function createGroundingJob(files: Express.Multer.File[], queries: string[]): Promise<JobManifest> {
  if (files.length !== 1) throw invalid("Choose exactly one image to search");
  const normalizedQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
  if (!normalizedQueries.length) throw invalid("Enter at least one thing to find");
  const created = await createJob("image", files, { queries: normalizedQueries });
  const run: WorkflowRun = {
    ...created.runs[0],
    moduleId: "grounding",
    workflowId: "grounding.image",
    params: { queries: normalizedQueries },
  };
  return updateJob(created.id, {
    moduleId: "grounding",
    workflowId: "grounding.image",
    runs: [run],
    params: { queries: normalizedQueries },
  });
}

export async function readJob(id: string): Promise<JobManifest> {
  const raw = JSON.parse(await fs.readFile(path.join(jobDir(id), "job.json"), "utf8")) as Parameters<typeof normalizeJobManifest>[0];
  return normalizeJobManifest(raw);
}

export function userFacingOutputFiles(files: string[]) {
  return files.filter((file) => !/^(?:pages|chunks)\//.test(file));
}

export async function updateJob(id: string, patch: Partial<JobManifest>) {
  const job = await readJob(id);
  const updatedAt = new Date().toISOString();
  const next: JobManifest = { ...job, ...patch, schemaVersion: 2, updatedAt };
  if (patch.outputFiles && !patch.artifacts) next.artifacts = syncOutputArtifacts(next, patch.outputFiles, next.runs.at(-1)?.id);
  const runFields = ["status", "progress", "stage", "warnings", "error", "cancelRequested", "startedAt", "completedAt"] as const;
  if (!patch.runs && runFields.some((field) => field in patch) && next.runs.length) {
    let index = next.runs.length - 1;
    for (let candidate = next.runs.length - 1; candidate >= 0; candidate -= 1) {
      if (["queued", "preparing", "processing", "merging"].includes(next.runs[candidate].status)) { index = candidate; break; }
    }
    const current = next.runs[index];
    next.runs = next.runs.map((run, runIndex) => runIndex === index ? {
      ...run,
      status: patch.status ?? run.status,
      progress: patch.progress ?? run.progress,
      stage: patch.stage ?? run.stage,
      warnings: patch.warnings ?? run.warnings,
      error: patch.error,
      cancelRequested: patch.cancelRequested ?? run.cancelRequested,
      startedAt: patch.startedAt ?? run.startedAt,
      completedAt: patch.completedAt ?? run.completedAt,
      outputArtifactIds: next.artifacts.filter((artifact) => artifact.createdByRunId === run.id || (runIndex === 0 && artifact.role !== "source")).map((artifact) => artifact.id),
      updatedAt,
    } : run);
  }
  await atomicWriteJson(path.join(jobDir(id), "job.json"), next);
  return next;
}

export async function createWorkflowRun(
  jobId: string,
  moduleId: ModuleId | "text-transform",
  workflowId: string,
  params: Record<string, unknown>,
  inputArtifactIds?: string[],
) {
  const job = await readJob(jobId);
  const now = new Date().toISOString();
  const run: WorkflowRun = {
    id: `run-${randomUUID().slice(0, 8)}`,
    moduleId,
    workflowId,
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds: inputArtifactIds || job.artifacts.filter((artifact) => artifact.role === "primary").map((artifact) => artifact.id),
    outputArtifactIds: [],
    params,
    steps: [],
    warnings: [],
  };
  const next = await updateJob(jobId, {
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    detail: undefined,
    error: undefined,
    cancelRequested: false,
    completedAt: undefined,
    runs: [...job.runs, run],
  });
  return { job: next, run };
}

export async function updateWorkflowRun(jobId: string, runId: string, patch: Partial<WorkflowRun>) {
  const job = await readJob(jobId);
  const index = job.runs.findIndex((run) => run.id === runId);
  if (index < 0) throw notFound("Workflow run not found");
  const updatedAt = new Date().toISOString();
  const run = { ...job.runs[index], ...patch, id: runId, updatedAt };
  const runs = job.runs.map((candidate, candidateIndex) => candidateIndex === index ? run : candidate);
  const isCurrent = index === runs.length - 1;
  const next = await updateJob(jobId, {
    runs,
    ...(isCurrent ? {
      status: run.status,
      progress: run.progress,
      stage: run.stage,
      warnings: run.warnings,
      error: run.error,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    } : {}),
  });
  return { job: next, run };
}

export async function listJobs(): Promise<JobManifest[]> {
  const entries = await fs.readdir(path.join(DATA_DIR, "jobs"), { withFileTypes: true });
  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJob(entry.name).catch(() => null)),
  );
  return jobs.filter((job): job is JobManifest => Boolean(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteJob(id: string) {
  await fs.rm(jobDir(id), { recursive: true });
}

export async function renameJob(id: string, title: string) {
  return updateJob(id, { title: cleanTitle(title) });
}

export async function renameOutputFile(id: string, relative: string, requestedName: string) {
  const job = await readJob(id);
  if (!job.outputFiles.includes(relative)) throw notFound("Output file not found");
  const directory = path.posix.dirname(relative);
  const originalName = path.posix.basename(relative);
  const name = renamedFileName(originalName, requestedName);
  const nextRelative = directory === "." ? name : `${directory}/${name}`;
  if (nextRelative === relative) return { job, file: relative };
  const destination = safeOutputPath(id, nextRelative);
  if (await exists(destination)) throw conflict("A file with that name already exists");
  await fs.rename(safeOutputPath(id, relative), destination);
  const next = await updateJob(id, {
    outputFiles: job.outputFiles.map((file) => file === relative ? nextRelative : file),
    artifacts: job.artifacts.map((artifact) => artifact.path === `output/${relative}` ? { ...artifact, name, path: `output/${nextRelative}` } : artifact),
  });
  return { job: next, file: nextRelative };
}

export async function deleteOutputFile(id: string, relative: string) {
  const job = await readJob(id);
  if (!job.outputFiles.includes(relative)) throw notFound("Output file not found");
  const removedId = job.artifacts.find((artifact) => artifact.path === `output/${relative}`)?.id;
  await fs.unlink(safeOutputPath(id, relative));
  return updateJob(id, {
    outputFiles: job.outputFiles.filter((file) => file !== relative),
    artifacts: job.artifacts
      .filter((artifact) => artifact.path !== `output/${relative}`)
      .map((artifact) => removedId ? { ...artifact, derivedFrom: artifact.derivedFrom.filter((id) => id !== removedId) } : artifact),
    runs: removedId ? job.runs.map((run) => ({ ...run, outputArtifactIds: run.outputArtifactIds.filter((id) => id !== removedId), inputArtifactIds: run.inputArtifactIds.filter((id) => id !== removedId) })) : job.runs,
  });
}

export async function deleteInputFile(id: string, storedName: string) {
  const job = await readJob(id);
  if (!job.inputs.some((input) => input.storedName === storedName)) throw notFound("Source file not found");
  const removedId = job.artifacts.find((artifact) => artifact.path === `input/${storedName}`)?.id;
  await fs.unlink(safeInputPath(id, storedName));
  return updateJob(id, {
    inputs: job.inputs.filter((input) => input.storedName !== storedName),
    artifacts: job.artifacts
      .filter((artifact) => artifact.path !== `input/${storedName}`)
      .map((artifact) => removedId ? { ...artifact, derivedFrom: artifact.derivedFrom.filter((id) => id !== removedId) } : artifact),
    runs: removedId ? job.runs.map((run) => ({ ...run, inputArtifactIds: run.inputArtifactIds.filter((id) => id !== removedId) })) : job.runs,
  });
}

export async function renameInputFile(id: string, storedName: string, requestedName: string) {
  const job = await readJob(id);
  const input = job.inputs.find((item) => item.storedName === storedName);
  if (!input) throw notFound("Source file not found");
  const name = renamedFileName(input.name, requestedName);
  return updateJob(id, {
    inputs: job.inputs.map((item) => item.storedName === storedName ? { ...item, name } : item),
    artifacts: job.artifacts.map((artifact) => artifact.path === `input/${storedName}` ? { ...artifact, name } : artifact),
  });
}

export async function listPrompts(): Promise<PromptPreset[]> {
  const folder = path.join(DATA_DIR, "config", "prompts");
  const files = (await fs.readdir(folder)).filter((file) => file.endsWith(".json"));
  const prompts = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(folder, file), "utf8")) as PromptPreset));
  return prompts.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writePrompt(prompt: PromptPreset) {
  assertSafeName(prompt.slug);
  await atomicWriteJson(path.join(DATA_DIR, "config", "prompts", `${prompt.slug}.json`), prompt);
}

export async function readPrompt(slug: string) {
  assertSafeName(slug);
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, "config", "prompts", `${slug}.json`), "utf8")) as PromptPreset;
}

export async function createChat(linkedJobId?: string): Promise<ChatRecord> {
  const now = new Date().toISOString();
  const settings = await readSettings();
  const chat: ChatRecord = {
    id: `${timestampId(settings.ui.timezone)}_chat-${randomUUID().slice(0, 6)}`,
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    model: settings.endpoints.llm.model,
    temperature: 0.7,
    linkedJobId,
    messages: [],
  };
  if (linkedJobId) {
    const job = await readJob(linkedJobId);
    chat.title = `Chat · ${job.title}`;
    if (settings.endpoints.llm.capabilities?.includes("image")) {
      chat.linkedArtifactIds = job.artifacts
        .filter((artifact) => ["source-image", "generated-image", "grounded-image"].includes(artifact.kind))
        .map((artifact) => artifact.id);
    }
    const source = await readChatContext(job);
    chat.messages.push({
      id: randomUUID(),
      role: "system",
      content: `Use the following SparklingKit job context. Answer accurately from it and say when the answer is absent. Compatible image artifacts are attached only when the configured language model accepts image input. If no image is attached, do not claim visual details that are not present in the prompt, annotations, or metadata.\n\n${source}`,
      createdAt: now,
    });
  }
  await writeChat(chat);
  return chat;
}

export async function writeChat(chat: ChatRecord) {
  chat.updatedAt = new Date().toISOString();
  const folder = path.join(DATA_DIR, "chats", chat.id);
  await fs.mkdir(folder, { recursive: true });
  await atomicWriteJson(path.join(folder, "chat.json"), chat);
}

export async function readChat(id: string): Promise<ChatRecord> {
  assertSafeName(id);
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, "chats", id, "chat.json"), "utf8")) as ChatRecord;
}

export async function listChats(): Promise<ChatRecord[]> {
  const entries = await fs.readdir(path.join(DATA_DIR, "chats"), { withFileTypes: true });
  const chats = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => readChat(e.name).catch(() => null)));
  return chats.filter((chat): chat is ChatRecord => Boolean(chat)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteChat(id: string) {
  assertSafeName(id);
  await fs.rm(path.join(DATA_DIR, "chats", id), { recursive: true });
}

export async function renameChat(id: string, title: string) {
  const chat = await readChat(id);
  chat.title = cleanTitle(title);
  await writeChat(chat);
  return chat;
}

export async function readPrimaryOutput(job: JobManifest) {
  const artifactPaths = job.artifacts
    .filter((artifact) => artifact.role !== "source" && ["document", "transcript", "translation", "redacted-document", "text"].includes(artifact.kind))
    .sort((left, right) => Number(right.role === "primary") - Number(left.role === "primary"))
    .map((artifact) => artifact.path.replace(/^output\//, ""));
  const preferred = [...artifactPaths, "transcript.md", "document.md", ...job.outputFiles.filter((file) => file.endsWith(".md"))];
  for (const file of preferred) {
    const full = safeOutputPath(job.id, file);
    if (await exists(full)) return fs.readFile(full, "utf8");
  }
  throw new Error("This job has no text output yet");
}

export async function readChatContext(job: JobManifest) {
  try {
    return await readPrimaryOutput(job);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "This job has no text output yet") throw error;
  }

  const sections: string[] = [
    `Job: ${job.title}`,
    `Module: ${job.moduleId || moduleForLegacyJob(job.type).moduleId}`,
    `Status: ${job.stage}`,
  ];
  if (job.outputFiles.length) sections.push(`Generated files: ${job.outputFiles.join(", ")}`);
  if (Object.keys(job.params).length) sections.push(`Parameters:\n${JSON.stringify(job.params, null, 2)}`);

  const seen = new Set<string>();
  const addTextFile = async (label: string, file: string) => {
    if (seen.has(file) || !(await exists(file))) return;
    seen.add(file);
    const content = (await fs.readFile(file, "utf8")).trim();
    if (!content) return;
    const limit = 100_000;
    sections.push(`${label}:\n${content.slice(0, limit)}${content.length > limit ? "\n[Context truncated]" : ""}`);
  };

  const textualKinds: ArtifactKind[] = ["text", "annotations", "structured-data", "subtitle"];
  for (const artifact of job.artifacts.filter((item) => textualKinds.includes(item.kind) || item.mimeType.startsWith("text/"))) {
    await addTextFile(artifact.name, safeArtifactPath(job.id, artifact.path));
  }
  for (const input of job.inputs.filter((item) => item.mimeType.startsWith("text/") || /\.(?:txt|md|html?|json)$/i.test(item.name))) {
    await addTextFile(input.name, safeInputPath(job.id, input.storedName));
  }
  for (const output of job.outputFiles.filter((file) => /\.(?:txt|md|html?|json|srt|vtt)$/i.test(file))) {
    await addTextFile(output, safeOutputPath(job.id, output));
  }
  return sections.join("\n\n");
}

export function safeOutputPath(id: string, relative: string) {
  const root = path.resolve(jobDir(id), "output");
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid output path");
  return resolved;
}

export function safeInputPath(id: string, relative: string) {
  const root = path.resolve(jobDir(id), "input");
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid input path");
  return resolved;
}

export function safeArtifactPath(id: string, relative: string) {
  const root = path.resolve(jobDir(id));
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid artifact path");
  return resolved;
}

export function assertSafeName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error("Invalid identifier");
}

function cleanTitle(value: string) {
  const title = value.trim().replace(/\s+/g, " ");
  if (!title || title.length > 160) throw invalid("Names must be between 1 and 160 characters");
  return title;
}

function renamedFileName(originalName: string, requestedName: string) {
  let name = requestedName.trim();
  if (!name || name.length > 180 || name === "." || name === ".." || /[\\/\0-\x1f]/.test(name)) throw invalid("Enter a valid file name without folders");
  const originalExtension = path.extname(originalName);
  const requestedExtension = path.extname(name);
  if (!requestedExtension && originalExtension) name += originalExtension;
  else if (requestedExtension.toLowerCase() !== originalExtension.toLowerCase()) throw invalid(`Keep the ${originalExtension || "original"} file extension`);
  return name;
}

function notFound(message: string) {
  return Object.assign(new Error(message), { code: "ENOENT" });
}

function invalid(message: string) {
  return Object.assign(new Error(message), { code: "EINVAL" });
}

function conflict(message: string) {
  return Object.assign(new Error(message), { code: "EEXIST" });
}
