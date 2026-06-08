import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { catalog } from "./catalog.js";
import { cleanupMarkdownAssets, ingestPath, syncConfiguredRoots } from "./ingest.js";
import { readJsonBody, sendError, sendJson } from "./http.js";
import { getQmdStatus, refreshQmdIndex, searchQmd, closeQmdStore } from "./qmdService.js";
import { getJob, listJobs, startSyncJob } from "./jobs.js";
import { canUseQuickLookPreview, getQuickLookPreview } from "./quickLookPreview.js";
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
      allowRawFileAccess: config.allowRawFileAccess,
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

  const previewMatch = /^\/api\/assets\/([^/]+)\/preview$/.exec(url.pathname);
  if (method === "GET" && previewMatch) {
    const asset = await catalog.get(previewMatch[1]);
    if (!asset) {
      sendJson(response, 404, { error: "Asset not found" });
      return;
    }
    if (!isPreviewableAsset(asset)) {
      sendJson(response, 415, { error: "Preview is only available for image and document assets." });
      return;
    }
    if (asset.kind === "image" || asset.sourceExt === ".pdf") {
      await streamFile(asset.sourcePath, response);
      return;
    }
    if (asset.kind === "text") {
      await streamFile(asset.sourcePath, response, { contentType: "text/plain; charset=utf-8" });
      return;
    }
    if (canUseQuickLookPreview(asset)) {
      try {
        const previewPath = await getQuickLookPreview(asset);
        await streamFile(previewPath, response, { contentType: "image/png" });
        return;
      } catch {
        // Fall through to the Markdown preview when Quick Look is unavailable.
      }
    }
    await sendMarkdownPreview(response, asset.title, asset.markdownPath);
    return;
  }

  const downloadMatch = /^\/api\/assets\/([^/]+)\/download$/.exec(url.pathname);
  if (method === "GET" && downloadMatch) {
    const asset = await catalog.get(downloadMatch[1]);
    if (!asset) {
      sendJson(response, 404, { error: "Asset not found" });
      return;
    }
    if (!isDownloadableAsset(asset)) {
      sendJson(response, 415, { error: "Download is only available for image and document assets." });
      return;
    }
    await streamFile(asset.sourcePath, response, { downloadName: asset.title });
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

  if (method === "GET" && url.pathname === "/api/jobs") {
    sendJson(response, 200, { jobs: listJobs().slice(0, 20) });
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
      currentBehavior: "SearchX 默认启用 MarkItDown 插件，并在配置了 OPENAI_BASE_URL 与 SEARCHX_LLM_MODEL 时自动让 MarkItDown 调用 VLM/provider。"
    },
    {
      area: "OCR / ASR 扩展",
      modelNeed: "MarkItDown 插件或自定义 MarkItDown adapter",
      currentBehavior: "本地 OCR、ASR 和其他模型作为 MarkItDown 插件/provider 接入；SearchX 只消费 MarkItDown 输出的 Markdown 并记录失败原因。"
    },
    {
      area: "批量处理",
      modelNeed: "不新增模型",
      currentBehavior: "批量模式只负责调度、进度、超时和状态记录，不降低 MarkItDown 的处理能力。"
    },
    {
      area: "API / CLI",
      modelNeed: "不需要模型",
      currentBehavior: "Web App 只是演示和验证；核心能力通过同步、任务状态、索引和搜索 API 暴露，并提供 CLI 用于添加目录、同步、建索引和搜索。"
    },
    {
      area: "QMD 智能检索",
      modelNeed: "本地 embedding、query expansion、rerank GGUF 模型",
      currentBehavior: "Web App 的智能检索入口默认使用深度检索：先解析时间、文件类型、文件名/路径等硬条件并扫描 Markdown 精确命中，再合并 QMD query expansion/rerank 语义结果；超时或失败时降级到快速关键词 + 向量融合。"
    }
  ];
}

type PreviewAsset = {
  kind: string;
  sourceExt: string;
};

function isPreviewableAsset(asset: PreviewAsset): boolean {
  return asset.kind === "image" || asset.kind === "document" || asset.kind === "text";
}

function isDownloadableAsset(asset: PreviewAsset): boolean {
  return isPreviewableAsset(asset);
}

async function sendMarkdownPreview(response: http.ServerResponse, title: string, markdownPath: string): Promise<void> {
  const markdown = await fs.readFile(markdownPath, "utf8");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        background: #fbfcfa;
        color: #232923;
        font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      main {
        padding: 14px;
      }
      h1 {
        margin: 0 0 10px;
        color: #315343;
        font-size: 17px;
        line-height: 1.35;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.6 "SFMono-Regular", Consolas, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <pre>${escapeHtml(markdown)}</pre>
    </main>
  </body>
</html>`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, max-age=60",
    "content-length": Buffer.byteLength(html)
  });
  response.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
