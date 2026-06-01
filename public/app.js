const state = {
  roots: [],
  assets: [],
  busy: false
};

const $ = (id) => document.getElementById(id);

const els = {
  statusText: $("statusText"),
  storageHint: $("storageHint"),
  rootForm: $("rootForm"),
  rootPathInput: $("rootPathInput"),
  rootNameInput: $("rootNameInput"),
  recursiveInput: $("recursiveInput"),
  refreshRootsButton: $("refreshRootsButton"),
  rootList: $("rootList"),
  embedInput: $("embedInput"),
  forceConvertInput: $("forceConvertInput"),
  syncButton: $("syncButton"),
  indexButton: $("indexButton"),
  progressWrap: $("progressWrap"),
  progressLabel: $("progressLabel"),
  progressPercent: $("progressPercent"),
  syncProgress: $("syncProgress"),
  progressStats: $("progressStats"),
  refreshSettingsButton: $("refreshSettingsButton"),
  settingsForm: $("settingsForm"),
  pythonBinInput: $("pythonBinInput"),
  markitdownPluginsInput: $("markitdownPluginsInput"),
  markitdownArchivesInput: $("markitdownArchivesInput"),
  markitdownMediaInput: $("markitdownMediaInput"),
  markitdownUseLlmInput: $("markitdownUseLlmInput"),
  openaiBaseUrlInput: $("openaiBaseUrlInput"),
  openaiApiKeyInput: $("openaiApiKeyInput"),
  llmModelInput: $("llmModelInput"),
  llmPromptInput: $("llmPromptInput"),
  qmdEmbedDefaultInput: $("qmdEmbedDefaultInput"),
  qmdEmbedModelInput: $("qmdEmbedModelInput"),
  qmdRerankModelInput: $("qmdRerankModelInput"),
  qmdGenerateModelInput: $("qmdGenerateModelInput"),
  qmdChunkStrategyInput: $("qmdChunkStrategyInput"),
  qmdGpuInput: $("qmdGpuInput"),
  qmdForceCpuInput: $("qmdForceCpuInput"),
  modelNotes: $("modelNotes"),
  searchForm: $("searchForm"),
  queryInput: $("queryInput"),
  modeSelect: $("modeSelect"),
  summaryText: $("summaryText"),
  resultsList: $("resultsList"),
  previewTitle: $("previewTitle"),
  previewBody: $("previewBody"),
  rawLink: $("rawLink")
};

boot();

async function boot() {
  bindEvents();
  await refreshAll();
}

function bindEvents() {
  els.rootForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addRoot();
  });

  els.refreshRootsButton.addEventListener("click", refreshAll);
  els.syncButton.addEventListener("click", syncAll);
  els.indexButton.addEventListener("click", refreshIndex);
  els.refreshSettingsButton.addEventListener("click", loadSettings);
  els.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings();
  });

  els.searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await search();
  });
}

async function refreshAll() {
  await withBusy("读取状态", async () => {
    await loadAll();
    await loadSettings();
  });
}

async function loadAll() {
  const [health, roots, assets] = await Promise.all([api("/api/health"), api("/api/roots"), api("/api/assets")]);
  state.roots = roots.roots ?? [];
  state.assets = assets.assets ?? [];
  els.storageHint.textContent = `Markdown 镜像目录：${health.markdownDir}`;
  els.statusText.textContent = `${state.roots.length} 个目录，${state.assets.length} 个文件`;
  renderRoots();
}

async function addRoot() {
  const rootPath = els.rootPathInput.value.trim();
  if (!rootPath) {
    setSummary("请输入目录路径。");
    return;
  }

  await withBusy("添加目录", async () => {
    await api("/api/roots", {
      method: "POST",
      body: {
        path: rootPath,
        name: els.rootNameInput.value.trim() || undefined,
        recursive: els.recursiveInput.checked
      }
    });
    els.rootPathInput.value = "";
    els.rootNameInput.value = "";
    await loadAll();
  });
}

async function removeRoot(rootId) {
  await withBusy("移除目录", async () => {
    await api(`/api/roots/${encodeURIComponent(rootId)}`, { method: "DELETE" });
    await loadAll();
  });
}

async function syncAll() {
  await withBusy("同步中", async () => {
    const result = await runSyncJob({ embed: els.embedInput.checked, force: els.forceConvertInput.checked });
    await loadAll();
    setSummary(
      `同步完成：扫描 ${result.scanned}，转换 ${result.converted.length}，未变化 ${result.unchanged.length}，移除 ${result.removed.length}。`
    );
  });
}

async function refreshIndex() {
  await withBusy("刷新索引", async () => {
    await api("/api/index", {
      method: "POST",
      body: { embed: false }
    });
    setSummary("文本索引已刷新。");
  });
}

async function search() {
  const query = els.queryInput.value.trim();
  if (!query) {
    setSummary("请输入查询。");
    return;
  }

  const mode = els.modeSelect.value;
  const isDeep = mode === "deep";
  await withBusy(isDeep ? "深度查询中" : "搜索中", async () => {
    if (isDeep) {
      setSummary("深度自然语言会调用本地 QMD 模型，若超时会自动降级为快速混合检索。");
    }
    const data = await api("/api/search", {
      method: "POST",
      timeoutMs: isDeep ? 45000 : 20000,
      body: {
        query,
        mode,
        limit: 12
      }
    });
    renderResults(data.results ?? []);
    const modeNote = data.modeUsed && data.modeRequested && data.modeUsed !== data.modeRequested ? `，已使用${modeLabel(data.modeUsed)}` : "";
    setSummary(data.warning || `找到 ${(data.results ?? []).length} 条结果${modeNote}。`);
  });
}

function renderRoots() {
  if (state.roots.length === 0) {
    els.rootList.innerHTML = `<div class="hint">还没有数据目录。添加目录后，SearchX 会只读扫描原文件，并把 Markdown 写入自己的镜像目录。</div>`;
    return;
  }

  els.rootList.innerHTML = "";
  for (const root of state.roots) {
    const item = document.createElement("article");
    item.className = "root-item";
    item.innerHTML = `
      <div class="root-title">${escapeHtml(root.name)}</div>
      <div class="root-path">${escapeHtml(root.path)}</div>
      <div class="result-meta">
        <span class="pill">${root.recursive ? "包含子目录" : "仅当前目录"}</span>
        <span class="pill">${root.enabled ? "启用" : "停用"}</span>
      </div>
      <div class="root-actions">
        <button class="ghost" data-sync="${escapeHtml(root.id)}" type="button">同步</button>
        <button class="ghost danger" data-delete="${escapeHtml(root.id)}" type="button">移除</button>
      </div>
    `;
    item.querySelector("[data-sync]").addEventListener("click", () => syncRoot(root.id));
    item.querySelector("[data-delete]").addEventListener("click", () => removeRoot(root.id));
    els.rootList.appendChild(item);
  }
}

async function syncRoot(rootId) {
  await withBusy("同步目录", async () => {
    const result = await runSyncJob({ rootIds: [rootId], embed: els.embedInput.checked, force: els.forceConvertInput.checked });
    await loadAll();
    setSummary(`目录同步完成：扫描 ${result.scanned}，转换 ${result.converted.length}，未变化 ${result.unchanged.length}。`);
  });
}

async function runSyncJob(body) {
  showProgress({
    phase: "queued",
    message: "提交同步任务。",
    processed: 0,
    total: 0,
    converted: 0,
    unchanged: 0,
    skipped: 0,
    removed: 0
  });

  const created = await api("/api/sync/jobs", {
    method: "POST",
    body
  });

  let job = created.job;
  while (job.status === "queued" || job.status === "running") {
    showProgress(job.progress);
    await delay(700);
    const data = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
    job = data.job;
  }

  showProgress(job.progress);
  if (job.status === "failed") {
    throw new Error(job.error || job.progress?.message || "同步失败");
  }
  return job.result;
}

function showProgress(progress) {
  els.progressWrap.hidden = false;
  const total = Math.max(0, progress.total ?? 0);
  const processed = Math.max(0, progress.processed ?? 0);
  const indeterminate = progress.phase === "indexing" || progress.phase === "embedding";
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : progress.phase === "done" ? 100 : 0;
  if (indeterminate) {
    els.syncProgress.removeAttribute("value");
    els.progressPercent.textContent = "处理中";
  } else {
    els.syncProgress.value = progress.phase === "done" ? 100 : percent;
    els.progressPercent.textContent = `${progress.phase === "done" ? 100 : percent}%`;
  }
  els.progressLabel.textContent = progress.message || progress.phase || "处理中";
  els.progressStats.textContent = `阶段：${phaseLabel(progress.phase)}；已处理 ${processed}/${total}；转换 ${progress.converted ?? 0}，未变化 ${progress.unchanged ?? 0}，跳过 ${progress.skipped ?? 0}，移除 ${progress.removed ?? 0}`;
}

function phaseLabel(phase) {
  return (
    {
      queued: "排队",
      scanning: "扫描",
      converting: "转换",
      cleaning: "清理",
      indexing: "QMD 文本索引",
      embedding: "QMD 向量索引",
      done: "完成",
      failed: "失败"
    }[phase] || phase
  );
}

function modeLabel(mode) {
  return (
    {
      lex: "关键词检索",
      vector: "语义向量检索",
      hybrid: "快速自然语言检索",
      deep: "深度自然语言检索"
    }[mode] || mode
  );
}

async function loadSettings() {
  const data = await api("/api/settings");
  renderSettings(data.settings);
  renderModelNotes(data.modelNotes ?? []);
}

async function saveSettings() {
  await withBusy("保存配置", async () => {
    const body = {
      pythonBin: els.pythonBinInput.value.trim(),
      markitdownPlugins: els.markitdownPluginsInput.checked,
      markitdownArchives: els.markitdownArchivesInput.checked,
      markitdownMedia: els.markitdownMediaInput.checked,
      markitdownUseLlm: els.markitdownUseLlmInput.checked,
      openaiBaseUrl: els.openaiBaseUrlInput.value.trim(),
      llmModel: els.llmModelInput.value.trim(),
      llmPrompt: els.llmPromptInput.value.trim(),
      qmdEmbedOnIngest: els.qmdEmbedDefaultInput.checked,
      qmdEmbedModel: els.qmdEmbedModelInput.value.trim(),
      qmdRerankModel: els.qmdRerankModelInput.value.trim(),
      qmdGenerateModel: els.qmdGenerateModelInput.value.trim(),
      qmdChunkStrategy: els.qmdChunkStrategyInput.value.trim() || "auto",
      qmdLlamaGpu: els.qmdGpuInput.value,
      qmdForceCpu: els.qmdForceCpuInput.checked
    };
    const openaiApiKey = els.openaiApiKeyInput.value.trim();
    if (openaiApiKey) body.openaiApiKey = openaiApiKey;

    const data = await api("/api/settings", {
      method: "PUT",
      body
    });
    renderSettings(data.settings);
    renderModelNotes(data.modelNotes ?? []);
    els.embedInput.checked = data.settings.qmdEmbedOnIngest;
    setSummary("配置已保存。模型相关改动会影响后续同步和检索；已有向量索引需要重新生成。");
  });
}

function renderSettings(settings) {
  els.pythonBinInput.value = settings.pythonBin ?? "";
  els.markitdownPluginsInput.checked = Boolean(settings.markitdownPlugins);
  els.markitdownArchivesInput.checked = settings.markitdownArchives !== false;
  els.markitdownMediaInput.checked = settings.markitdownMedia !== false;
  els.markitdownUseLlmInput.checked = Boolean(settings.markitdownUseLlm);
  els.openaiBaseUrlInput.value = settings.openaiBaseUrl ?? "";
  els.openaiApiKeyInput.value = "";
  els.openaiApiKeyInput.placeholder = settings.openaiApiKeySet ? "已配置，留空保持不变" : "本地服务可填 local";
  els.llmModelInput.value = settings.llmModel ?? "";
  els.llmPromptInput.value = settings.llmPrompt ?? "";
  els.qmdEmbedDefaultInput.checked = Boolean(settings.qmdEmbedOnIngest);
  els.embedInput.checked = Boolean(settings.qmdEmbedOnIngest);
  els.qmdEmbedModelInput.value = settings.qmdEmbedModel ?? "";
  els.qmdRerankModelInput.value = settings.qmdRerankModel ?? "";
  els.qmdGenerateModelInput.value = settings.qmdGenerateModel ?? "";
  els.qmdChunkStrategyInput.value = settings.qmdChunkStrategy ?? "auto";
  els.qmdGpuInput.value = settings.qmdLlamaGpu || "auto";
  els.qmdForceCpuInput.checked = Boolean(settings.qmdForceCpu);
}

function renderModelNotes(notes) {
  els.modelNotes.innerHTML = notes
    .map(
      (note) => `
        <div class="model-note">
          <strong>${escapeHtml(note.area)}</strong><br />
          ${escapeHtml(note.modelNeed)}<br />
          ${escapeHtml(note.currentBehavior)}
        </div>
      `
    )
    .join("");
}

function renderResults(results) {
  els.resultsList.innerHTML = "";
  if (results.length === 0) {
    els.resultsList.innerHTML = `<div class="hint">没有匹配结果。</div>`;
    return;
  }

  for (const result of results) {
    const item = document.createElement("article");
    item.className = "result-item";
    const source = result.source ?? {};
    item.innerHTML = `
      <div class="result-title">${escapeHtml(result.title)}</div>
      <div class="result-path">${escapeHtml(result.displayPath ?? source.sourcePath ?? "")}</div>
      <div class="result-snippet">${escapeHtml(result.snippet ?? "")}</div>
      <div class="result-meta">
        <span class="pill">${escapeHtml(source.kind ?? "file")}</span>
        <span class="pill score">${Math.round((result.score ?? 0) * 100)}%</span>
        <span class="pill">${formatBytes(source.size)}</span>
      </div>
    `;
    item.addEventListener("click", () => showPreview(result));
    els.resultsList.appendChild(item);
  }
}

async function showPreview(result) {
  if (!result.id) {
    els.previewTitle.textContent = result.title;
    els.previewBody.textContent = result.snippet || "这个结果没有映射到 catalog 资产。";
    els.rawLink.hidden = true;
    return;
  }

  await withBusy("读取预览", async () => {
    const data = await api(`/api/assets/${encodeURIComponent(result.id)}/markdown`);
    els.previewTitle.textContent = data.asset.title;
    els.previewBody.textContent = data.markdown;
    els.rawLink.href = `/api/assets/${encodeURIComponent(result.id)}/raw`;
    els.rawLink.hidden = false;
  });
}

async function withBusy(label, work) {
  if (state.busy) return;
  state.busy = true;
  setDisabled(true);
  const previous = els.statusText.textContent;
  els.statusText.textContent = label;
  try {
    await work();
  } catch (error) {
    setSummary(error.message || String(error));
    els.statusText.textContent = "出错";
  } finally {
    state.busy = false;
    setDisabled(false);
    if (els.statusText.textContent === label) els.statusText.textContent = previous || "就绪";
  }
}

function setDisabled(disabled) {
  for (const element of document.querySelectorAll("button, input, select, textarea")) {
    element.disabled = disabled;
  }
}

function setSummary(text) {
  els.summaryText.textContent = text;
}

async function api(path, options = {}) {
  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  try {
    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller?.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("请求超时。深度自然语言在本机模型上可能很慢，请先使用快速自然语言，或稍后重试。");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
