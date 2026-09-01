import { promises as fs } from "node:fs";
import path from "node:path";
import { chatCompletion } from "../../ai.js";
import { publishJob } from "../../events.js";
import type { JobManifest, WorkflowRun } from "../../models.js";
import { readSettings, safeArtifactPath, safeOutputPath, updateJob } from "../../store.js";
import type { WorkflowExecutionResult } from "../executors.js";

async function report(jobId: string, patch: Parameters<typeof updateJob>[1]) {
  const job = await updateJob(jobId, patch);
  publishJob(jobId, job);
}

function imageMime(name: string, declared: string) {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(declared)) return declared;
  const extension = path.extname(name).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
}

export async function processLlmPrompt(job: JobManifest, run: WorkflowRun, signal?: AbortSignal): Promise<WorkflowExecutionResult> {
  const settings = await readSettings();
  const endpoint = settings.endpoints.llm;
  if (!endpoint.enabled || !endpoint.baseUrl || !endpoint.model) throw new Error("Configure and enable the LLM service in Settings first");
  const artifacts = run.inputArtifactIds.map((id) => job.artifacts.find((artifact) => artifact.id === id)).filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
  if (!artifacts.length) throw new Error("Choose at least one input for the LLM prompt");
  const instruction = typeof run.params.prompt === "string" && run.params.prompt.trim() ? run.params.prompt.trim() : "Summarize the supplied material into clear Markdown.";
  const system = typeof run.params.systemPrompt === "string" && run.params.systemPrompt.trim() ? run.params.systemPrompt.trim() : "You are a careful file assistant. Use only the supplied material and return useful Markdown.";
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text: instruction }];
  let totalText = 0;
  for (const artifact of artifacts) {
    const file = safeArtifactPath(job.id, artifact.path);
    if (["source-image", "generated-image", "grounded-image"].includes(artifact.kind)) {
      if (!endpoint.capabilities?.includes("image")) throw new Error("The configured LLM does not accept image input");
      const bytes = await fs.readFile(file);
      if (bytes.length > 20 * 1024 * 1024) throw new Error(`${artifact.name} is too large for an LLM image input`);
      content.push({ type: "image_url", image_url: { url: `data:${imageMime(artifact.name, artifact.mimeType)};base64,${bytes.toString("base64")}` } });
    } else {
      const text = await fs.readFile(file, "utf8");
      totalText += text.length;
      if (totalText > 500_000) throw new Error("LLM workflow input is limited to 500,000 characters");
      content.push({ type: "text", text: `\n\n## ${artifact.name}\n\n${text}` });
    }
  }
  await report(job.id, { status: "processing", progress: 15, stage: "Running LLM prompt", startedAt: run.startedAt || new Date().toISOString() });
  const result = await chatCompletion(endpoint, [{ role: "system", content: system }, { role: "user", content }], {
    temperature: typeof run.params.temperature === "number" ? run.params.temperature : 0.2,
    maxTokens: typeof run.params.maxTokens === "number" ? run.params.maxTokens : 8192,
  }, signal);
  await report(job.id, { status: "merging", progress: 94, stage: "Saving LLM result" });
  const baseName = "llm-result.md";
  const outputName = job.outputFiles.includes(baseName) ? `llm-result-${run.id.replace(/^run-/, "").slice(0, 8)}.md` : baseName;
  await fs.writeFile(safeOutputPath(job.id, outputName), `${result}\n`, "utf8");
  return { outputFiles: [...new Set([...job.outputFiles, outputName])], warnings: [] };
}
