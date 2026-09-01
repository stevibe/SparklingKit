import type { Artifact, ArtifactKind, FlowNodeRun, FlowRun, ModuleId, WorkflowNode } from "../../shared/contracts.js";
import { moduleWorkflowForArtifact } from "../../shared/module-router.js";
import { edgeArtifactKinds, nodeTitle, validateWorkflowDefinition, workflowServiceContract } from "../../shared/workflows.js";
import { publishJob } from "../events.js";
import { processRun } from "../processor.js";
import { createChat, createWorkflowRun, readJob, readSettings, updateJob, writeChat } from "../store.js";
import { readFlowRun, updateFlowRun } from "./store.js";

const terminalNodeStates = new Set(["succeeded", "failed", "skipped", "cancelled"]);

function unique(values: string[]) {
  return [...new Set(values)];
}

function isAbort(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted || (error && typeof error === "object" && "name" in error && error.name === "AbortError"));
}

async function patchNode(flow: FlowRun, nodeId: string, patch: Partial<FlowNodeRun>) {
  return updateFlowRun(flow.jobId, flow.id, (current) => {
    current.nodes[nodeId] = { ...current.nodes[nodeId], ...patch, nodeId };
    const finished = Object.values(current.nodes).filter((node) => terminalNodeStates.has(node.status)).length;
    current.progress = Math.min(99, Math.round((finished / Math.max(1, Object.keys(current.nodes).length)) * 100));
    return current;
  });
}

function incomingArtifacts(flow: FlowRun, node: WorkflowNode, artifacts: Artifact[]) {
  const edges = flow.definition.edges.filter((edge) => edge.to.nodeId === node.id);
  const ids = edges.flatMap((edge) => {
    const source = flow.nodes[edge.from.nodeId];
    if (source?.status !== "succeeded" || !source.selectedPortIds.includes(edge.from.portId)) return [];
    return edgeArtifactKinds(edge, artifacts, source.outputArtifactIds);
  });
  return unique(ids);
}

function factValue(fact: string, artifacts: Artifact[], flow: FlowRun): unknown {
  const first = artifacts[0];
  if (fact === "artifact.kind") return first?.kind;
  if (fact === "artifact.mimeType") return first?.mimeType;
  if (fact === "artifact.role") return first?.role;
  if (fact === "input.fileCount") return artifacts.length;
  if (fact.startsWith("artifact.metadata.")) {
    return fact.slice("artifact.metadata.".length).split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, first?.metadata);
  }
  if (fact.startsWith("variable.")) return flow.variables[fact.slice("variable.".length)];
  return undefined;
}

function compare(actual: unknown, operator: string, expected: unknown) {
  if (operator === "equal") return actual === expected;
  if (operator === "notEqual") return actual !== expected;
  if (operator === "exists") return actual !== undefined && actual !== null;
  if (operator === "in") return Array.isArray(expected) && expected.includes(actual);
  if (operator === "notIn") return Array.isArray(expected) && !expected.includes(actual);
  if (operator === "contains") return (typeof actual === "string" && actual.includes(String(expected))) || (Array.isArray(actual) && actual.includes(expected));
  if (operator === "startsWith") return typeof actual === "string" && actual.startsWith(String(expected));
  if (operator === "greaterThan") return Number(actual) > Number(expected);
  if (operator === "greaterThanOrEqual") return Number(actual) >= Number(expected);
  if (operator === "lessThan") return Number(actual) < Number(expected);
  if (operator === "lessThanOrEqual") return Number(actual) <= Number(expected);
  return false;
}

function evaluatePredicate(predicate: unknown, artifacts: Artifact[], flow: FlowRun): boolean {
  if (!predicate || typeof predicate !== "object") return false;
  const record = predicate as Record<string, unknown>;
  if (Array.isArray(record.all)) return record.all.every((item) => evaluatePredicate(item, artifacts, flow));
  if (Array.isArray(record.any)) return record.any.some((item) => evaluatePredicate(item, artifacts, flow));
  if (typeof record.fact !== "string" || typeof record.operator !== "string") return false;
  return compare(factValue(record.fact, artifacts, flow), record.operator, record.value);
}

function moduleGroups(node: WorkflowNode, artifacts: Artifact[]): Array<{ moduleId: ModuleId | "text-transform"; workflowId: string; artifacts: Artifact[] }> {
  const serviceId = String(node.config.moduleId || "");
  if (serviceId === "llm-prompt") return [{ moduleId: "text-transform" as const, workflowId: "llm.prompt", artifacts }];
  const contract = workflowServiceContract(serviceId);
  if (!contract || serviceId === "chat") return [];
  const configuredWorkflow = typeof node.config.workflowId === "string" ? node.config.workflowId : "auto";
  const grouped = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const workflowId = configuredWorkflow === "auto" ? moduleWorkflowForArtifact(serviceId as ModuleId, artifact.kind) : configuredWorkflow;
    if (!workflowId) throw new Error(`${contract.title} cannot accept ${artifact.kind}`);
    grouped.set(workflowId, [...(grouped.get(workflowId) || []), artifact]);
  }
  return [...grouped].flatMap(([workflowId, inputs]) => {
    const maximum = serviceId === "translation" || serviceId === "grounding" || serviceId === "text-to-image" ? 1 : 100;
    const batches: Artifact[][] = [];
    for (let index = 0; index < inputs.length; index += maximum) batches.push(inputs.slice(index, index + maximum));
    return batches.map((batch) => ({ moduleId: serviceId as ModuleId, workflowId, artifacts: batch }));
  });
}

async function executeModule(flow: FlowRun, node: WorkflowNode, inputIds: string[], signal?: AbortSignal) {
  const job = await readJob(flow.jobId);
  const artifacts = inputIds.map((id) => job.artifacts.find((artifact) => artifact.id === id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  const serviceId = String(node.config.moduleId || "");
  if (serviceId === "chat") {
    const chat = await createChat(job.id);
    chat.linkedArtifactIds = inputIds;
    await writeChat(chat);
    await updateFlowRun(flow.jobId, flow.id, { chatId: chat.id });
    return { outputArtifactIds: inputIds, childRunIds: [], detail: `Created ${chat.title}` };
  }
  const groups = moduleGroups(node, artifacts);
  if (!groups.length) throw new Error("This service node has no compatible input");
  const outputArtifactIds: string[] = [];
  const childRunIds: string[] = [];
  for (const group of groups) {
    if (signal?.aborted) throw new DOMException("Workflow cancelled", "AbortError");
    const baseParams = node.config.params && typeof node.config.params === "object" ? node.config.params as Record<string, unknown> : {};
    const params = { ...baseParams, ...(group.artifacts.length === 1 ? { artifactId: group.artifacts[0].id } : {}) };
    const created = await createWorkflowRun(flow.jobId, group.moduleId, group.workflowId, params, group.artifacts.map((artifact) => artifact.id));
    childRunIds.push(created.run.id);
    await processRun(flow.jobId, created.run.id, signal);
    const completed = await readJob(flow.jobId);
    const child = completed.runs.find((run) => run.id === created.run.id);
    if (!child || child.status === "failed") throw new Error(child?.error || `${nodeTitle(node)} failed`);
    if (child.status === "cancelled") throw new DOMException("Workflow cancelled", "AbortError");
    outputArtifactIds.push(...child.outputArtifactIds);
  }
  return { outputArtifactIds: unique(outputArtifactIds), childRunIds, detail: `${groups.length} service run${groups.length === 1 ? "" : "s"}` };
}

async function executeNode(flow: FlowRun, node: WorkflowNode, inputIds: string[], signal?: AbortSignal) {
  const job = await readJob(flow.jobId);
  const artifacts = inputIds.map((id) => job.artifacts.find((artifact) => artifact.id === id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  if (node.type === "module") {
    const result = await executeModule(flow, node, inputIds, signal);
    return { ...result, selectedPortIds: ["output"] };
  }
  if (node.type === "select") {
    const kinds = new Set(Array.isArray(node.config.kinds) ? node.config.kinds.filter((kind): kind is ArtifactKind => typeof kind === "string") : []);
    return { outputArtifactIds: artifacts.filter((artifact) => kinds.has(artifact.kind)).map((artifact) => artifact.id), childRunIds: [], selectedPortIds: ["output"], detail: `${artifacts.filter((artifact) => kinds.has(artifact.kind)).length} selected` };
  }
  if (node.type === "if") {
    const selected = evaluatePredicate(node.config.predicate, artifacts, flow) ? "true" : "false";
    return { outputArtifactIds: inputIds, childRunIds: [], selectedPortIds: [selected], detail: `Continued through ${selected}` };
  }
  if (node.type === "switch") {
    const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
    const match = cases.find((candidate) => candidate && typeof candidate === "object" && evaluatePredicate((candidate as Record<string, unknown>).predicate, artifacts, flow)) as Record<string, unknown> | undefined;
    const selected = typeof match?.id === "string" ? match.id : "default";
    return { outputArtifactIds: inputIds, childRunIds: [], selectedPortIds: [selected], detail: `Continued through ${selected}` };
  }
  if (node.type === "fail") throw new Error(typeof node.config.message === "string" ? node.config.message : "Workflow stopped at a Fail node");
  return { outputArtifactIds: inputIds, childRunIds: [], selectedPortIds: node.type === "end" ? [] : ["output"], detail: node.type === "end" ? "Result collected" : `${inputIds.length} artifact${inputIds.length === 1 ? "" : "s"}` };
}

function nextReadyNode(flow: FlowRun) {
  for (const node of flow.definition.nodes) {
    const state = flow.nodes[node.id];
    if (!state || state.status !== "pending") continue;
    const incoming = flow.definition.edges.filter((edge) => edge.to.nodeId === node.id);
    const parents = incoming.map((edge) => flow.nodes[edge.from.nodeId]).filter(Boolean);
    const active = incoming.some((edge) => flow.nodes[edge.from.nodeId]?.status === "succeeded" && flow.nodes[edge.from.nodeId].selectedPortIds.includes(edge.from.portId));
    const waitForAll = node.type !== "merge" || node.config.mode !== "any";
    if (active && (!waitForAll || parents.every((parent) => terminalNodeStates.has(parent.status)))) return node;
  }
  return undefined;
}

async function skipInactiveNodes(flow: FlowRun) {
  let current = flow;
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of current.definition.nodes) {
      const state = current.nodes[node.id];
      if (!state || state.status !== "pending") continue;
      const incoming = current.definition.edges.filter((edge) => edge.to.nodeId === node.id);
      if (!incoming.length) continue;
      const parents = incoming.map((edge) => current.nodes[edge.from.nodeId]).filter(Boolean);
      if (!parents.every((parent) => terminalNodeStates.has(parent.status))) continue;
      const active = incoming.some((edge) => current.nodes[edge.from.nodeId]?.status === "succeeded" && current.nodes[edge.from.nodeId].selectedPortIds.includes(edge.from.portId));
      if (!active) {
        current = await patchNode(current, node.id, { status: "skipped", completedAt: new Date().toISOString(), detail: "Branch not selected" });
        changed = true;
      }
    }
  }
  return current;
}

export async function processFlowRun(jobId: string, flowRunId: string, signal?: AbortSignal) {
  let flow = await readFlowRun(jobId, flowRunId);
  if (["succeeded", "failed", "cancelled"].includes(flow.status)) return flow;
  const settings = await readSettings();
  const validation = validateWorkflowDefinition(flow.definition, settings.endpoints.llm.capabilities || ["text"]);
  if (!validation.valid) throw new Error(validation.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join("; "));
  const now = new Date().toISOString();
  flow = await updateFlowRun(jobId, flowRunId, (current) => {
    current.status = "running";
    current.stage = "Starting workflow";
    current.startedAt ||= now;
    for (const node of Object.values(current.nodes)) if (node.status === "running") node.status = "pending";
    return current;
  });
  const startedJob = await updateJob(jobId, { status: "processing", stage: `Workflow · ${flow.definition.name}`, progress: 1, startedAt: now, cancelRequested: false, error: undefined });
  publishJob(jobId, startedJob);
  try {
    while (true) {
      flow = await readFlowRun(jobId, flowRunId);
      if (signal?.aborted || flow.cancelRequested) throw new DOMException("Workflow cancelled", "AbortError");
      flow = await skipInactiveNodes(flow);
      const next = nextReadyNode(flow);
      if (!next) break;
      const inputIds = incomingArtifacts(flow, next, (await readJob(jobId)).artifacts);
      flow = await patchNode(flow, next.id, { status: "running", attempt: flow.nodes[next.id].attempt + 1, inputArtifactIds: inputIds, startedAt: new Date().toISOString(), error: undefined });
      flow = await updateFlowRun(jobId, flowRunId, { stage: nodeTitle(next) });
      try {
        const result = await executeNode(flow, next, inputIds, signal);
        flow = await patchNode(flow, next.id, { status: "succeeded", outputArtifactIds: result.outputArtifactIds, childRunIds: unique([...flow.nodes[next.id].childRunIds, ...result.childRunIds]), selectedPortIds: result.selectedPortIds, detail: result.detail, completedAt: new Date().toISOString() });
      } catch (error) {
        flow = await patchNode(flow, next.id, { status: isAbort(error, signal) ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
        throw error;
      }
    }
    flow = await skipInactiveNodes(flow);
    const pending = Object.values(flow.nodes).filter((node) => node.status === "pending");
    if (pending.length) throw new Error(`Workflow cannot continue at ${pending.map((node) => node.nodeId).join(", ")}`);
    const failed = Object.values(flow.nodes).find((node) => node.status === "failed");
    if (failed) throw new Error(failed.error || `Workflow failed at ${failed.nodeId}`);
    const ends = flow.definition.nodes.filter((node) => node.type === "end" && flow.nodes[node.id]?.status === "succeeded");
    const outputArtifactIds = unique(ends.flatMap((node) => flow.nodes[node.id].outputArtifactIds));
    flow = await updateFlowRun(jobId, flowRunId, { status: "succeeded", progress: 100, stage: "Complete", outputArtifactIds, completedAt: new Date().toISOString(), error: undefined, cancelRequested: false });
    const completedJob = await updateJob(jobId, { status: "done", progress: 100, stage: "Workflow complete", error: undefined, cancelRequested: false, completedAt: new Date().toISOString() });
    publishJob(jobId, completedJob);
    return flow;
  } catch (error) {
    const cancelled = isAbort(error, signal) || (await readFlowRun(jobId, flowRunId)).cancelRequested;
    const message = error instanceof Error ? error.message : String(error);
    const blocked = !cancelled && /configure and enable|not configured|service first/i.test(message);
    flow = await updateFlowRun(jobId, flowRunId, {
      status: cancelled ? "cancelled" : blocked ? "blocked" : "failed",
      stage: cancelled ? "Stopped" : blocked ? "Service unavailable" : "Failed",
      error: cancelled ? undefined : message,
      completedAt: cancelled || !blocked ? new Date().toISOString() : undefined,
    });
    const failedJob = await updateJob(jobId, { status: cancelled ? "cancelled" : "failed", stage: flow.stage, error: flow.error, completedAt: new Date().toISOString() });
    publishJob(jobId, failedJob);
    if (!cancelled && !blocked) throw error;
    return flow;
  }
}
