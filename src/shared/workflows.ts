import {
  ARTIFACT_KINDS,
  WORKFLOW_SERVICE_IDS,
  type ArtifactKind,
  type ModelInputCapability,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowServiceId,
  type WorkflowValidationIssue,
  type WorkflowValidationResult,
} from "./contracts.js";
import { acceptedArtifactKinds, getModuleContract } from "./module-router.js";

export const WORKFLOW_LIMITS = { nodes: 50, edges: 100 } as const;
export const TEXT_ARTIFACT_KINDS: ArtifactKind[] = ["document", "transcript", "translation", "redacted-document", "text"];
export const IMAGE_ARTIFACT_KINDS: ArtifactKind[] = ["source-image", "generated-image", "grounded-image"];

function savedFileKind(fileName: unknown): ArtifactKind {
  const lower = typeof fileName === "string" ? fileName.trim().toLowerCase() : "";
  if (/\.(?:png|jpe?g|webp|gif|avif)$/.test(lower)) return "generated-image";
  if (/\.(?:srt|vtt)$/.test(lower)) return "subtitle";
  if (lower.endsWith(".json")) return "structured-data";
  return "document";
}

export interface WorkflowServiceContract {
  id: WorkflowServiceId;
  title: string;
  accepts: ArtifactKind[];
  produces: ArtifactKind[];
  terminal?: boolean;
}

export function workflowServiceContracts(modelInputs: readonly ModelInputCapability[] = ["text"]): WorkflowServiceContract[] {
  const moduleContracts = WORKFLOW_SERVICE_IDS.filter((id) => !["llm-prompt", "chat"].includes(id)).map((id) => {
    const contract = getModuleContract(id as Exclude<WorkflowServiceId, "llm-prompt">);
    if (!contract) throw new Error(`Module contract ${id} is missing`);
    return { id, title: contract.title, accepts: acceptedArtifactKinds(contract, modelInputs), produces: [...contract.produces] };
  });
  const llmAccepts = [...TEXT_ARTIFACT_KINDS, "annotations", "structured-data"] as ArtifactKind[];
  if (modelInputs.includes("image")) llmAccepts.push(...IMAGE_ARTIFACT_KINDS);
  return [
    ...moduleContracts,
    { id: "llm-prompt", title: "LLM prompt", accepts: [...new Set(llmAccepts)], produces: ["document"] },
    { id: "chat", title: "Create chat", accepts: [...new Set(llmAccepts)], produces: [], terminal: true },
  ];
}

export function workflowServiceContract(serviceId: unknown, modelInputs?: readonly ModelInputCapability[]) {
  return workflowServiceContracts(modelInputs).find((contract) => contract.id === serviceId);
}

export function nodeTitle(node: WorkflowNode) {
  if (node.type === "module") return workflowServiceContract(node.config.moduleId)?.title || "Service";
  return ({ input: "Input", select: "Select files", if: "If", switch: "Switch", merge: "Merge", save: "Save to file", end: "End", fail: "Fail" } as const)[node.type];
}

function artifactKinds(value: unknown): ArtifactKind[] {
  return Array.isArray(value) ? [...new Set(value.filter((kind): kind is ArtifactKind => typeof kind === "string" && (ARTIFACT_KINDS as readonly string[]).includes(kind)))] : [];
}

export function workflowInputKinds(definition: WorkflowDefinition): ArtifactKind[] {
  return artifactKinds(definition.nodes.find((node) => node.type === "input")?.config.accepts);
}

export function workflowAcceptsArtifact(definition: WorkflowDefinition, kind: ArtifactKind) {
  return workflowInputKinds(definition).includes(kind);
}

export function declaredNodeInputKinds(node: WorkflowNode, definition: WorkflowDefinition, modelInputs?: readonly ModelInputCapability[]): ArtifactKind[] {
  if (node.type === "input") return [];
  if (node.type === "module") return workflowServiceContract(node.config.moduleId, modelInputs)?.accepts || [];
  if (node.type === "select") return artifactKinds(node.config.kinds).length ? artifactKinds(node.config.kinds) : [...ARTIFACT_KINDS];
  const incoming = definition.edges.filter((edge) => edge.to.nodeId === node.id).flatMap((edge) => edge.artifactKinds);
  return incoming.length ? [...new Set(incoming)] : [...ARTIFACT_KINDS];
}

export function declaredNodeOutputKinds(node: WorkflowNode, definition: WorkflowDefinition, modelInputs?: readonly ModelInputCapability[]): ArtifactKind[] {
  if (node.type === "input") return workflowInputKinds(definition);
  if (node.type === "module") return workflowServiceContract(node.config.moduleId, modelInputs)?.produces || [];
  if (node.type === "select") return artifactKinds(node.config.kinds);
  if (node.type === "save") {
    if (node.config.mode === "text") return [savedFileKind(node.config.fileName)];
    return declaredNodeInputKinds(node, definition, modelInputs);
  }
  if (node.type === "end" || node.type === "fail") return [];
  return declaredNodeInputKinds(node, definition, modelInputs);
}

export function nodeInputPorts(node: WorkflowNode) {
  return node.type === "input" ? [] : ["input"];
}

export function nodeOutputPorts(node: WorkflowNode): string[] {
  if (node.type === "end" || node.type === "fail") return [];
  if (node.type === "if") return ["true", "false"];
  if (node.type === "switch") {
    const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
    return [...cases.map((candidate, index) => typeof candidate === "object" && candidate && "id" in candidate && typeof candidate.id === "string" ? candidate.id : `case-${index + 1}`), "default"];
  }
  return [node.type === "input" ? "files" : "output"];
}

export function compatibleArtifactKinds(source: WorkflowNode, destination: WorkflowNode, definition: WorkflowDefinition, modelInputs?: readonly ModelInputCapability[]) {
  const accepts = new Set(declaredNodeInputKinds(destination, definition, modelInputs));
  return declaredNodeOutputKinds(source, definition, modelInputs).filter((kind) => accepts.has(kind));
}

function issue(issues: WorkflowValidationIssue[], code: string, message: string, target: { nodeId?: string; edgeId?: string } = {}) {
  issues.push({ level: "error", code, message, ...target });
}

function hasCycle(definition: WorkflowDefinition) {
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) outgoing.set(edge.from.nodeId, [...(outgoing.get(edge.from.nodeId) || []), edge.to.nodeId]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((outgoing.get(id) || []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return definition.nodes.some((node) => visit(node.id));
}

export function validateWorkflowDefinition(definition: WorkflowDefinition, modelInputs: readonly ModelInputCapability[] = ["text"]): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (definition.schemaVersion !== 1) issue(issues, "schema-version", "Only workflow schema version 1 is supported");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(definition.id)) issue(issues, "workflow-id", "Use a lowercase workflow ID with letters, numbers, and hyphens");
  if (!definition.name.trim()) issue(issues, "workflow-name", "Give this workflow a name");
  if (definition.nodes.length > WORKFLOW_LIMITS.nodes) issue(issues, "node-limit", `A workflow can contain at most ${WORKFLOW_LIMITS.nodes} nodes`);
  if (definition.edges.length > WORKFLOW_LIMITS.edges) issue(issues, "edge-limit", `A workflow can contain at most ${WORKFLOW_LIMITS.edges} connections`);

  for (const node of definition.nodes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(node.id)) issue(issues, "node-id", "Node IDs may contain letters, numbers, dashes, and underscores", { nodeId: node.id });
    if (nodeIds.has(node.id)) issue(issues, "duplicate-node", "Node IDs must be unique", { nodeId: node.id });
    nodeIds.add(node.id);
    if (node.type === "input" && !artifactKinds(node.config.accepts).length) issue(issues, "input-kinds", "Choose at least one accepted input type", { nodeId: node.id });
    if (node.type === "module" && !workflowServiceContract(node.config.moduleId, modelInputs)) issue(issues, "module-id", "Choose an available service", { nodeId: node.id });
    if (node.type === "select" && !artifactKinds(node.config.kinds).length) issue(issues, "select-kinds", "Select at least one artifact type", { nodeId: node.id });
    if (node.type === "switch") {
      const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
      if (!cases.length) issue(issues, "switch-cases", "Add at least one Switch case", { nodeId: node.id });
      const caseIds = new Set<string>();
      for (const [index, candidate] of cases.entries()) {
        const record = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
        const id = typeof record.id === "string" ? record.id : "";
        if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) issue(issues, "switch-case-id", `Switch case ${index + 1} needs a valid ID`, { nodeId: node.id });
        if (caseIds.has(id)) issue(issues, "switch-case-duplicate", "Switch case IDs must be unique", { nodeId: node.id });
        caseIds.add(id);
        if (!record.predicate || typeof record.predicate !== "object") issue(issues, "switch-predicate", `Switch case ${index + 1} needs a condition`, { nodeId: node.id });
      }
    }
    if (node.type === "if" && (!node.config.predicate || typeof node.config.predicate !== "object")) issue(issues, "if-predicate", "Configure the If condition", { nodeId: node.id });
    if (node.type === "save") {
      if (!["input", "text"].includes(String(node.config.mode || "input"))) issue(issues, "save-mode", "Choose incoming content or defined text", { nodeId: node.id });
      if (node.config.mode === "text" && typeof node.config.text !== "string") issue(issues, "save-text", "Add the text to save", { nodeId: node.id });
    }
  }

  const inputs = definition.nodes.filter((node) => node.type === "input");
  const terminals = definition.nodes.filter((node) => node.type === "save" || node.type === "end" || node.type === "fail" || (node.type === "module" && node.config.moduleId === "chat"));
  if (inputs.length !== 1) issue(issues, "input-count", "A workflow must contain exactly one Input node");
  if (!terminals.length) issue(issues, "terminal-count", "Add at least one Save to file, End, Fail, or Create chat node");

  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) issue(issues, "duplicate-edge", "Connection IDs must be unique", { edgeId: edge.id });
    edgeIds.add(edge.id);
    const source = definition.nodes.find((node) => node.id === edge.from.nodeId);
    const destination = definition.nodes.find((node) => node.id === edge.to.nodeId);
    if (!source || !destination) {
      issue(issues, "missing-node", "This connection references a missing node", { edgeId: edge.id });
      continue;
    }
    if (!nodeOutputPorts(source).includes(edge.from.portId)) issue(issues, "source-port", "Choose a valid source port", { edgeId: edge.id, nodeId: source.id });
    if (!nodeInputPorts(destination).includes(edge.to.portId)) issue(issues, "target-port", "Choose a valid target port", { edgeId: edge.id, nodeId: destination.id });
    const compatible = compatibleArtifactKinds(source, destination, definition, modelInputs);
    if (!edge.artifactKinds.length || edge.artifactKinds.some((kind) => !compatible.includes(kind))) issue(issues, "artifact-kinds", "This connection carries an incompatible artifact type", { edgeId: edge.id });
  }

  if (hasCycle(definition)) issue(issues, "cycle", "Workflow v1 does not support loops");
  if (inputs.length === 1) {
    const reachable = new Set([inputs[0].id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of definition.edges) if (reachable.has(edge.from.nodeId) && !reachable.has(edge.to.nodeId)) { reachable.add(edge.to.nodeId); changed = true; }
    }
    for (const node of definition.nodes) if (!reachable.has(node.id)) issue(issues, "unreachable", `${nodeTitle(node)} is not connected to Input`, { nodeId: node.id });
  }
  for (const node of definition.nodes) {
    if (node.type !== "input" && !definition.edges.some((edge) => edge.to.nodeId === node.id)) issue(issues, "missing-input", `${nodeTitle(node)} has no incoming connection`, { nodeId: node.id });
    if (!terminals.includes(node) && !definition.edges.some((edge) => edge.from.nodeId === node.id)) issue(issues, "missing-output", `${nodeTitle(node)} has no outgoing connection`, { nodeId: node.id });
    if (node.type === "if") for (const port of ["true", "false"]) if (!definition.edges.some((edge) => edge.from.nodeId === node.id && edge.from.portId === port)) issue(issues, "branch-output", `Connect the ${port} branch`, { nodeId: node.id });
    if (node.type === "switch") for (const port of nodeOutputPorts(node)) if (!definition.edges.some((edge) => edge.from.nodeId === node.id && edge.from.portId === port)) issue(issues, "branch-output", `Connect the ${port} branch`, { nodeId: node.id });
  }
  return { valid: !issues.some((candidate) => candidate.level === "error"), issues };
}

export function createStarterWorkflow(now = new Date().toISOString()): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "new-workflow",
    revision: 1,
    name: "New workflow",
    description: "",
    enabled: false,
    nodes: [
      { id: "input", type: "input", position: { x: 30, y: 180 }, config: { accepts: ["source-image", "source-pdf"], multiple: true, maximumFiles: 20 } },
      { id: "ocr", type: "module", position: { x: 260, y: 180 }, config: { moduleId: "ocr", workflowId: "auto", params: {}, storeResult: true } },
      { id: "end", type: "end", position: { x: 490, y: 180 }, config: { result: "incoming-artifacts" } },
    ],
    edges: [
      { id: "input-ocr", from: { nodeId: "input", portId: "files" }, to: { nodeId: "ocr", portId: "input" }, artifactKinds: ["source-image", "source-pdf"] },
      { id: "ocr-end", from: { nodeId: "ocr", portId: "output" }, to: { nodeId: "end", portId: "input" }, artifactKinds: ["document", "structured-data"] },
    ],
    ui: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: now,
    updatedAt: now,
  };
}

export function edgeArtifactKinds(edge: WorkflowEdge, artifacts: Array<{ id: string; kind: ArtifactKind }>, ids: string[]) {
  const allowed = new Set(edge.artifactKinds);
  return ids.filter((id) => {
    const artifact = artifacts.find((candidate) => candidate.id === id);
    return Boolean(artifact && allowed.has(artifact.kind));
  });
}
