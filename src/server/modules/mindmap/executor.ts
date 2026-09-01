import { promises as fs } from "node:fs";
import path from "node:path";
import { chatCompletion } from "../../ai.js";
import { publishJob } from "../../events.js";
import type { JobManifest, WorkflowRun } from "../../models.js";
import { readSettings, safeArtifactPath, safeOutputPath, updateJob } from "../../store.js";
import type { WorkflowExecutionResult } from "../executors.js";

interface MindMapNode {
  id: string;
  label: string;
  note?: string;
  children: MindMapNode[];
}

interface MindMapDocument {
  version: 1;
  title: string;
  generatedAt: string;
  root: MindMapNode;
}

async function report(jobId: string, patch: Parameters<typeof updateJob>[1]) {
  const job = await updateJob(jobId, patch);
  publishJob(jobId, job);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback;
}

function jsonObject(value: string) {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The LLM did not return a JSON mind map");
  return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
}

function textValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
  }
  return "";
}

export function normalizeMindMap(value: unknown, options: { depth: number; breadth: number }): Omit<MindMapDocument, "generatedAt"> {
  if (!value || typeof value !== "object") throw new Error("The LLM returned an invalid mind map");
  const document = value as Record<string, unknown>;
  const candidate = document.root && typeof document.root === "object" ? document.root : document;
  let nodeCount = 0;
  const visit = (input: unknown, level: number): MindMapNode | undefined => {
    if (nodeCount >= 180) return undefined;
    const record = typeof input === "string" ? { label: input } : input && typeof input === "object" ? input as Record<string, unknown> : undefined;
    if (!record) return undefined;
    const label = textValue(record, ["label", "title", "name", "topic"]).slice(0, 180);
    if (!label) return undefined;
    nodeCount += 1;
    const node: MindMapNode = { id: `node-${nodeCount}`, label, children: [] };
    const note = textValue(record, ["note", "description", "summary", "detail"]).slice(0, 500);
    if (note && note !== label) node.note = note;
    if (level < options.depth - 1) {
      const children = [record.children, record.nodes, record.branches, record.topics].find(Array.isArray) as unknown[] | undefined;
      node.children = (children || []).slice(0, options.breadth).flatMap((child) => {
        const normalized = visit(child, level + 1);
        return normalized ? [normalized] : [];
      });
    }
    return node;
  };
  const root = visit(candidate, 0);
  if (!root) throw new Error("The LLM returned a mind map without a root topic");
  const title = textValue(document, ["title", "name"]).slice(0, 180) || root.label;
  return { version: 1, title, root };
}

function markdownOutline(document: MindMapDocument) {
  const lines = [`# ${document.title}`, ""];
  const visit = (node: MindMapNode, level: number) => {
    const indent = "  ".repeat(Math.max(0, level - 1));
    if (level === 0) {
      if (node.note) lines.push(node.note, "");
    } else {
      lines.push(`${indent}- **${node.label.replaceAll("*", "\\*")}**${node.note ? ` — ${node.note}` : ""}`);
    }
    node.children.forEach((child) => visit(child, level + 1));
  };
  visit(document.root, 0);
  return `${lines.join("\n").trim()}\n`;
}

function imageMime(name: string, declared: string) {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(declared)) return declared;
  const extension = path.extname(name).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
}

export async function processMindMap(job: JobManifest, run: WorkflowRun, signal?: AbortSignal): Promise<WorkflowExecutionResult> {
  const settings = await readSettings();
  const endpoint = settings.endpoints.llm;
  if (!endpoint.enabled || !endpoint.baseUrl || !endpoint.model) throw new Error("Configure and enable the LLM service in Settings first");
  const artifacts = run.inputArtifactIds.map((id) => job.artifacts.find((artifact) => artifact.id === id)).filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
  if (!artifacts.length) throw new Error("Choose a topic or result for the mind map");
  const depth = boundedInteger(run.params.depth, 4, 2, 6);
  const breadth = boundedInteger(run.params.breadth, 5, 2, 8);
  const instructions = typeof run.params.instructions === "string" ? run.params.instructions.trim().slice(0, 4000) : "";
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{
    type: "text",
    text: `Create a clear mind map from the supplied material. Use at most ${depth} levels including the root and at most ${breadth} children per node.${instructions ? ` Focus: ${instructions}` : ""}`,
  }];
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
      if (totalText > 500_000) throw new Error("Mind map input is limited to 500,000 characters");
      content.push({ type: "text", text: `\n\n## ${artifact.name}\n\n${text}` });
    }
  }
  const system = `You create useful, factual mind maps. Return one JSON object only, with no Markdown or commentary. Use this exact shape: {"title":"Map title","root":{"label":"Root topic","note":"Optional short context","children":[{"label":"Branch","note":"Optional useful detail","children":[]}]}}. Keep labels concise, put supporting context in notes, remove repetition, preserve the source language, and never exceed the requested depth or breadth.`;
  await report(job.id, { status: "processing", progress: 15, stage: "Structuring mind map", startedAt: run.startedAt || new Date().toISOString() });
  let response = await chatCompletion(endpoint, [{ role: "system", content: system }, { role: "user", content }], {
    temperature: 0.15,
    maxTokens: boundedInteger(run.params.maxTokens, 8192, 1024, 32768),
    extraBody: { response_format: { type: "json_object" } },
  }, signal);
  let raw: Record<string, unknown>;
  try {
    raw = jsonObject(response);
  } catch {
    await report(job.id, { status: "processing", progress: 76, stage: "Repairing mind map structure" });
    response = await chatCompletion(endpoint, [
      { role: "system", content: system },
      { role: "user", content: `Repair this response into the required JSON object. Preserve its useful content and return JSON only:\n\n${response.slice(0, 40_000)}` },
    ], { temperature: 0, maxTokens: 8192, extraBody: { response_format: { type: "json_object" } } }, signal);
    raw = jsonObject(response);
  }
  const normalized = normalizeMindMap(raw, { depth, breadth });
  const document: MindMapDocument = { ...normalized, generatedAt: new Date().toISOString() };
  await report(job.id, { status: "merging", progress: 94, stage: "Saving interactive mind map" });
  const mapName = job.outputFiles.includes("mindmap.json") ? `mindmap-${run.id.replace(/^run-/, "").slice(0, 8)}.json` : "mindmap.json";
  const outlineName = job.outputFiles.includes("mindmap-outline.md") ? `mindmap-outline-${run.id.replace(/^run-/, "").slice(0, 8)}.md` : "mindmap-outline.md";
  await Promise.all([
    fs.writeFile(safeOutputPath(job.id, mapName), `${JSON.stringify(document, null, 2)}\n`, "utf8"),
    fs.writeFile(safeOutputPath(job.id, outlineName), markdownOutline(document), "utf8"),
  ]);
  return { outputFiles: [...new Set([...job.outputFiles, mapName, outlineName])], warnings: [] };
}
