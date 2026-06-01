# SearchX

SearchX is a local-first natural language search system for documents and media.
It converts source files into Markdown with Microsoft MarkItDown, then indexes the
generated Markdown with QMD for BM25, vector search, fast hybrid search, and
deep natural-language reranking.

## Current shape

- API: Node.js 22 HTTP server with no web framework.
- Converter: Python worker using `markitdown`.
- Search: `@tobilu/qmd` SDK over a local SQLite index.
- Client: lightweight demo web app served by the API. Real integrations should
  use the API or CLI directly.
- Storage: `.searchx/markdown`, `.searchx/catalog.json`, `.searchx/qmd.sqlite`.
- Source files are treated as read-only. SearchX never writes Markdown into the
  original data directories.

## Install

```bash
npm install
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

On Windows, use `.venv\Scripts\python.exe -m pip install -r requirements.txt`
and set `SEARCHX_PYTHON=.venv\Scripts\python.exe` when running the API.

QMD downloads local GGUF models on first vector or hybrid use. SearchX builds a
vector index during sync by default so the demo's natural-language search works
after ingestion. For Chinese or mixed-language corpora, set `QMD_EMBED_MODEL` to
a multilingual embedding model before embedding.

## Run

```bash
npm run dev
```

Open `http://127.0.0.1:7310`.

If you installed Python dependencies into `.venv`, export `SEARCHX_PYTHON` first
or copy `.env.example` to `.env` and adjust it for your shell.

## CLI

Build once, then call the CLI from `dist`:

```bash
npm run build
npm run cli -- status
npm run cli -- root add "/path/to/data" --no-recursive
npm run cli -- sync
npm run cli -- search "payment terms" --mode hybrid --limit 10
```

## Workflow

1. Add one or more local data directories in the web app, API, or CLI.
2. Click `Sync`.
3. The server scans the configured roots, converts supported files, and writes
   Markdown sidecars under `.searchx/markdown/<root-id>/<relative-source-path>.md`.
4. Removed source files are removed from the catalog and their Markdown sidecars
   are deleted on the next sync.
5. Search with keywords, semantic vector search, fast natural-language search,
   or deep natural-language search.

## API

- `GET /api/health`
- `GET /api/roots`
- `POST /api/roots` with `{ "path": "...", "name": "...", "recursive": true }`
- `DELETE /api/roots/:id`
- `GET /api/assets`
- `GET /api/assets/:id/raw`
- `GET /api/assets/:id/markdown`
- `POST /api/ingest` with `{ "path": "...", "recursive": true, "embed": true }`
- `POST /api/sync` with `{ "rootIds": ["..."], "embed": true }`
- `POST /api/sync/jobs` with `{ "rootIds": ["..."], "embed": true }`
- `GET /api/jobs/:id`
- `POST /api/index` with `{ "embed": true, "force": false }`
- `POST /api/search` with `{ "query": "...", "mode": "lex|vector|hybrid|deep", "limit": 10 }`
- `GET /api/settings`
- `PUT /api/settings`

## Local-first model policy

QMD runs local GGUF embedding/reranking/query-expansion models through
`node-llama-cpp`. SearchX exposes four query modes:

- `lex`: BM25 keyword search, no model.
- `vector`: semantic vector search with the local embedding model.
- `hybrid`: fast keyword + vector fusion, without query expansion or rerank.
- `deep`: QMD `search()` with local query expansion and rerank, best quality but
  slowest.

Deep search runs in a separate worker process with a default timeout of 30s
(`SEARCHX_DEEP_SEARCH_TIMEOUT_MS`). If the local model path is too slow, SearchX
kills the worker and falls back to fast hybrid search so the API and web app do
not stay stuck in "searching" forever.

Set `SEARCHX_QMD_EMBED_ON_INGEST=0`, or pass `"embed": false` / `--no-embed`,
to refresh only the text index and skip vector indexing.

SearchX is MarkItDown-first: it does not expose VLM, OCR, or ASR switches in the
demo UI. Content extraction goes through MarkItDown, and optional models should
be exposed as MarkItDown LLM/VLM providers or plugins. SearchX defaults to
best-effort extraction: MarkItDown plugins, archive handling, and media handling
are enabled unless explicitly disabled by environment variables.

MarkItDown runs without model calls unless an OpenAI-compatible provider is
configured. To let MarkItDown use a local or cloud endpoint, set:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=local
SEARCHX_LLM_MODEL=openbmb/MiniCPM-V-4.6
```

When `OPENAI_BASE_URL` and `SEARCHX_LLM_MODEL` are set, SearchX enables the
provider automatically. If `OPENAI_API_KEY` is omitted for a local provider, the
converter passes a dummy `local` key to satisfy OpenAI-compatible clients. Set
`SEARCHX_MARKITDOWN_USE_LLM=0` to force model calls off.

In MarkItDown 0.1.6 as installed here:

- Plain document conversion does not require a model.
- Image descriptions and PPTX image captions use an OpenAI-compatible vision model.
- `markitdown-ocr` uses the same vision model for embedded-image OCR in PDF,
  DOCX, PPTX, and XLSX files.
- Audio transcription currently uses `speech_recognition` with Google
  recognition; a local-first production pipeline should replace this with a
  local ASR engine such as Whisper or faster-whisper.

## Notes

The web app is a demo and validation client. The intended integration surface is
the API and CLI, so other applications or agents can add roots, sync, inspect
jobs, rebuild indexes, and search without depending on the browser UI.
