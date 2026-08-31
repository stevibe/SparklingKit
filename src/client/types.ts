import type {
  Artifact,
  ChatRecord,
  EndpointConfig,
  EndpointHealth,
  EndpointKind,
  JobKind,
  JobManifest,
  JobStatus,
  ModuleDescriptor,
  ModuleId,
  ModelInputCapability,
  PromptPreset,
  SearchResponse,
  SearchResult,
  SearchResultType,
  SearchScope,
  Settings,
  WorkflowRun,
} from "../shared/contracts";

export type {
  Artifact,
  EndpointConfig,
  EndpointHealth,
  EndpointKind,
  JobKind,
  JobStatus,
  ModuleDescriptor,
  ModuleId,
  ModelInputCapability,
  PromptPreset,
  SearchResponse,
  SearchResult,
  SearchResultType,
  SearchScope,
  Settings,
  WorkflowRun,
};

export type Job = JobManifest;
export type Chat = ChatRecord;
export type ChatMessage = ChatRecord["messages"][number];

export interface Health {
  ok: boolean;
  endpoints: Record<EndpointKind, EndpointHealth>;
  redis: { ok: boolean; latencyMs: number; error?: string };
}
