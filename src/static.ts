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

  if (!resolved.startsWith(publicRoot)) return false;

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

export async function streamFile(filePath: string, response: ServerResponse): Promise<void> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": guessMimeType(filePath),
    "content-length": stat.size,
    "cache-control": "private, max-age=60"
  });
  fs.createReadStream(filePath).pipe(response);
}
