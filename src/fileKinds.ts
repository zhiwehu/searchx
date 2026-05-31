import path from "node:path";
import type { MediaKind } from "./types.js";

const image = new Set([".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const audio = new Set([".aac", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"]);
const video = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"]);
const archive = new Set([".7z", ".gz", ".rar", ".tar", ".zip"]);
const document = new Set([
  ".doc",
  ".docx",
  ".epub",
  ".htm",
  ".html",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rtf",
  ".xls",
  ".xlsx"
]);
const text = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".markdown",
  ".rst",
  ".toml",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const mimeByExt: Record<string, string> = {
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".epub": "application/epub+zip",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".md": "text/markdown",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".tar": "application/x-tar",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip"
};

export function getSourceExt(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function detectKind(filePath: string): MediaKind {
  const ext = getSourceExt(filePath);
  if (image.has(ext)) return "image";
  if (audio.has(ext)) return "audio";
  if (video.has(ext)) return "video";
  if (archive.has(ext)) return "archive";
  if (document.has(ext)) return "document";
  if (text.has(ext)) return "text";
  return "other";
}

export function guessMimeType(filePath: string): string {
  return mimeByExt[getSourceExt(filePath)] ?? "application/octet-stream";
}

export function shouldTryConvert(filePath: string): boolean {
  return detectKind(filePath) !== "other";
}
