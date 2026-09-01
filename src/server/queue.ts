import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import { REDIS_URL } from "./config.js";
import { processJob, processPreset, processRun } from "./processor.js";
import { createWorkflowRun, listJobs, readJob, readSettings, updateJob } from "./store.js";
import { processFlowRun } from "./workflows/engine.js";
import { listUnfinishedFlowRuns, updateFlowRun } from "./workflows/store.js";
import type { ModuleId } from "./models.js";

export type WorkItem =
  | { kind: "run"; jobId: string; runId: string }
  | { kind: "flow"; jobId: string; flowRunId: string }
  /** Kept so queue entries written by v1 can drain safely after an upgrade. */
  | { kind: "job"; jobId: string }
  | { kind: "preset"; jobId: string; slug: string };

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  lazyConnect: true,
  connectTimeout: 3000,
});

let lastRedisErrorLog = 0;
connection.on("error", (error: Error) => {
  const now = Date.now();
  if (process.env.NODE_ENV !== "test" && now - lastRedisErrorLog > 30_000) {
    console.error(`[redis] ${error.message}`);
    lastRedisErrorLog = now;
  }
});

export const workQueue = new Queue<WorkItem>("sparklingkit", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 24 * 60 * 60, count: 500 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
  },
});

let worker: Worker<WorkItem> | undefined;
let workerConnection: Redis | undefined;
const activeRuns = new Map<string, { jobId: string; runId?: string; controller: AbortController; finished: Promise<void> }>();

function activeKey(item: WorkItem) {
  return `${item.jobId}:${item.kind === "run" ? item.runId : item.kind === "flow" ? item.flowRunId : "legacy"}`;
}

export async function startWorker() {
  if (worker || process.env.WORKER_ENABLED === "false") return;
  const settings = await readSettings();
  workerConnection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  workerConnection.on("error", (error: Error) => {
    const now = Date.now();
    if (process.env.NODE_ENV !== "test" && now - lastRedisErrorLog > 30_000) {
      console.error(`[redis worker] ${error.message}`);
      lastRedisErrorLog = now;
    }
  });
  worker = new Worker<WorkItem>(
    "sparklingkit",
    async (queueJob) => {
      const { jobId } = queueJob.data;
      const key = activeKey(queueJob.data);
      const controller = new AbortController();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const active = { jobId, runId: queueJob.data.kind === "run" ? queueJob.data.runId : queueJob.data.kind === "flow" ? queueJob.data.flowRunId : undefined, controller, finished };
      activeRuns.set(key, active);
      try {
        if (queueJob.data.kind === "run") return await processRun(jobId, queueJob.data.runId, controller.signal);
        if (queueJob.data.kind === "flow") return await processFlowRun(jobId, queueJob.data.flowRunId, controller.signal);
        if (queueJob.data.kind === "preset") return await processPreset(jobId, queueJob.data.slug, controller.signal);
        return await processJob(jobId, controller.signal);
      } finally {
        if (activeRuns.get(key) === active) activeRuns.delete(key);
        finish();
      }
    },
    { connection: workerConnection, concurrency: settings.queue.workers },
  );
  worker.on("failed", (job, error) => console.error(`[worker] ${job?.id || "unknown"}: ${error.message}`));
  try {
    const unfinishedFlows = await listUnfinishedFlowRuns();
    const flowJobIds = new Set(unfinishedFlows.map((flow) => flow.jobId));
    const unfinished = (await listJobs()).filter((job) => !flowJobIds.has(job.id) && ["queued", "preparing", "processing", "merging"].includes(job.status));
    for (const job of unfinished) {
      const run = [...job.runs].reverse().find((candidate) => ["queued", "preparing", "processing", "merging"].includes(candidate.status)) || job.runs.at(-1);
      if (!run) continue;
      const existing = await workQueue.getJob(`run-${job.id}-${run.id}`) || await workQueue.getJob(`job-${job.id}`);
      if (!existing) await enqueueJob(job.id);
    }
    for (const flow of unfinishedFlows) {
      const existing = await workQueue.getJob(`flow-${flow.jobId}-${flow.id}`);
      if (!existing) await enqueueFlowRun(flow.jobId, flow.id);
    }
  } catch (error) {
    console.error(`[queue recovery] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function enqueueFlowRun(jobId: string, flowRunId: string) {
  await workQueue.add("flow", { kind: "flow", jobId, flowRunId }, { jobId: `flow-${jobId}-${flowRunId}` });
}

export async function enqueueJob(jobId: string) {
  const job = await readJob(jobId);
  const run = job?.runs.at(-1);
  if (!run) throw new Error("The job has no workflow run");
  await workQueue.add("run", { kind: "run", jobId, runId: run.id }, { jobId: `run-${jobId}-${run.id}` });
}

export async function enqueuePreset(jobId: string, slug: string) {
  return enqueueWorkflowRun(jobId, "text-transform", "text-transform.preset", { slug });
}

export async function enqueueWorkflowRun(
  jobId: string,
  moduleId: ModuleId | "text-transform",
  workflowId: string,
  params: Record<string, unknown>,
  inputArtifactIds?: string[],
) {
  const { job, run } = await createWorkflowRun(jobId, moduleId, workflowId, params, inputArtifactIds);
  try {
    await workQueue.add("run", { kind: "run", jobId, runId: run.id }, { jobId: `run-${jobId}-${run.id}` });
  } catch (error) {
    await updateJob(jobId, { status: "failed", stage: "Queue unavailable", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  return { job, run };
}

export async function stopJobWork(jobId: string) {
  return stopMatchingWork(jobId);
}

export async function stopRunWork(jobId: string, runId: string) {
  return stopMatchingWork(jobId, runId);
}

export async function stopFlowWork(jobId: string, flowRunId: string) {
  await updateFlowRun(jobId, flowRunId, { cancelRequested: true, stage: "Stopping…" });
  return stopMatchingWork(jobId, flowRunId);
}

async function stopMatchingWork(jobId: string, runId?: string) {
  let stopped = false;
  const abortActive = async () => {
    const matches = [...activeRuns.values()].filter((active) => active.jobId === jobId && (!runId || active.runId === runId));
    for (const active of matches) {
      stopped = true;
      active.controller.abort();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        active.finished.finally(() => { clearTimeout(timer); resolve(); });
      });
    }
  };

  await abortActive();
  const groups = await Promise.all([
    workQueue.getWaiting(),
    workQueue.getDelayed(),
    workQueue.getPrioritized(),
    workQueue.getJobs(["paused"]),
  ]);
  for (const queued of groups.flat()) {
    const queuedRunId = queued.data.kind === "run" ? queued.data.runId : queued.data.kind === "flow" ? queued.data.flowRunId : undefined;
    if (queued.data.jobId !== jobId || (runId && queuedRunId !== runId)) continue;
    try {
      await queued.remove();
      stopped = true;
    } catch {
      // The worker may have claimed it between listing and removal.
    }
  }
  await abortActive();
  return stopped;
}

export async function cancelQueuedJob(jobId: string) {
  return stopJobWork(jobId);
}

export async function pingRedis() {
  const start = performance.now();
  const healthConnection = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    retryStrategy: () => null,
  });
  healthConnection.on("error", () => undefined);
  try {
    await Promise.race([
      healthConnection.connect().then(() => healthConnection.ping()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Redis connection timed out")), 3500)),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: error instanceof Error ? error.message : String(error) };
  } finally {
    healthConnection.disconnect();
  }
}

export async function closeQueue() {
  await Promise.race([
    Promise.all([worker?.close(), workQueue.close()]),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]).catch(() => undefined);
  connection.disconnect();
  workerConnection?.disconnect();
}
