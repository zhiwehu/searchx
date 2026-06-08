import { createStore } from "@tobilu/qmd";
import { config } from "./config.js";

type WorkerRequest = {
  embed?: boolean;
  force?: boolean;
};

type WorkerMessage =
  | { type: "progress"; phase: "indexing" | "embedding"; message: string }
  | { type: "result"; result: unknown }
  | { type: "error"; error: string };

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Missing QMD index payload.");

  const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as WorkerRequest;
  const store = await createStore({
    dbPath: config.qmdDbPath,
    config: {
      collections: {
        [config.qmdCollection]: {
          path: config.markdownDir,
          pattern: "**/*.md",
          ignore: ["**/.DS_Store"]
        }
      }
    }
  });

  try {
    const update = await store.update({
      collections: [config.qmdCollection],
      onProgress: (info: Record<string, unknown>) => {
        const current = asNumber(info.current);
        const total = asNumber(info.total);
        const file = typeof info.file === "string" ? info.file : undefined;
        send({
          type: "progress",
          phase: "indexing",
          message: total > 0
            ? `刷新 QMD 文本索引：${current}/${total}${file ? ` ${file}` : ""}`
            : "刷新 QMD 文本索引。"
        });
      }
    });

    if (!request.embed) {
      send({ type: "result", result: { update, embed: null } });
      return;
    }

    const embed = await store.embed({
      force: request.force === true,
      chunkStrategy: qmdChunkStrategy(),
      onProgress: (info: Record<string, unknown>) => {
        const chunksEmbedded = asNumber(info.chunksEmbedded);
        const totalChunks = asNumber(info.totalChunks);
        const bytesProcessed = asNumber(info.bytesProcessed);
        const totalBytes = asNumber(info.totalBytes);
        const errors = asNumber(info.errors);
        const chunkText = totalChunks > 0 ? `chunks ${chunksEmbedded}/${totalChunks}` : "chunks pending";
        const byteText = totalBytes > 0 ? `, ${formatPercent(bytesProcessed, totalBytes)} bytes` : "";
        const errorText = errors > 0 ? `, errors ${errors}` : "";
        send({
          type: "progress",
          phase: "embedding",
          message: `生成 QMD 向量索引：${chunkText}${byteText}${errorText}`
        });
      }
    });

    send({ type: "result", result: { update, embed } });
  } finally {
    await store.close?.().catch(() => undefined);
  }
}

function send(message: WorkerMessage): void {
  if (process.send) {
    process.send(message);
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatPercent(current: number, total: number): string {
  return `${Math.min(100, Math.round((current / total) * 100))}%`;
}

function qmdChunkStrategy(): "auto" | "regex" {
  return config.qmdChunkStrategy === "regex" ? "regex" : "auto";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  send({ type: "error", error: errorMessage(error) });
  process.exitCode = 1;
});
