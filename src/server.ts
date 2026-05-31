import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { catalog } from "./catalog.js";
import { cleanupMarkdownAssets, ingestPath, syncConfiguredRoots } from "./ingest.js";
import { readJsonBody, sendError, sendJson } from "./http.js";
import { getQmdStatus, refreshQmdIndex, searchQmd, closeQmdStore } from "./qmdService.js";
import { getJob, startSyncJob } from "./jobs.js";
import { getRuntimeSettings, updateRuntimeSettings } from "./settings.js";
import { serveStatic, streamFile } from "./static.js";
import { runWorkflowTask } from "./workflowQueue.js";
import type { AddRootRequest, IngestRequest, RuntimeSettings, SearchRequest, SyncRequest } from "./types.js";

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await routeApi(request.method ?? "GET", url, request, response);
      return;
    }

    if (await serveStatic(url.pathname, response)) return;
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendError(response, error);
  }
});

async function routeApi(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      dataDir: config.dataDir,
      markdownDir: config.markdownDir,
      qmdModelDir: config.qmdModelDir,
      qmdCollection: config.qmdCollection,
      qmdStatus: await getQmdStatus().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/assets") {
    sendJson(response, 200, { assets: await catalog.list() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, {
      settings: getRuntimeSettings(),
      modelNotes: getModelNotes()
    });
    return;
  }

  if (method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJsonBody<Partial<RuntimeSettings>>(request);
    const settings = await updateRuntimeSettings(body);
    await closeQmdStore().catch(() => undefined);
    sendJson(response, 200, {
      settings,
      modelNotes: getModelNotes()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/roots") {
    sendJson(response, 200, { roots: await catalog.listRoots() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/roots") {
    const body = await readJsonBody<AddRootRequest>(request);
    sendJson(response, 200, { root: await catalog.addRoot(body) });
    return;
  }

  const rootMatch = /^\/api\/roots\/([^/]+)$/.exec(url.pathname);
  if (method === "DELETE" && rootMatch) {
    const removed = await runWorkflowTask(async () => {
      const result = await catalog.removeRoot(rootMatch[1]);
      await cleanupMarkdownAssets(result.assets);
      await fs.rm(path.join(config.markdownDir, rootMatch[1]), { recursive: true, force: true }).catch(() => undefined);
      await refreshQmdIndex({ embed: false }).catch(() => undefined);
      return result;
    });
    sendJson(response, 200, removed);
    return;
  }

  const rawMatch = /^\/api\/assets\/([^/]+)\/raw$/.exec(url.pathname);
  if (method === "GET" && rawMatch) {
    if (!config.allowRawFileAccess) {
      sendJson(response, 403, { error: "Raw file access is disabled. Set SEARCHX_ALLOW_RAW_FILE_ACCESS=1 to enable it." });
      return;
    }
    const asset = await catalog.get(rawMatch[1]);
    if (!asset) {
      sendJson(response, 404, { error: "Asset not found" });
      return;
    }
    await streamFile(asset.sourcePath, response);
    return;
  }

  const markdownMatch = /^\/api\/assets\/([^/]+)\/markdown$/.exec(url.pathname);
  if (method === "GET" && markdownMatch) {
    const asset = await catalog.get(markdownMatch[1]);
    if (!asset) {
      sendJson(response, 404, { error: "Asset not found" });
      return;
    }
    const markdown = await fs.readFile(asset.markdownPath, "utf8");
    sendJson(response, 200, { asset, markdown });
    return;
  }

  if (method === "POST" && url.pathname === "/api/ingest") {
    const body = await readJsonBody<IngestRequest>(request);
    const result = await runWorkflowTask(async () => {
      const ingestResult = await ingestPath(body);
      ingestResult.index = await refreshQmdIndex({ embed: body.embed ?? config.qmdEmbedOnIngest });
      return ingestResult;
    });
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/sync") {
    const body = await readJsonBody<SyncRequest>(request);
    const result = await runWorkflowTask(async () => {
      const syncResult = await syncConfiguredRoots(body);
      syncResult.index = await refreshQmdIndex({
        embed: body.embed ?? config.qmdEmbedOnIngest,
        force: body.force
      });
      return syncResult;
    });
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/sync/jobs") {
    const body = await readJsonBody<SyncRequest>(request);
    const job = startSyncJob({
      ...body,
      embed: body.embed ?? config.qmdEmbedOnIngest
    });
    sendJson(response, 202, { job });
    return;
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && jobMatch) {
    const job = getJob(jobMatch[1]);
    if (!job) {
      sendJson(response, 404, { error: "Job not found" });
      return;
    }
    sendJson(response, 200, { job });
    return;
  }

  if (method === "POST" && url.pathname === "/api/index") {
    const body = await readJsonBody<{ embed?: boolean; force?: boolean }>(request);
    sendJson(response, 200, await runWorkflowTask(() => refreshQmdIndex({ embed: body.embed, force: body.force })));
    return;
  }

  if (method === "POST" && url.pathname === "/api/search") {
    const body = await readJsonBody<SearchRequest>(request);
    sendJson(response, 200, await searchQmd(body));
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function getModelNotes(): Array<{ area: string; modelNeed: string; currentBehavior: string }> {
  return [
    {
      area: "普通文档和文本",
      modelNeed: "不需要模型",
      currentBehavior: "PDF、Office、HTML、CSV、JSON、Markdown、TXT 等统一交给 MarkItDown 转为 Markdown 镜像。"
    },
    {
      area: "图片、扫描件和多模态内容",
      modelNeed: "MarkItDown 支持的 LLM/VLM provider 或插件",
      currentBehavior: "SearchX 不直接调用视觉/OCR 服务；开启 MarkItDown LLM/provider 或插件后，由 MarkItDown 决定如何处理图片、扫描件和内嵌媒体。"
    },
    {
      area: "OCR / ASR 扩展",
      modelNeed: "MarkItDown 插件或自定义 MarkItDown adapter",
      currentBehavior: "本地 OCR、ASR 和其他模型应作为 MarkItDown 插件/provider 接入，SearchX 只消费 MarkItDown 输出的 Markdown。"
    },
    {
      area: "批量处理",
      modelNeed: "不新增模型",
      currentBehavior: "批量模式只负责调度、进度、超时和状态记录，不降低 MarkItDown 的处理能力。"
    },
    {
      area: "API / CLI",
      modelNeed: "不需要模型",
      currentBehavior: "Web App 只是演示和验证；核心能力通过同步、任务状态、索引和搜索 API 暴露，后续可以补 CLI 封装。"
    },
    {
      area: "QMD 自然语言检索",
      modelNeed: "本地 embedding、query expansion、rerank GGUF 模型",
      currentBehavior: "生成向量索引后，QMD 使用本地模型做语义检索、查询扩展和重排序。"
    }
  ];
}

server.listen(config.port, config.host, () => {
  console.log(`SearchX listening on http://${config.host}:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await closeQmdStore().catch(() => undefined);
    server.close(() => process.exit(0));
  });
}
