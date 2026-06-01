import { createStore } from "@tobilu/qmd";
import { config } from "./config.js";

type WorkerMessage =
  | { type: "result"; results: unknown[] }
  | { type: "error"; error: string };

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Missing deep search payload.");

  const options = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
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
    const results = await store.search(options);
    send({ type: "result", results });
  } finally {
    await store.close().catch(() => undefined);
  }
}

function send(message: WorkerMessage): void {
  if (process.send) {
    process.send(message);
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  send({ type: "error", error: errorMessage(error) });
  process.exitCode = 1;
});
