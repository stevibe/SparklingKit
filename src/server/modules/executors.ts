import type { JobManifest, WorkflowRun } from "../models.js";

export interface WorkflowExecutionResult {
  outputFiles: string[];
  warnings: string[];
}

type WorkflowExecutor = (
  job: JobManifest,
  run: WorkflowRun,
  signal?: AbortSignal,
) => Promise<WorkflowExecutionResult | void>;

// Dynamic imports keep the execution registry independent from the processor
// implementations. A module can move into its own package without changing the
// queue or orchestration layer.
const executors: Record<string, WorkflowExecutor> = {
  "transcription.default": async (job, _run, signal) => (await import("../processor.js")).processAudio(job, signal),
  "ocr.images": async (job, _run, signal) => (await import("../processor.js")).processImages(job, signal),
  "ocr.pdf": async (job, _run, signal) => (await import("../processor.js")).processPdfs(job, signal),
  "text-transform.preset": async (job, run, signal) => {
    const slug = typeof run.params.slug === "string" ? run.params.slug : "";
    if (!slug) throw new Error("The text-transform run has no preset slug");
    await (await import("../processor.js")).processPreset(job.id, slug, signal);
  },
  "translation.default": async (job, run, signal) => (await import("./translation/executor.js")).processTranslation(job, run, signal),
  "grounding.image": async (job, run, signal) => (await import("./grounding/executor.js")).processGrounding(job, run, signal),
  "text-to-image.default": async (job, run, signal) => (await import("./text-to-image/executor.js")).processTextToImage(job, run, signal),
};

export function registerWorkflowExecutor(workflowId: string, executor: WorkflowExecutor) {
  if (executors[workflowId]) throw new Error(`Workflow executor ${workflowId} is already registered`);
  executors[workflowId] = executor;
}

export async function executeWorkflow(workflowId: string, job: JobManifest, run: WorkflowRun, signal?: AbortSignal) {
  const executor = executors[workflowId];
  if (!executor) throw new Error(`No executor is registered for workflow ${workflowId}`);
  return executor(job, run, signal);
}

export function registeredWorkflowIds() {
  return Object.keys(executors);
}
