export const MODULE_IDS = ["ocr", "transcription", "translation", "grounding", "text-to-image", "mindmap", "chat"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const ENDPOINT_KINDS = ["stt", "ocr", "llm", "translation", "grounding", "image-generation"] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

export const MODEL_INPUT_CAPABILITIES = ["text", "image"] as const;
export type ModelInputCapability = (typeof MODEL_INPUT_CAPABILITIES)[number];

export type JobKind = "audio" | "image" | "pdf" | "text";
export type JobStatus =
  | "queued"
  | "preparing"
  | "processing"
  | "merging"
  | "done"
  | "done_with_warnings"
  | "failed"
  | "cancelled";

export const ARTIFACT_KINDS = [
  "source-audio",
  "source-video",
  "source-image",
  "source-pdf",
  "document",
  "transcript",
  "subtitle",
  "translation",
  "annotations",
  "redacted-document",
  "grounded-image",
  "generated-image",
  "structured-data",
  "mindmap",
  "text",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactRole = "source" | "primary" | "supplementary";

export interface Artifact {
  id: string;
  name: string;
  path: string;
  kind: ArtifactKind;
  mimeType: string;
  role: ArtifactRole;
  createdAt: string;
  createdByRunId?: string;
  createdByStepId?: string;
  derivedFrom: string[];
  metadata: Record<string, unknown>;
}

export interface WorkflowStepRun {
  id: string;
  title: string;
  status: JobStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  moduleId: ModuleId | "text-transform";
  workflowId: string;
  status: JobStatus;
  progress: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  params: Record<string, unknown>;
  steps: WorkflowStepRun[];
  warnings: string[];
  error?: string;
  cancelRequested?: boolean;
}

export interface ModuleActionDescriptor {
  id: ModuleId;
  label: string;
  accepts: ArtifactKind[];
}

export interface ModuleDescriptor {
  id: ModuleId;
  title: string;
  shortTitle: string;
  description: string;
  icon: "scan-text" | "audio-lines" | "languages" | "scan-search" | "image" | "network" | "message-circle";
  route: string;
  providerKind: EndpointKind;
  accepts: ArtifactKind[];
  produces: ArtifactKind[];
  actions: ModuleActionDescriptor[];
  implementation: "ready" | "planned";
  configured?: boolean;
}

export interface EndpointConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  /** Declared model inputs. Currently used by the general-purpose LLM. */
  capabilities?: ModelInputCapability[];
}

export const DEPLOYMENT_MODES = ["all-in-one", "split", "custom"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export interface Settings {
  schemaVersion: 2;
  setup: { completed: boolean; mode: DeploymentMode; onboardingVersion: number; completedAt?: string };
  systemStatus: { baseUrl: string };
  endpoints: Record<EndpointKind, EndpointConfig>;
  audio: {
    chunkTargetSec: number;
    chunkOverlapSec: number;
    sampleRate: number;
    maxCompletionTokens: number;
    requestTimeoutSec: number;
    adaptiveSplit: boolean;
    minAdaptiveChunkSec: number;
  };
  pdf: {
    dpi: number;
    pagesPerBatch: number;
  };
  queue: {
    workers: number;
    maxRetriesPerChunk: number;
  };
  retention: { purgeWorkDirAfterDays: number };
  ui: { language: string; theme: "light" | "dark" | "auto"; timezone: string };
}

export interface JobInput {
  name: string;
  storedName: string;
  mimeType: string;
  size: number;
}

export interface JobManifest {
  schemaVersion: 2;
  id: string;
  /** Retained as a compatibility projection for v1 clients. */
  type: JobKind;
  moduleId: ModuleId;
  workflowId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  title: string;
  progress: number;
  stage: string;
  detail?: string;
  inputs: JobInput[];
  /** Retained as a compatibility projection of generated artifacts. */
  outputFiles: string[];
  artifacts: Artifact[];
  runs: WorkflowRun[];
  warnings: string[];
  error?: string;
  cancelRequested?: boolean;
  params: Record<string, unknown>;
}

export interface PromptPreset {
  name: string;
  slug: string;
  description: string;
  system: string;
  userTemplate: string;
  params: { temperature: number; maxTokens: number };
  chunking: { maxInputTokens: number; strategy: "single" | "map-reduce" };
}

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  temperature: number;
  linkedJobId?: string;
  linkedArtifactIds?: string[];
  messages: ChatMessage[];
}

export interface EndpointHealth {
  kind: EndpointKind;
  enabled: boolean;
  ok: boolean;
  latencyMs: number;
  model: string;
  availableModels: string[];
  error?: string;
}

export const SEARCH_SCOPES = ["all", "work", "chats", "tools"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export type SearchResultType = "job" | "artifact" | "conversation" | "module";

export interface SearchResult {
  id: string;
  type: SearchResultType;
  group: "work" | "conversations" | "tools";
  title: string;
  subtitle: string;
  url: string;
  updatedAt?: string;
  moduleId?: ModuleId;
  artifactKind?: ArtifactKind;
}

export interface SearchResponse {
  query: string;
  scope: SearchScope;
  results: SearchResult[];
  total: number;
}

export const WORKFLOW_NODE_TYPES = ["input", "module", "select", "if", "switch", "merge", "save", "end", "fail"] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
export const WORKFLOW_SERVICE_IDS = ["ocr", "transcription", "translation", "grounding", "text-to-image", "mindmap", "llm-prompt", "chat"] as const;
export type WorkflowServiceId = (typeof WORKFLOW_SERVICE_IDS)[number];

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowEdgeEndpoint {
  nodeId: string;
  portId: string;
}

export interface WorkflowEdge {
  id: string;
  from: WorkflowEdgeEndpoint;
  to: WorkflowEdgeEndpoint;
  artifactKinds: ArtifactKind[];
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  description: string;
  enabled: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  ui: { viewport: { x: number; y: number; zoom: number } };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
}

export type FlowRunStatus = "queued" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
export type FlowNodeStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped" | "blocked" | "cancelled";

export interface FlowNodeRun {
  nodeId: string;
  status: FlowNodeStatus;
  attempt: number;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  childRunIds: string[];
  selectedPortIds: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  detail?: string;
}

export interface FlowRun {
  schemaVersion: 1;
  id: string;
  workflowId: string;
  workflowRevision: number;
  jobId: string;
  status: FlowRunStatus;
  progress: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequested?: boolean;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  variables: Record<string, unknown>;
  definition: WorkflowDefinition;
  nodes: Record<string, FlowNodeRun>;
  error?: string;
  chatId?: string;
}
