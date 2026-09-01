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
  FlowRun,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowServiceId,
  WorkflowValidationResult,
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
  FlowRun,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowServiceId,
  WorkflowValidationResult,
};

export type Job = JobManifest;
export type Chat = ChatRecord;
export type ChatMessage = ChatRecord["messages"][number];

export interface Health {
  ok: boolean;
  version: string;
  endpoints: Record<EndpointKind, EndpointHealth>;
  redis: { ok: boolean; latencyMs: number; error?: string };
}

export interface SparkStatus {
  ok: boolean;
  generatedAt: string;
  host: {
    hostname: string;
    platform: string;
    uptimeSeconds: number;
    loadAverage: number[];
    memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number };
    swap: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number };
  };
  gpu: {
    devices: Array<{
      index: number | null;
      name: string;
      utilizationPercent: number | null;
      temperatureC: number | null;
      powerWatts: number | null;
      memory: { totalBytes: number | null; usedBytes: number | null; freeBytes: number | null };
    }>;
    processes: Array<{
      pid: number;
      processName: string;
      usedMemoryBytes: number | null;
      service: string | null;
      serviceLabel: string | null;
      port: number | null;
      model: string | null;
    }>;
    allocatedProcessMemoryBytes: number;
  };
  services: Array<{ id: string; label: string; port: number; baseUrl: string; ok: boolean; latencyMs: number; models: string[]; error?: string }>;
  gpuError?: string | null;
}
