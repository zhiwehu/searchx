import { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500
  ) {
    super(message);
  }
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > config.maxJsonBodyBytes) {
      throw new HttpError("JSON body is too large", 413);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError("Invalid JSON body", 400);
  }
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

export function sendError(response: ServerResponse, error: unknown): void {
  const statusCode = getStatusCode(error);
  sendJson(response, statusCode, {
    error: error instanceof Error ? error.message : String(error)
  });
}

export function getStatusCode(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (typeof error === "object" && error && "statusCode" in error) {
    const code = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  }
  return 500;
}
