import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { catalog } from "./catalog.js";
import { assetIdForPath, rootIdForPath } from "./ids.js";
import { detectKind, getSourceExt, guessMimeType, shouldTryConvert } from "./fileKinds.js";
import { killProcessTree } from "./processUtils.js";
import type {
  ConversionStatus,
  IngestRequest,
  IngestResult,
  IngestedAsset,
  SourceRoot,
  SyncProgress,
  SyncProgressReporter,
  SyncRequest,
  SyncResult
} from "./types.js";

type FileStat = {
  size: number;
  mtimeMs: number;
};

type SyncCounters = {
  processed: number;
  converted: number;
  unchanged: number;
  skipped: number;
  removed: number;
};

const ignoredDirectoryNames = new Set([
  ".git",
  ".hg",
  ".searchx",
  ".svn",
  "dist",
  "node_modules",
  "__pycache__"
]);

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(config.markdownDir, { recursive: true });
}

export async function ingestPath(request: IngestRequest): Promise<IngestResult> {
  if (!request.path || typeof request.path !== "string") {
    throw Object.assign(new Error("Missing path"), { statusCode: 400 });
  }

  const source = path.resolve(request.path);
  const stat = await fs.stat(source);

  if (stat.isDirectory()) {
    const root = await catalog.addRoot({
      path: source,
      recursive: request.recursive ?? true,
      enabled: true
    });
    return syncRoot(root);
  }

  const parentPath = path.dirname(source);
  const root = (await catalog.getRoot(rootIdForPath(parentPath))) ?? await catalog.addRoot({
    path: parentPath,
    name: path.basename(parentPath),
    recursive: false,
    enabled: true
  });
  return syncRoot(root, source);
}

export async function syncConfiguredRoots(request: SyncRequest = {}, report?: SyncProgressReporter): Promise<SyncResult> {
  await ensureDataDirs();
  const roots = await catalog.listRoots();
  const requested = new Set(request.rootIds ?? []);
  const selected = roots.filter((root) => root.enabled && (requested.size === 0 || requested.has(root.id)));

  const plans: Array<{ root: SourceRoot; files: string[] }> = [];
  let totalFiles = 0;
  reportProgress(report, {
    phase: "scanning",
    message: selected.length === 0 ? "没有启用的数据目录。" : `准备扫描 ${selected.length} 个数据目录。`,
    processed: 0,
    total: 0
  });

  for (const root of selected) {
    reportProgress(report, {
      phase: "scanning",
      message: `扫描目录：${root.name}`,
      currentRoot: root
    });
    const files = await walkFiles(root.path, root.recursive);
    plans.push({ root, files });
    totalFiles += files.length;
    reportProgress(report, {
      phase: "scanning",
      message: `已发现 ${totalFiles} 个文件。`,
      total: totalFiles,
      currentRoot: root
    });
  }

  const rootResults: IngestResult[] = [];
  const counters: SyncCounters = { processed: 0, converted: 0, unchanged: 0, skipped: 0, removed: 0 };
  for (const plan of plans) {
    rootResults.push(await syncRootWithProgress(plan.root, undefined, plan.files, report, counters, totalFiles, request.force === true));
  }

  return {
    roots: rootResults,
    scanned: rootResults.reduce((sum, result) => sum + result.scanned, 0),
    converted: rootResults.flatMap((result) => result.converted),
    unchanged: rootResults.flatMap((result) => result.unchanged),
    removed: rootResults.flatMap((result) => result.removed),
    skipped: rootResults.flatMap((result) => result.skipped)
  };
}

export async function cleanupMarkdownAssets(assets: IngestedAsset[]): Promise<void> {
  for (const asset of assets) {
    await fs.rm(asset.markdownPath, { force: true }).catch(() => undefined);
  }
}

async function syncRoot(root: SourceRoot, onlyFile?: string): Promise<IngestResult> {
  return syncRootWithProgress(root, onlyFile);
}

async function syncRootWithProgress(
  root: SourceRoot,
  onlyFile?: string,
  knownFiles?: string[],
  report?: SyncProgressReporter,
  counters: SyncCounters = { processed: 0, converted: 0, unchanged: 0, skipped: 0, removed: 0 },
  totalFiles?: number,
  force = false
): Promise<IngestResult> {
  await ensureDataDirs();

  const files = knownFiles ?? (onlyFile ? [onlyFile] : await walkFiles(root.path, root.recursive));
  const total = totalFiles ?? files.length;
  const existingAssets = await catalog.assetsForRoot(root.id);
  const existingById = new Map(existingAssets.map((asset) => [asset.id, asset]));
  const seenIds = new Set<string>();
  const converted: IngestedAsset[] = [];
  const unchanged: IngestedAsset[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const filePath of files) {
    reportProgress(report, {
      phase: "converting",
      message: `处理：${path.basename(filePath)}`,
      currentRoot: root,
      currentFile: filePath,
      total,
      ...counters
    });

    if (!shouldTryConvert(filePath)) {
      skipped.push({ path: filePath, reason: "unsupported extension" });
      counters.processed += 1;
      counters.skipped += 1;
      reportProgress(report, {
        phase: "converting",
        message: `跳过不支持的文件：${path.basename(filePath)}`,
        currentRoot: root,
        currentFile: filePath,
        total,
        ...counters
      });
      continue;
    }

    try {
      const stat = await fs.stat(filePath);
      const id = assetIdForPath(filePath);
      const markdownPath = getMarkdownPath(root, filePath);
      const previous = existingById.get(id);
      seenIds.add(id);

      if (!force && previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.markdownPath === markdownPath) {
        try {
          await fs.access(previous.markdownPath);
          const refreshed = { ...previous, lastSeenAt: new Date().toISOString() };
          unchanged.push(refreshed);
          await catalog.upsert(refreshed);
          counters.processed += 1;
          counters.unchanged += 1;
          reportProgress(report, {
            phase: "converting",
            message: `未变化：${path.basename(filePath)}`,
            currentRoot: root,
            currentFile: filePath,
            total,
            ...counters
          });
          continue;
        } catch {
          // Rebuild missing sidecar below.
        }
      }

      const asset = await convertOne(root, filePath, stat, onlyFile || files.length === 1 ? "single" : "batch");
      converted.push(asset);
      await catalog.upsert(asset);
      counters.processed += 1;
      counters.converted += 1;
      reportProgress(report, {
        phase: "converting",
        message: `已转换：${path.basename(filePath)}`,
        currentRoot: root,
        currentFile: filePath,
        total,
        ...counters
      });
    } catch (error) {
      skipped.push({ path: filePath, reason: error instanceof Error ? error.message : String(error) });
      counters.processed += 1;
      counters.skipped += 1;
      reportProgress(report, {
        phase: "converting",
        message: `处理失败：${path.basename(filePath)}`,
        currentRoot: root,
        currentFile: filePath,
        total,
        ...counters
      });
    }
  }

  reportProgress(report, {
    phase: "cleaning",
    message: `清理已删除文件：${root.name}`,
    currentRoot: root,
    total,
    ...counters
  });
  const removedIds = existingAssets.filter((asset) => !seenIds.has(asset.id)).map((asset) => asset.id);
  const removed = onlyFile ? [] : await catalog.removeAssets(removedIds);
  await cleanupMarkdownAssets(removed);
  counters.removed += removed.length;
  reportProgress(report, {
    phase: "cleaning",
    message: removed.length > 0 ? `清理了 ${removed.length} 个 Markdown 镜像。` : `无需清理：${root.name}`,
    currentRoot: root,
    total,
    ...counters
  });

  return {
    source: root.path,
    root,
    scanned: files.length,
    converted,
    unchanged,
    removed,
    skipped
  };
}

async function walkFiles(root: string, recursive: boolean): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      if (recursive) files.push(...(await walkFiles(fullPath, recursive)));
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }

  return files;
}

async function convertOne(
  root: SourceRoot,
  sourcePath: string,
  knownStat?: FileStat,
  mode: "single" | "batch" = "batch"
): Promise<IngestedAsset> {
  const stat = knownStat ?? (await fs.stat(sourcePath));
  const id = assetIdForPath(sourcePath);
  const kind = detectKind(sourcePath);
  const title = path.basename(sourcePath);
  const relativePath = getRelativePath(root, sourcePath);
  const markdownPath = getMarkdownPath(root, sourcePath);
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  const tempMarkdownPath = `${markdownPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  let converterResult: { status: ConversionStatus; error?: string };
  try {
    converterResult = await runConverter({
      id,
      rootId: root.id,
      kind,
      sourcePath,
      relativePath,
      markdownPath: tempMarkdownPath,
      title,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode
    });
    await fs.rename(tempMarkdownPath, markdownPath);
  } catch (error) {
    await fs.rm(tempMarkdownPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const now = new Date().toISOString();
  return {
    id,
    rootId: root.id,
    title,
    kind,
    sourcePath,
    relativePath,
    markdownPath,
    sourceExt: getSourceExt(sourcePath),
    mimeType: guessMimeType(sourcePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    convertedAt: now,
    lastSeenAt: now,
    status: converterResult.status,
    error: converterResult.error
  };
}

function getRelativePath(root: SourceRoot, sourcePath: string): string {
  const relativePath = path.relative(root.path, sourcePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return path.basename(sourcePath);
  }
  return relativePath;
}

function getMarkdownPath(root: SourceRoot, sourcePath: string): string {
  const relativePath = getRelativePath(root, sourcePath);
  const safeParts = relativePath.split(path.sep).filter(Boolean);
  const last = safeParts.pop() ?? path.basename(sourcePath);
  const markdownFile = `${last}.md`;
  return path.join(config.markdownDir, root.id, ...safeParts, markdownFile);
}

function runConverter(args: {
  id: string;
  rootId: string;
  kind: string;
  sourcePath: string;
  relativePath: string;
  markdownPath: string;
  title: string;
  size: number;
  mtimeMs: number;
  mode: "single" | "batch";
}): Promise<{ status: ConversionStatus; error?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let killFallback: NodeJS.Timeout | undefined;
    let timeoutError: Error | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      callback();
    };

    const child = spawn(
      config.pythonBin,
      [
        config.converterScript,
        "--input",
        args.sourcePath,
        "--output",
        args.markdownPath,
        "--id",
        args.id,
        "--root-id",
        args.rootId,
        "--relative-path",
        args.relativePath,
        "--kind",
        args.kind,
        "--title",
        args.title,
        "--size",
        String(args.size),
        "--mtime-ms",
        String(args.mtimeMs),
        "--mode",
        args.mode
      ],
      {
        cwd: config.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    timeout = setTimeout(() => {
      timeoutError = new Error(`converter timed out after ${config.converterTimeoutMs}ms: ${path.basename(args.sourcePath)}`);
      killProcessTree(child);
      killFallback = setTimeout(() => {
        finish(() => reject(timeoutError));
      }, 5000);
    }, config.converterTimeoutMs);
    child.on("close", (code) => {
      if (timeoutError) {
        finish(() => reject(timeoutError));
        return;
      }
      if (code !== 0) {
        finish(() => reject(new Error(stderr.trim() || `converter exited with code ${code}`)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}") as { status?: ConversionStatus; error?: string };
        finish(() => resolve({ status: parsed.status ?? "ok", error: parsed.error }));
      } catch (error) {
        finish(() => reject(new Error(`converter returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)));
      }
    });
  });
}

function reportProgress(report: SyncProgressReporter | undefined, patch: Partial<SyncProgress>): void {
  report?.({
    updatedAt: new Date().toISOString(),
    ...patch
  });
}
