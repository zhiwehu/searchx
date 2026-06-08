import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ServerResponse } from "node:http";
import { guessMimeType } from "./fileKinds.js";

const publicRoot = path.join(process.cwd(), "public");
const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export async function serveStatic(urlPath: string, response: ServerResponse): Promise<boolean> {
  const cleanPath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const resolved = path.resolve(publicRoot, `.${cleanPath}`);

  if (!isPathInsideRoot(publicRoot, resolved)) return false;

  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) return false;
    response.writeHead(200, {
      "content-type": staticMimeTypes[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    fs.createReadStream(resolved).pipe(response);
    return true;
  } catch {
    return false;
  }
}

export type StreamFileOptions = {
  contentType?: string;
  downloadName?: string;
};

export async function streamFile(filePath: string, response: ServerResponse, options: StreamFileOptions = {}): Promise<void> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const headers: Record<string, string | number> = {
    "content-type": options.contentType ?? guessMimeType(filePath),
    "content-length": stat.size,
    "cache-control": "private, max-age=60"
  };
  if (options.downloadName) {
    headers["content-disposition"] = contentDisposition(options.downloadName);
  }
  response.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(response);
}

function contentDisposition(filename: string): string {
  const fallback =
    filename
      .replaceAll("\\", "_")
      .replaceAll('"', "'")
      .replaceAll(/\r?\n/g, " ")
      .replaceAll(/[^\x20-\x7e]/g, "_")
      .trim() || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
