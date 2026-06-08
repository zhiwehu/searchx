import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";

const quickLookExtensions = new Set([
  ".doc",
  ".docx",
  ".odp",
  ".ods",
  ".odt",
  ".ppt",
  ".pptx",
  ".rtf",
  ".xls",
  ".xlsx"
]);

type QuickLookAsset = {
  id: string;
  sourcePath: string;
  sourceExt: string;
  size: number;
  mtimeMs: number;
};

export function canUseQuickLookPreview(asset: { sourceExt: string }): boolean {
  return quickLookExtensions.has(asset.sourceExt.toLowerCase());
}

export async function getQuickLookPreview(asset: QuickLookAsset): Promise<string> {
  const cacheRoot = path.join(config.dataDir, "previews");
  await fs.mkdir(cacheRoot, { recursive: true });

  const cachePath = path.join(cacheRoot, `${asset.id}-${Math.round(asset.mtimeMs)}-${asset.size}.png`);
  if (await fileExists(cachePath)) return cachePath;

  const tempDir = path.join(cacheRoot, `tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
  try {
    await runQuickLook(asset.sourcePath, tempDir);
    const generated = await findGeneratedPng(tempDir);
    await fs.rename(generated, cachePath);
    return cachePath;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function runQuickLook(sourcePath: string, outputDir: string): Promise<void> {
  if (process.platform !== "darwin") {
    await runLibreOfficePreview(sourcePath, outputDir);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    execFile("qlmanage", ["-t", "-s", "1600", "-o", outputDir, sourcePath], { timeout: 30000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function runLibreOfficePreview(sourcePath: string, outputDir: string): Promise<void> {
  const profileDir = path.join(outputDir, "lo-profile");
  await fs.mkdir(profileDir, { recursive: true });

  try {
    await convertWithLibreOffice(sourcePath, outputDir, profileDir, "png");
    await findGeneratedFile(outputDir, ".png");
    return;
  } catch {
    // Some LibreOffice filters cannot export directly to PNG. Convert through PDF below.
  }

  await convertWithLibreOffice(sourcePath, outputDir, profileDir, "pdf");

  const pdfPath = await findGeneratedFile(outputDir, ".pdf");
  const outputPrefix = path.join(outputDir, "preview");
  await runCommand("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "144", pdfPath, outputPrefix], 30000);
}

async function convertWithLibreOffice(
  sourcePath: string,
  outputDir: string,
  profileDir: string,
  format: "pdf" | "png"
): Promise<void> {
  await runCommand(
    "libreoffice",
    [
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--convert-to",
      format,
      "--outdir",
      outputDir,
      sourcePath
    ],
    90000
  );
}

async function runCommand(command: string, args: string[], timeout: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(new Error(detail ? `${command} failed: ${detail}` : `${command} failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

async function findGeneratedPng(outputDir: string): Promise<string> {
  return findGeneratedFile(outputDir, ".png");
}

async function findGeneratedFile(outputDir: string, extension: string): Promise<string> {
  const entries = await fs.readdir(outputDir);
  const file = entries.find((entry) => entry.toLowerCase().endsWith(extension));
  if (!file) {
    throw new Error(`Preview conversion did not produce a ${extension} file.`);
  }
  return path.join(outputDir, file);
}
