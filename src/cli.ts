import { catalog } from "./catalog.js";
import { ingestPath, syncConfiguredRoots } from "./ingest.js";
import { closeQmdStore, getQmdStatus, parseSearchMode, refreshQmdIndex, searchQmd } from "./qmdService.js";
import { runWorkflowTask } from "./workflowQueue.js";

type ParsedArgs = {
  positional: string[];
  flags: Map<string, string | boolean>;
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "serve":
      await import("./server.js");
      return;
    case "status":
      printJson({
        roots: await catalog.listRoots(),
        assets: (await catalog.list()).length,
        qmdStatus: await getQmdStatus().catch((error) => ({ error: errorMessage(error) }))
      });
      return;
    case "root":
      await handleRoot(args);
      return;
    case "ingest":
      await handleIngest(args);
      return;
    case "sync":
      await handleSync(args);
      return;
    case "index":
      printJson(await runWorkflowTask(() => refreshQmdIndex({ embed: flagEnabled(args, "embed"), force: flagEnabled(args, "force") })));
      return;
    case "search":
      await handleSearch(args);
      return;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleRoot(args: ParsedArgs): Promise<void> {
  const [action, rootPath] = args.positional;
  if (action === "list" || !action) {
    printJson({ roots: await catalog.listRoots() });
    return;
  }

  if (action !== "add") {
    throw new Error(`Unknown root action: ${action}`);
  }
  if (!rootPath) throw new Error("Missing root path.");

  const root = await catalog.addRoot({
    path: rootPath,
    name: stringFlag(args, "name"),
    recursive: args.flags.has("recursive") ? flagEnabled(args, "recursive") : !flagEnabled(args, "no-recursive")
  });
  printJson({ root });
}

async function handleIngest(args: ParsedArgs): Promise<void> {
  const [sourcePath] = args.positional;
  if (!sourcePath) throw new Error("Missing path.");
  const result = await runWorkflowTask(async () => {
    const ingestResult = await ingestPath({
      path: sourcePath,
      recursive: !flagEnabled(args, "no-recursive"),
      embed: flagEnabled(args, "embed")
    });
    if (flagEnabled(args, "embed")) {
      ingestResult.index = await refreshQmdIndex({ embed: true, force: flagEnabled(args, "force") });
    }
    return ingestResult;
  });
  printJson(result);
}

async function handleSync(args: ParsedArgs): Promise<void> {
  const result = await runWorkflowTask(async () => {
    const syncResult = await syncConfiguredRoots({
      embed: flagEnabled(args, "embed"),
      force: flagEnabled(args, "force")
    });
    syncResult.index = await refreshQmdIndex({
      embed: flagEnabled(args, "embed"),
      force: flagEnabled(args, "force")
    });
    return syncResult;
  });
  printJson(result);
}

async function handleSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("Missing search query.");

  const mode = parseSearchMode(stringFlag(args, "mode"));
  const limit = numberFlag(args, "limit", 10);
  printJson(await searchQmd({ query, mode, limit }));
}

function parseArgs(values: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const [rawName, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(rawName, inlineValue);
      continue;
    }

    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
      continue;
    }

    flags.set(rawName, true);
  }

  return { positional, flags };
}

function flagEnabled(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "1" || value === "true" || value === "yes";
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = Number.parseInt(stringFlag(args, name) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`SearchX CLI

Commands:
  searchx serve
  searchx status
  searchx root list
  searchx root add <path> [--name <name>] [--no-recursive]
  searchx ingest <path> [--embed] [--force]
  searchx sync [--embed] [--force]
  searchx index [--embed] [--force]
  searchx search <query> [--mode lex|vector|hybrid] [--limit 10]
`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQmdStore().catch(() => undefined);
  });
