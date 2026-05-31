import crypto from "node:crypto";
import { syncConfiguredRoots } from "./ingest.js";
import { refreshQmdIndex } from "./qmdService.js";
import { runWorkflowTask } from "./workflowQueue.js";
import type { ProgressJob, SyncProgress, SyncRequest, SyncResult } from "./types.js";

const jobs = new Map<string, ProgressJob<SyncResult>>();

export function startSyncJob(request: SyncRequest): ProgressJob<SyncResult> {
  const now = new Date().toISOString();
  const job: ProgressJob<SyncResult> = {
    id: crypto.randomUUID(),
    type: "sync",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    progress: {
      phase: "queued",
      message: "等待同步开始。",
      processed: 0,
      total: 0,
      converted: 0,
      unchanged: 0,
      skipped: 0,
      removed: 0,
      updatedAt: now
    }
  };

  jobs.set(job.id, job);
  void runWorkflowTask(() => runSyncJob(job, request));
  return job;
}

export function getJob(id: string): ProgressJob<SyncResult> | undefined {
  return jobs.get(id);
}

async function runSyncJob(job: ProgressJob<SyncResult>, request: SyncRequest): Promise<void> {
  updateJob(job, {
    phase: "scanning",
    message: "开始同步。",
    processed: 0,
    total: 0
  });
  job.status = "running";

  try {
    const result = await syncConfiguredRoots(request, (progress) => updateJob(job, progress));
    updateJob(job, {
      phase: "indexing",
      message: "刷新 QMD 文本索引。",
      processed: job.progress.processed,
      total: Math.max(job.progress.total, job.progress.processed)
    });

    if (request.embed) {
      updateJob(job, {
        phase: "embedding",
        message: "生成 QMD 向量索引，首次运行可能会下载或加载本地模型。"
      });
    }

    result.index = await refreshQmdIndex({ embed: request.embed, force: request.force });
    job.result = result;
    job.status = "completed";
    updateJob(job, {
      phase: "done",
      message: `同步完成：转换 ${result.converted.length}，未变化 ${result.unchanged.length}，跳过 ${result.skipped.length}。`,
      processed: result.scanned,
      total: result.scanned,
      converted: result.converted.length,
      unchanged: result.unchanged.length,
      skipped: result.skipped.length,
      removed: result.removed.length
    });
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    updateJob(job, {
      phase: "failed",
      message: job.error
    });
  }
}

function updateJob(job: ProgressJob<SyncResult>, patch: Partial<SyncProgress>): void {
  const now = new Date().toISOString();
  job.updatedAt = now;
  job.progress = {
    ...job.progress,
    updatedAt: now,
    ...patch
  };
}
