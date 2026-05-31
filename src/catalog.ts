import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { rootIdForPath } from "./ids.js";
import type { AddRootRequest, CatalogData, IngestedAsset, SourceRoot } from "./types.js";

const emptyCatalog = (): CatalogData => ({ version: 1, roots: {}, assets: {} });

export class Catalog {
  private data: CatalogData | undefined;

  constructor(private readonly filePath = config.catalogPath) {}

  async load(): Promise<CatalogData> {
    if (this.data) return this.data;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as CatalogData;
      this.data = { version: 1, roots: parsed.roots ?? {}, assets: parsed.assets ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = emptyCatalog();
    }
    return this.data;
  }

  async list(): Promise<IngestedAsset[]> {
    const data = await this.load();
    return Object.values(data.assets).sort((a, b) => b.convertedAt.localeCompare(a.convertedAt));
  }

  async listRoots(): Promise<SourceRoot[]> {
    const data = await this.load();
    return Object.values(data.roots).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<IngestedAsset | undefined> {
    const data = await this.load();
    return data.assets[id];
  }

  async getRoot(id: string): Promise<SourceRoot | undefined> {
    const data = await this.load();
    return data.roots[id];
  }

  async assetsForRoot(rootId: string): Promise<IngestedAsset[]> {
    const data = await this.load();
    return Object.values(data.assets).filter((asset) => asset.rootId === rootId);
  }

  async addRoot(request: AddRootRequest): Promise<SourceRoot> {
    if (!request.path || typeof request.path !== "string") {
      throw Object.assign(new Error("Missing root path"), { statusCode: 400 });
    }

    const rootPath = path.resolve(request.path);
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      throw Object.assign(new Error("Root path must be a directory"), { statusCode: 400 });
    }

    const data = await this.load();
    const id = rootIdForPath(rootPath);
    const now = new Date().toISOString();
    const existing = data.roots[id];
    const root: SourceRoot = {
      id,
      name: request.name?.trim() || existing?.name || path.basename(rootPath) || rootPath,
      path: rootPath,
      recursive: request.recursive ?? existing?.recursive ?? true,
      enabled: request.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    data.roots[id] = root;
    await this.save();
    return root;
  }

  async removeRoot(id: string): Promise<{ root?: SourceRoot; assets: IngestedAsset[] }> {
    const data = await this.load();
    const root = data.roots[id];
    if (!root) return { assets: [] };

    const assets = Object.values(data.assets).filter((asset) => asset.rootId === id);
    delete data.roots[id];
    for (const asset of assets) {
      delete data.assets[asset.id];
    }
    await this.save();
    return { root, assets };
  }

  async upsert(asset: IngestedAsset): Promise<void> {
    const data = await this.load();
    data.assets[asset.id] = asset;
    await this.save();
  }

  async upsertMany(assets: IngestedAsset[]): Promise<void> {
    const data = await this.load();
    for (const asset of assets) {
      data.assets[asset.id] = asset;
    }
    await this.save();
  }

  async removeAssets(ids: string[]): Promise<IngestedAsset[]> {
    const data = await this.load();
    const removed: IngestedAsset[] = [];
    for (const id of ids) {
      const asset = data.assets[id];
      if (!asset) continue;
      removed.push(asset);
      delete data.assets[id];
    }
    await this.save();
    return removed;
  }

  async save(): Promise<void> {
    const data = await this.load();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

export const catalog = new Catalog();
