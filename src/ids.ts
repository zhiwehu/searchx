import crypto from "node:crypto";
import path from "node:path";

export function assetIdForPath(sourcePath: string): string {
  return crypto.createHash("sha256").update(path.resolve(sourcePath)).digest("hex").slice(0, 24);
}

export function rootIdForPath(sourcePath: string): string {
  return crypto.createHash("sha256").update(`root:${path.resolve(sourcePath)}`).digest("hex").slice(0, 16);
}

export function idFromMarkdownPath(markdownPath: string | undefined): string | undefined {
  if (!markdownPath) return undefined;
  const base = path.basename(markdownPath).toLowerCase();
  const match = /^([a-f0-9]{24})\.md$/.exec(base);
  return match?.[1];
}
