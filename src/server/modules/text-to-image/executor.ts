import { promises as fs } from "node:fs";
import { generateImage } from "../../ai.js";
import { publishJob } from "../../events.js";
import type { JobManifest, WorkflowRun } from "../../models.js";
import { readSettings, safeOutputPath, updateJob } from "../../store.js";
import type { WorkflowExecutionResult } from "../executors.js";

async function report(jobId: string, patch: Parameters<typeof updateJob>[1]) {
  const job = await updateJob(jobId, patch);
  publishJob(jobId, job);
}

export async function processTextToImage(job: JobManifest, run: WorkflowRun, signal?: AbortSignal): Promise<WorkflowExecutionResult> {
  const settings = await readSettings();
  const endpoint = settings.endpoints["image-generation"];
  if (!endpoint.enabled || !endpoint.baseUrl || !endpoint.model) throw new Error("Configure and enable the Image generation service in Settings first");
  const prompt = typeof run.params.prompt === "string" ? run.params.prompt.trim() : "";
  if (!prompt) throw new Error("This image-generation run has no prompt");
  const size = typeof run.params.size === "string" ? run.params.size : "1024x1024";
  await report(job.id, { status: "preparing", progress: 8, stage: "Preparing image request", startedAt: run.startedAt || new Date().toISOString() });
  await report(job.id, { status: "processing", progress: 18, stage: "Generating image", detail: size.replace("x", " × ") });
  const generated = await generateImage(endpoint, prompt, { size }, signal);
  if (signal?.aborted) throw new DOMException("Image generation cancelled", "AbortError");
  await report(job.id, { status: "merging", progress: 94, stage: "Saving generated image", detail: undefined });
  const baseName = `generated-image${generated.extension}`;
  const outputName = job.outputFiles.includes(baseName) ? `generated-image-${run.id.replace(/^run-/, "").slice(0, 8)}${generated.extension}` : baseName;
  await fs.writeFile(safeOutputPath(job.id, outputName), generated.bytes);
  return { outputFiles: [...new Set([...job.outputFiles, outputName])], warnings: [] };
}
