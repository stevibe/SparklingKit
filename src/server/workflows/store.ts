import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../config.js";
import { assertSafeName, atomicWriteJson, jobDir } from "../store.js";
import type { FlowRun, WorkflowDefinition } from "../../shared/contracts.js";

const definitionsDir = path.join(DATA_DIR, "config", "workflows");

function definitionPath(id: string) {
  assertSafeName(id);
  return path.join(definitionsDir, `${id}.json`);
}

function flowDir(jobId: string) {
  return path.join(jobDir(jobId), "flows");
}

function flowPath(jobId: string, flowRunId: string) {
  assertSafeName(flowRunId);
  return path.join(flowDir(jobId), `${flowRunId}.json`);
}

async function optionalRead<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listWorkflowDefinitions() {
  await fs.mkdir(definitionsDir, { recursive: true });
  const entries = await fs.readdir(definitionsDir, { withFileTypes: true });
  const definitions = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => optionalRead<WorkflowDefinition>(path.join(definitionsDir, entry.name))));
  return definitions.filter((definition): definition is WorkflowDefinition => Boolean(definition)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readWorkflowDefinition(id: string) {
  const definition = await optionalRead<WorkflowDefinition>(definitionPath(id));
  if (!definition) throw Object.assign(new Error("Workflow not found"), { status: 404 });
  return definition;
}

export async function writeWorkflowDefinition(input: WorkflowDefinition, create = false) {
  const existing = await optionalRead<WorkflowDefinition>(definitionPath(input.id));
  if (create && existing) throw Object.assign(new Error("A workflow with that ID already exists"), { status: 409 });
  const now = new Date().toISOString();
  const definition: WorkflowDefinition = {
    ...structuredClone(input),
    schemaVersion: 1,
    revision: existing ? existing.revision + 1 : Math.max(1, input.revision || 1),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  await atomicWriteJson(definitionPath(definition.id), definition);
  return definition;
}

export async function deleteWorkflowDefinition(id: string) {
  const file = definitionPath(id);
  if (!(await optionalRead(file))) throw Object.assign(new Error("Workflow not found"), { status: 404 });
  await fs.unlink(file);
}

export async function createFlowRun(definition: WorkflowDefinition, jobId: string, inputArtifactIds: string[], variables: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const flow: FlowRun = {
    schemaVersion: 1,
    id: `flow-${randomUUID().slice(0, 10)}`,
    workflowId: definition.id,
    workflowRevision: definition.revision,
    jobId,
    status: "queued",
    progress: 0,
    stage: "Waiting for a worker",
    createdAt: now,
    updatedAt: now,
    inputArtifactIds,
    outputArtifactIds: [],
    variables,
    definition: structuredClone(definition),
    nodes: Object.fromEntries(definition.nodes.map((node) => [node.id, {
      nodeId: node.id,
      status: node.type === "input" ? "succeeded" : "pending",
      attempt: 0,
      inputArtifactIds: node.type === "input" ? [...inputArtifactIds] : [],
      outputArtifactIds: node.type === "input" ? [...inputArtifactIds] : [],
      childRunIds: [],
      selectedPortIds: node.type === "input" ? ["files"] : [],
      ...(node.type === "input" ? { startedAt: now, completedAt: now } : {}),
    }])),
  };
  await atomicWriteJson(flowPath(jobId, flow.id), flow);
  return flow;
}

export async function readFlowRun(jobId: string, flowRunId: string) {
  const flow = await optionalRead<FlowRun>(flowPath(jobId, flowRunId));
  if (!flow) throw Object.assign(new Error("Workflow run not found"), { status: 404 });
  return flow;
}

export async function updateFlowRun(jobId: string, flowRunId: string, update: Partial<FlowRun> | ((flow: FlowRun) => FlowRun)) {
  const current = await readFlowRun(jobId, flowRunId);
  const changed = typeof update === "function" ? update(structuredClone(current)) : { ...current, ...update };
  const next: FlowRun = { ...changed, id: current.id, jobId: current.jobId, schemaVersion: 1, updatedAt: new Date().toISOString() };
  await atomicWriteJson(flowPath(jobId, flowRunId), next);
  return next;
}

export async function listJobFlowRuns(jobId: string) {
  const folder = flowDir(jobId);
  await fs.mkdir(folder, { recursive: true });
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const flows = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => optionalRead<FlowRun>(path.join(folder, entry.name))));
  return flows.filter((flow): flow is FlowRun => Boolean(flow)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listUnfinishedFlowRuns() {
  const jobsFolder = path.join(DATA_DIR, "jobs");
  const jobs = await fs.readdir(jobsFolder, { withFileTypes: true }).catch(() => []);
  const all = await Promise.all(jobs.filter((entry) => entry.isDirectory()).map((entry) => listJobFlowRuns(entry.name).catch(() => [])));
  return all.flat().filter((flow) => ["queued", "running"].includes(flow.status));
}
