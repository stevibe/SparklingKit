import type { Chat, EndpointConfig, EndpointHealth, EndpointKind, FlowRun, Health, Job, ModuleDescriptor, ModuleId, PromptPreset, SearchResponse, SearchScope, Settings, SparkStatus, WorkflowDefinition, WorkflowRun, WorkflowValidationResult } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function encodedPath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

export const api = {
  health: () => request<Health>("/api/health"),
  systemStatus: () => request<SparkStatus | undefined>("/api/system/status"),
  testEndpoint: (kind: EndpointKind, endpoint: EndpointConfig) =>
    request<EndpointHealth>(`/api/health/${kind}`, { method: "POST", body: JSON.stringify({ endpoint }) }),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) => request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  modules: () => request<ModuleDescriptor[]>("/api/modules"),
  workflowNodes: () => request<{ services: Array<{ id: string; title: string; accepts: string[]; produces: string[]; terminal?: boolean; configured: boolean }>; artifactKinds: string[] }>("/api/workflow-nodes"),
  workflows: () => request<WorkflowDefinition[]>("/api/workflows"),
  workflow: (id: string) => request<WorkflowDefinition>(`/api/workflows/${id}`),
  createWorkflow: (definition: WorkflowDefinition) => request<{ definition: WorkflowDefinition; validation: WorkflowValidationResult }>("/api/workflows", { method: "POST", body: JSON.stringify(definition) }),
  saveWorkflow: (definition: WorkflowDefinition) => request<{ definition: WorkflowDefinition; validation: WorkflowValidationResult }>(`/api/workflows/${definition.id}`, { method: "PUT", body: JSON.stringify(definition) }),
  validateWorkflow: (definition: WorkflowDefinition) => request<WorkflowValidationResult>(`/api/workflows/${definition.id}/validate`, { method: "POST", body: JSON.stringify(definition) }),
  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${id}`, { method: "DELETE" }),
  workflowRuns: () => request<FlowRun[]>("/api/workflow-runs"),
  jobWorkflowRuns: (jobId: string) => request<FlowRun[]>(`/api/jobs/${jobId}/flows`),
  workflowRun: (jobId: string, flowRunId: string) => request<FlowRun>(`/api/jobs/${jobId}/flows/${flowRunId}`),
  cancelWorkflowRun: (jobId: string, flowRunId: string) => request<FlowRun>(`/api/jobs/${jobId}/flows/${flowRunId}/cancel`, { method: "POST" }),
  retryWorkflowRun: (jobId: string, flowRunId: string) => request<FlowRun>(`/api/jobs/${jobId}/flows/${flowRunId}/retry`, { method: "POST" }),
  search: (query: string, scope: SearchScope = "all", moduleId?: ModuleId, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q: query, scope });
    if (moduleId) params.set("moduleId", moduleId);
    return request<SearchResponse>(`/api/search?${params}`, { signal });
  },
  previewTranslation: (text: string, sourceLanguage: string, targetLanguage: string, signal?: AbortSignal) => request<{ text: string; truncated: boolean }>("/api/modules/translation/preview", { method: "POST", body: JSON.stringify({ text, sourceLanguage, targetLanguage }), signal }),
  createTextTranslationJob: (text: string, sourceLanguage: string, targetLanguage: string) => request<Job>("/api/modules/translation/text", { method: "POST", body: JSON.stringify({ text, sourceLanguage, targetLanguage }) }),
  createImageJob: (prompt: string, size: string) => request<Job>("/api/modules/text-to-image/jobs", { method: "POST", body: JSON.stringify({ prompt, size }) }),
  createMindMapJob: (subject: string, options: { instructions?: string; depth: number; breadth: number }) => request<Job>("/api/modules/mindmap/jobs", { method: "POST", body: JSON.stringify({ subject, ...options }) }),
  jobs: () => request<{ jobs: Job[]; total: number }>("/api/jobs"),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  startRun: (id: string, input: { moduleId: ModuleId; workflowId: string; inputArtifactIds: string[]; params: Record<string, unknown> }) => request<{ job: Job; run: WorkflowRun }>(`/api/jobs/${id}/runs`, { method: "POST", body: JSON.stringify(input) }),
  renameJob: (id: string, title: string) => request<Job>(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteJob: (id: string) => request<void>(`/api/jobs/${id}`, { method: "DELETE" }),
  renameOutputFile: (id: string, file: string, name: string) => request<{ job: Job; file: string }>(`/api/jobs/${id}/files/${encodedPath(file)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteOutputFile: (id: string, file: string) => request<Job>(`/api/jobs/${id}/files/${encodedPath(file)}`, { method: "DELETE" }),
  renameInputFile: (id: string, file: string, name: string) => request<Job>(`/api/jobs/${id}/input/${encodeURIComponent(file)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteInputFile: (id: string, file: string) => request<Job>(`/api/jobs/${id}/input/${encodeURIComponent(file)}`, { method: "DELETE" }),
  cancelJob: (id: string) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  runPreset: (id: string, slug: string) => request<Job>(`/api/jobs/${id}/presets/${slug}`, { method: "POST" }),
  prompts: () => request<PromptPreset[]>("/api/prompts"),
  savePrompt: (prompt: PromptPreset) => request<PromptPreset>(`/api/prompts/${prompt.slug}`, { method: "PUT", body: JSON.stringify(prompt) }),
  chats: () => request<Chat[]>("/api/chats"),
  chat: (id: string) => request<Chat>(`/api/chats/${id}`),
  renameChat: (id: string, title: string) => request<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => request<void>(`/api/chats/${id}`, { method: "DELETE" }),
  createChat: (linkedJobId?: string) => request<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ linkedJobId }) }),
};

export function startWorkflow(id: string, input: { files?: File[]; text?: string; title?: string; jobId?: string; inputArtifactIds?: string[]; variables?: Record<string, unknown> }, onProgress: (value: number) => void) {
  return new Promise<{ job: Job; flow: FlowRun }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    input.files?.forEach((file) => form.append("files", file));
    if (input.text) form.append("text", input.text);
    if (input.title) form.append("title", input.title);
    if (input.jobId) form.append("jobId", input.jobId);
    if (input.inputArtifactIds) form.append("inputArtifactIds", JSON.stringify(input.inputArtifactIds));
    form.append("variables", JSON.stringify(input.variables || {}));
    xhr.open("POST", `/api/workflows/${encodeURIComponent(id)}/runs`);
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () => {
      const payload = JSON.parse(xhr.responseText || "{}") as { job: Job; flow: FlowRun; error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || `Could not start workflow (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Could not start workflow: network error"));
    xhr.send(form);
  });
}

export function uploadJob(files: File[], type: Job["type"], onProgress: (value: number) => void, moduleId?: ModuleId) {
  return new Promise<Job>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    files.forEach((file) => form.append("files", file));
    form.append("type", type);
    if (moduleId) form.append("moduleId", moduleId);
    xhr.open("POST", "/api/jobs");
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () => {
      const payload = JSON.parse(xhr.responseText || "{}") as Job & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(form);
  });
}

export function uploadTranslationJob(file: File, sourceLanguage: string, targetLanguage: string, onProgress: (value: number) => void) {
  return new Promise<Job>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("files", file);
    form.append("sourceLanguage", sourceLanguage);
    form.append("targetLanguage", targetLanguage);
    xhr.open("POST", "/api/modules/translation/files");
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () => {
      const payload = JSON.parse(xhr.responseText || "{}") as Job & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(form);
  });
}

export function uploadGroundingJob(file: File, queries: string[], onProgress: (value: number) => void) {
  return new Promise<Job>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("files", file);
    form.append("queries", JSON.stringify(queries));
    xhr.open("POST", "/api/modules/grounding/jobs");
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () => {
      const payload = JSON.parse(xhr.responseText || "{}") as Job & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(form);
  });
}

export async function streamChat(
  chatId: string,
  content: string,
  handlers: { onDelta: (delta: string) => void; onDone: () => void; onError: (message: string) => void },
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Chat request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find((entry) => entry.startsWith("data:"));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim()) as { delta?: string; done?: boolean; error?: string };
      if (payload.delta) handlers.onDelta(payload.delta);
      if (payload.error) handlers.onError(payload.error);
      if (payload.done) handlers.onDone();
    }
    if (done) break;
  }
}
