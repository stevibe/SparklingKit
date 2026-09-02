import { promises as fs } from "node:fs";
import path from "node:path";
import { publishJob } from "../../events.js";
import type { JobManifest, WorkflowRun } from "../../models.js";
import { readSettings, safeArtifactPath, safeOutputPath, updateJob } from "../../store.js";
import type { WorkflowExecutionResult } from "../executors.js";
import { translateContent } from "./service.js";

export function splitTranslationText(text: string, maxTokens: number) {
  const maxChars = Math.max(1000, maxTokens * 3);
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length) {
    let end = Math.min(maxChars, remaining.length);
    if (end < remaining.length) {
      const paragraph = remaining.lastIndexOf("\n\n", end);
      if (paragraph > maxChars * 0.55) end = paragraph;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

function fileSlug(value: string) {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40) || "translated";
}

async function report(jobId: string, patch: Parameters<typeof updateJob>[1]) {
  const job = await updateJob(jobId, patch);
  publishJob(jobId, job);
}

export async function processTranslation(job: JobManifest, run: WorkflowRun, signal?: AbortSignal): Promise<WorkflowExecutionResult> {
  const settings = await readSettings();
  const endpoint = settings.endpoints.translation;
  if (!endpoint.enabled || !endpoint.baseUrl || !endpoint.model) throw new Error("Configure and enable the Translation service in Settings first");
  const artifactId = typeof run.params.artifactId === "string" ? run.params.artifactId : run.inputArtifactIds[0];
  const artifact = job.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact || !["document", "transcript", "translation", "redacted-document", "text"].includes(artifact.kind)) throw new Error("Choose a text artifact to translate");
  const targetLanguage = typeof run.params.targetLanguage === "string" ? run.params.targetLanguage.trim() : "";
  if (!targetLanguage) throw new Error("Choose a target language");
  const sourceLanguage = typeof run.params.sourceLanguage === "string" && run.params.sourceLanguage.trim() ? run.params.sourceLanguage.trim() : "auto-detect";
  const source = await fs.readFile(safeArtifactPath(job.id, artifact.path), "utf8");
  const chunks = splitTranslationText(source, typeof run.params.maxInputTokens === "number" ? run.params.maxInputTokens : 2000);
  const translated: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted) throw new DOMException("Translation cancelled", "AbortError");
    await report(job.id, {
      status: "processing",
      progress: 8 + Math.round((index / chunks.length) * 82),
      stage: `Translating to ${targetLanguage}`,
      detail: chunks.length > 1 ? `Part ${index + 1} of ${chunks.length}` : artifact.name,
      startedAt: run.startedAt || new Date().toISOString(),
    });
    translated.push(await translateContent(endpoint, chunk, sourceLanguage, targetLanguage, { index: index + 1, total: chunks.length }, signal));
  }
  await report(job.id, { status: "merging", progress: 94, stage: "Building translated document", detail: undefined });
  const extension = artifact.mimeType === "text/html" || [".html", ".htm"].includes(path.extname(artifact.name).toLowerCase()) ? ".html" : ".md";
  const outputName = `translation.${fileSlug(targetLanguage)}${extension}`;
  await fs.writeFile(safeOutputPath(job.id, outputName), `${translated.join("\n\n")}\n`, "utf8");
  return { outputFiles: [...new Set([...job.outputFiles, outputName])], warnings: [] };
}
