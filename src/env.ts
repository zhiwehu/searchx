import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = value;
  }
}
