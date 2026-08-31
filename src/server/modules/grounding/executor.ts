import { promises as fs } from "node:fs";
import path from "node:path";
import { groundImage, type GroundingResult } from "../../ai.js";
import { publishJob } from "../../events.js";
import type { JobManifest, WorkflowRun } from "../../models.js";
import { jobDir, readSettings, safeOutputPath, updateJob } from "../../store.js";
import type { WorkflowExecutionResult } from "../executors.js";

const colors = ["#ff5a5f", "#39d98a", "#ffd166", "#7aa7ff", "#d58cff", "#4dd9e8", "#ff9f43", "#f368e0"];

async function report(jobId: string, patch: Parameters<typeof updateJob>[1]) {
  const job = await updateJob(jobId, patch);
  publishJob(jobId, job);
}

function xml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function sourceMime(file: string, advertised: string) {
  const extension = path.extname(file).toLowerCase();
  if (advertised.startsWith("image/")) return advertised;
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function framedSvg(bytes: Buffer, mimeType: string, width: number, height: number, results: Array<{ query: string; result: GroundingResult }>) {
  const minimumStroke = Math.max(2, Math.round(Math.max(width, height) / 350));
  const fontSize = Math.max(13, Math.round(Math.max(width, height) / 45));
  const overlays = results.flatMap(({ query, result }, queryIndex) => result.boxes.map((box, boxIndex) => {
    const color = colors[queryIndex % colors.length];
    const label = results.length > 1 || result.boxes.length > 1 ? `${queryIndex + 1}.${boxIndex + 1} ${query}` : query;
    const labelWidth = Math.min(width - box.x1, Math.max(fontSize * 3, label.length * fontSize * 0.62 + fontSize));
    const labelY = Math.max(0, box.y1 - fontSize * 1.5);
    return `<g><rect x="${box.x1}" y="${box.y1}" width="${box.x2 - box.x1}" height="${box.y2 - box.y1}" rx="${minimumStroke}" fill="none" stroke="${color}" stroke-width="${minimumStroke}"/><rect x="${box.x1}" y="${labelY}" width="${labelWidth}" height="${fontSize * 1.5}" rx="${minimumStroke}" fill="${color}"/><text x="${box.x1 + fontSize * 0.45}" y="${labelY + fontSize * 1.08}" fill="#0b0d10" font-family="Inter,Arial,sans-serif" font-size="${fontSize}" font-weight="700">${xml(label)}</text></g>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Grounding results"><title>Grounding results</title><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:${mimeType};base64,${bytes.toString("base64")}"/>${overlays.join("")}</svg>\n`;
}

export async function processGrounding(job: JobManifest, run: WorkflowRun, signal?: AbortSignal): Promise<WorkflowExecutionResult> {
  const settings = await readSettings();
  const endpoint = settings.endpoints.grounding;
  if (!endpoint.enabled || !endpoint.baseUrl || !endpoint.model) throw new Error("Configure and enable the Grounding service in Settings first");
  const input = job.inputs[0];
  if (!input) throw new Error("This grounding job has no source image");
  const queries = Array.isArray(run.params.queries)
    ? [...new Set(run.params.queries.filter((query): query is string => typeof query === "string").map((query) => query.trim()).filter(Boolean))]
    : [];
  if (!queries.length) throw new Error("This grounding job has no search queries");
  const sourceFile = path.join(jobDir(job.id), "input", input.storedName);
  const results: Array<{ query: string; result: GroundingResult }> = [];
  const warnings: string[] = [];
  await report(job.id, { status: "preparing", progress: 6, stage: "Preparing image search", startedAt: run.startedAt || new Date().toISOString() });
  for (const [index, query] of queries.entries()) {
    if (signal?.aborted) throw new DOMException("Grounding cancelled", "AbortError");
    await report(job.id, { status: "processing", progress: 12 + Math.round((index / queries.length) * 76), stage: "Finding locations", detail: query });
    const result = await groundImage(endpoint, sourceFile, query, signal);
    results.push({ query, result });
    if (!result.boxes.length) warnings.push(`No location found for “${query}”`);
  }
  await report(job.id, { status: "merging", progress: 92, stage: "Drawing result frames", detail: undefined });
  const dimensions = results[0]?.result;
  if (!dimensions) throw new Error("The grounding service returned no results");
  const sourceBytes = await fs.readFile(sourceFile);
  const previewName = "grounding-preview.svg";
  const annotationsName = "grounding.annotations.json";
  const annotations = {
    schemaVersion: 1,
    source: { name: input.name, storedName: input.storedName, width: dimensions.imageWidth, height: dimensions.imageHeight },
    queries: results.map(({ query, result }, index) => ({ query, color: colors[index % colors.length], answer: result.answer, boxes: result.boxes, points: result.points })),
  };
  await Promise.all([
    fs.writeFile(safeOutputPath(job.id, previewName), framedSvg(sourceBytes, sourceMime(input.storedName, input.mimeType), dimensions.imageWidth, dimensions.imageHeight, results), "utf8"),
    fs.writeFile(safeOutputPath(job.id, annotationsName), `${JSON.stringify(annotations, null, 2)}\n`, "utf8"),
  ]);
  return { outputFiles: [previewName, annotationsName], warnings };
}
