export type MediaKind =
  | "document"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "text"
  | "other";

export type ConversionStatus = "ok" | "metadata_only" | "failed";

export type IngestedAsset = {
  id: string;
  rootId: string;
  title: string;
  kind: MediaKind;
  sourcePath: string;
  relativePath: string;
  markdownPath: string;
  sourceExt: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  convertedAt: string;
  lastSeenAt: string;
  status: ConversionStatus;
  error?: string;
};

export type SourceRoot = {
  id: string;
  name: string;
  path: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CatalogData = {
  version: 1;
  roots: Record<string, SourceRoot>;
  assets: Record<string, IngestedAsset>;
};

export type AddRootRequest = {
  path: string;
  name?: string;
  recursive?: boolean;
  enabled?: boolean;
};

export type IngestRequest = {
  path: string;
  recursive?: boolean;
  embed?: boolean;
};

export type IngestResult = {
  source: string;
  root?: SourceRoot;
  scanned: number;
  converted: IngestedAsset[];
  unchanged: IngestedAsset[];
  removed: IngestedAsset[];
  skipped: Array<{ path: string; reason: string }>;
  index?: unknown;
};

export type SyncRequest = {
  rootIds?: string[];
  embed?: boolean;
  force?: boolean;
};

export type SyncResult = {
  roots: IngestResult[];
  scanned: number;
  converted: IngestedAsset[];
  unchanged: IngestedAsset[];
  removed: IngestedAsset[];
  skipped: Array<{ path: string; reason: string }>;
  index?: unknown;
};

export type SyncPhase =
  | "queued"
  | "scanning"
  | "converting"
  | "cleaning"
  | "indexing"
  | "embedding"
  | "done"
  | "failed";

export type SyncProgress = {
  phase: SyncPhase;
  message: string;
  processed: number;
  total: number;
  converted: number;
  unchanged: number;
  skipped: number;
  removed: number;
  currentRoot?: SourceRoot;
  currentFile?: string;
  updatedAt: string;
};

export type SyncProgressReporter = (progress: Partial<SyncProgress>) => void;

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type ProgressJob<T = unknown> = {
  id: string;
  type: "sync";
  status: JobStatus;
  progress: SyncProgress;
  result?: T;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeSettings = {
  pythonBin: string;
  markitdownPlugins: boolean;
  markitdownArchives: boolean;
  markitdownMedia: boolean;
  markitdownUseLlm: boolean;
  llmModel: string;
  llmPrompt: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiApiKeySet: boolean;
  qmdEmbedOnIngest: boolean;
  qmdChunkStrategy: string;
  qmdEmbedModel: string;
  qmdRerankModel: string;
  qmdGenerateModel: string;
  qmdForceCpu: boolean;
  qmdLlamaGpu: string;
};

export type SearchMode = "lex" | "vector" | "hybrid" | "deep";

export type SearchRequest = {
  query: string;
  mode?: SearchMode;
  limit?: number;
  minScore?: number;
};

export type SearchResultItem = {
  id?: string;
  title: string;
  score: number;
  snippet?: string;
  displayPath?: string;
  markdownPath?: string;
  source?: IngestedAsset;
  raw: unknown;
};

export type SearchResponse = {
  results: SearchResultItem[];
  modeRequested: SearchMode;
  modeUsed: SearchMode;
  warning?: string;
};
