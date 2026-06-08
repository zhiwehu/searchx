const state = {
  roots: [],
  assets: [],
  settings: {},
  modelNotes: [],
  health: {},
  previewResults: [],
  previewIndex: -1,
  markdownCache: new Map(),
  syncJob: null,
  syncPollTimer: null,
  previewRoutesReady: false,
  busy: false,
  allowRawPreview: false
};

const syncJobStorageKey = "searchx.activeSyncJobId";
const initialSearchLimit = 12;
const searchPageSize = 12;
const maxSearchLimit = 50;
const $ = (id) => document.getElementById(id);

const els = {
  statusText: $("statusText"),
  summaryText: $("summaryText"),
  chatFeed: $("chatFeed"),
  searchForm: $("searchForm"),
  queryInput: $("queryInput"),
  modeSelect: $("modeSelect"),
  configButton: $("configButton"),
  configDialog: $("configDialog"),
  configCloseButton: $("configCloseButton"),
  configMenuItems: document.querySelectorAll("[data-config-view]"),
  configPanels: document.querySelectorAll("[data-config-panel]"),
  reloadSettingsButton: $("reloadSettingsButton"),
  settingsForm: $("settingsForm"),
  modelSettingsForm: $("modelSettingsForm"),
  settingsSaveHint: $("settingsSaveHint"),
  modelSaveHint: $("modelSaveHint"),
  metricRoots: $("metricRoots"),
  metricAssets: $("metricAssets"),
  metricIndexed: $("metricIndexed"),
  metricVector: $("metricVector"),
  pythonBinInput: $("pythonBinInput"),
  qmdChunkStrategyInput: $("qmdChunkStrategyInput"),
  qmdEmbedOnIngestInput: $("qmdEmbedOnIngestInput"),
  qmdForceCpuInput: $("qmdForceCpuInput"),
  qmdLlamaGpuInput: $("qmdLlamaGpuInput"),
  markitdownPluginsInput: $("markitdownPluginsInput"),
  markitdownArchivesInput: $("markitdownArchivesInput"),
  markitdownMediaInput: $("markitdownMediaInput"),
  markitdownUseLlmInput: $("markitdownUseLlmInput"),
  openaiBaseUrlInput: $("openaiBaseUrlInput"),
  openaiApiKeyInput: $("openaiApiKeyInput"),
  llmModelInput: $("llmModelInput"),
  llmPromptInput: $("llmPromptInput"),
  qmdEmbedModelInput: $("qmdEmbedModelInput"),
  qmdRerankModelInput: $("qmdRerankModelInput"),
  qmdGenerateModelInput: $("qmdGenerateModelInput"),
  modelNotes: $("modelNotes"),
  qmdStatus: $("qmdStatus"),
  taskSummary: $("taskSummary"),
  storageHint: $("storageHint"),
  rawAccessHint: $("rawAccessHint"),
  rootForm: $("rootForm"),
  rootPathInput: $("rootPathInput"),
  rootNameInput: $("rootNameInput"),
  recursiveInput: $("recursiveInput"),
  refreshRootsButton: $("refreshRootsButton"),
  refreshFoldersButton: $("refreshFoldersButton"),
  rootList: $("rootList"),
  forceConvertInput: $("forceConvertInput"),
  syncButton: $("syncButton"),
  progressWrap: $("progressWrap"),
  progressLabel: $("progressLabel"),
  progressPercent: $("progressPercent"),
  syncProgress: $("syncProgress"),
  progressStats: $("progressStats"),
  previewDialog: $("previewDialog"),
  previewCloseButton: $("previewCloseButton"),
  previewTitle: $("previewTitle"),
  previewCounter: $("previewCounter"),
  previewPrevButton: $("previewPrevButton"),
  previewNextButton: $("previewNextButton"),
  previewStage: $("previewStage"),
  markdownToggleButton: $("markdownToggleButton"),
  markdownPanel: $("markdownPanel"),
  detailMeta: $("detailMeta"),
  markdownBody: $("markdownBody"),
  downloadLink: $("downloadLink")
};

boot();

async function boot() {
  bindEvents();
  await refreshAll();
}

function bindEvents() {
  els.configButton.addEventListener("click", () => openDialog(els.configDialog));
  els.configCloseButton.addEventListener("click", () => closeDialog(els.configDialog));
  els.previewCloseButton.addEventListener("click", () => closeDialog(els.previewDialog));
  els.previewPrevButton.addEventListener("click", () => showAdjacentPreview(-1));
  els.previewNextButton.addEventListener("click", () => showAdjacentPreview(1));
  els.markdownToggleButton.addEventListener("click", toggleMarkdownPanel);

  for (const item of els.configMenuItems) {
    item.addEventListener("click", () => setConfigView(item.dataset.configView));
  }

  for (const dialog of [els.configDialog, els.previewDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!els.previewDialog.open) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      showAdjacentPreview(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      showAdjacentPreview(1);
    }
  });

  els.rootForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addRoot();
  });

  els.refreshRootsButton.addEventListener("click", refreshAll);
  els.refreshFoldersButton.addEventListener("click", refreshAll);
  els.reloadSettingsButton.addEventListener("click", loadSettingsOnly);
  els.syncButton.addEventListener("click", syncAll);

  els.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveRuntimeSettings(els.settingsSaveHint);
  });

  els.modelSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveRuntimeSettings(els.modelSaveHint);
  });

  els.searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await search();
  });
}

async function refreshAll() {
  await withBusy("读取状态", async () => {
    await loadAll();
  });
}

async function loadAll() {
  const [health, roots, assets, settingsData] = await Promise.all([
    api("/api/health"),
    api("/api/roots"),
    api("/api/assets"),
    api("/api/settings")
  ]);
  state.health = health;
  state.roots = roots.roots ?? [];
  state.assets = assets.assets ?? [];
  state.settings = settingsData.settings ?? {};
  state.modelNotes = settingsData.modelNotes ?? [];
  state.previewRoutesReady = Object.prototype.hasOwnProperty.call(health, "allowRawFileAccess");
  state.allowRawPreview = Boolean(health.allowRawFileAccess);
  els.storageHint.textContent = `Markdown 镜像目录：${health.markdownDir}`;
  els.rawAccessHint.textContent = state.allowRawPreview
    ? "图片和文档预览/下载：已启用；完整原文件访问：已启用。"
    : "图片和文档预览/下载：已启用。";
  els.statusText.textContent = `${state.roots.length} 个目录 · ${state.assets.length} 个文件`;
  renderRoots();
  renderSettings();
  renderModelNotes();
  renderRuntimeStatus();
  await restoreSyncJob();
}

async function loadSettingsOnly() {
  await withBusy("读取设置", async () => {
    const data = await api("/api/settings");
    state.settings = data.settings ?? {};
    state.modelNotes = data.modelNotes ?? [];
    renderSettings();
    renderModelNotes();
    els.modelSaveHint.textContent = "已重新读取。";
  });
}

async function saveRuntimeSettings(hintElement) {
  hintElement.textContent = "";
  await withBusy("保存设置", async () => {
    const data = await api("/api/settings", {
      method: "PUT",
      body: collectRuntimeSettings()
    });
    state.settings = data.settings ?? {};
    state.modelNotes = data.modelNotes ?? [];
    renderSettings();
    renderModelNotes();
    hintElement.textContent = "已保存。";
    setSummary("设置已保存。模型相关变更会在下一次索引或检索时使用。");
  });
}

function collectRuntimeSettings() {
  return {
    pythonBin: els.pythonBinInput.value.trim(),
    qmdChunkStrategy: els.qmdChunkStrategyInput.value.trim() || "auto",
    qmdEmbedOnIngest: els.qmdEmbedOnIngestInput.checked,
    qmdForceCpu: els.qmdForceCpuInput.checked,
    qmdLlamaGpu: els.qmdLlamaGpuInput.value.trim() || "auto",
    markitdownPlugins: els.markitdownPluginsInput.checked,
    markitdownArchives: els.markitdownArchivesInput.checked,
    markitdownMedia: els.markitdownMediaInput.checked,
    markitdownUseLlm: els.markitdownUseLlmInput.checked,
    openaiBaseUrl: els.openaiBaseUrlInput.value.trim(),
    openaiApiKey: els.openaiApiKeyInput.value,
    llmModel: els.llmModelInput.value.trim(),
    llmPrompt: els.llmPromptInput.value,
    qmdEmbedModel: els.qmdEmbedModelInput.value.trim(),
    qmdRerankModel: els.qmdRerankModelInput.value.trim(),
    qmdGenerateModel: els.qmdGenerateModelInput.value.trim()
  };
}

function renderSettings() {
  const settings = state.settings ?? {};
  els.pythonBinInput.value = settings.pythonBin ?? "";
  setSelectValue(els.qmdChunkStrategyInput, settings.qmdChunkStrategy ?? "auto");
  els.qmdEmbedOnIngestInput.checked = Boolean(settings.qmdEmbedOnIngest);
  els.qmdForceCpuInput.checked = Boolean(settings.qmdForceCpu);
  els.qmdLlamaGpuInput.value = settings.qmdLlamaGpu ?? "auto";
  els.markitdownPluginsInput.checked = Boolean(settings.markitdownPlugins);
  els.markitdownArchivesInput.checked = Boolean(settings.markitdownArchives);
  els.markitdownMediaInput.checked = Boolean(settings.markitdownMedia);
  els.markitdownUseLlmInput.checked = Boolean(settings.markitdownUseLlm);
  els.openaiBaseUrlInput.value = settings.openaiBaseUrl ?? "";
  els.openaiApiKeyInput.value = settings.openaiApiKey ?? "";
  els.llmModelInput.value = settings.llmModel ?? "";
  els.llmPromptInput.value = settings.llmPrompt ?? "";
  els.qmdEmbedModelInput.value = settings.qmdEmbedModel ?? "";
  els.qmdRerankModelInput.value = settings.qmdRerankModel ?? "";
  els.qmdGenerateModelInput.value = settings.qmdGenerateModel ?? "";
}

function renderModelNotes() {
  if (!Array.isArray(state.modelNotes) || state.modelNotes.length === 0) {
    els.modelNotes.innerHTML = "";
    return;
  }

  els.modelNotes.innerHTML = state.modelNotes
    .map((note) => `
      <article class="note-item">
        <div class="note-title">${escapeHtml(note.area)}</div>
        <div class="note-body">${escapeHtml(note.modelNeed)}</div>
        <div class="note-body">${escapeHtml(note.currentBehavior)}</div>
      </article>
    `)
    .join("");
}

function renderRuntimeStatus() {
  const qmdStatus = state.health?.qmdStatus ?? {};
  const collections = Array.isArray(qmdStatus.collections) ? qmdStatus.collections : [];
  const totalDocuments = typeof qmdStatus.totalDocuments === "number"
    ? qmdStatus.totalDocuments
    : collections.reduce((sum, item) => sum + (typeof item.documents === "number" ? item.documents : 0), 0);
  els.metricRoots.textContent = String(state.roots.length);
  els.metricAssets.textContent = String(state.assets.length);
  els.metricIndexed.textContent = String(totalDocuments || 0);
  els.metricVector.textContent = qmdStatus.hasVectorIndex === true ? "已就绪" : qmdStatus.hasVectorIndex === false ? "未生成" : "未知";

  const collectionItems = collections.map((item) => `
    <div class="status-row">
      <span>${escapeHtml(item.name ?? "collection")}</span>
      <strong>${escapeHtml(String(item.documents ?? 0))}</strong>
    </div>
  `).join("");
  els.qmdStatus.innerHTML = `
    <div class="status-row">
      <span>QMD Collection</span>
      <strong>${escapeHtml(state.health?.qmdCollection ?? "-")}</strong>
    </div>
    <div class="status-row">
      <span>模型缓存</span>
      <strong>${escapeHtml(state.health?.qmdModelDir ?? "-")}</strong>
    </div>
    ${collectionItems}
  `;
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
  setConfigView("tasks");
  await startBackgroundSync({ force: els.forceConvertInput.checked }, "同步任务已在后台运行。");
}

async function search() {
  const query = els.queryInput.value.trim();
  if (!query) {
    setSummary("请输入查询。");
    return;
  }

  const mode = els.modeSelect.value;
  const isDeep = mode === "deep";
  appendUserMessage(query);
  els.queryInput.value = "";
  const turn = appendAssistantLoading("正在查询文件...");

  await withBusy(isDeep ? "查询中" : "搜索中", async () => {
    if (isDeep) {
      setSummary("正在调用本地 QMD 模型做查询扩展和重排序；若超时会自动降级。");
    }
    const data = await searchFiles(query, mode, initialSearchLimit);
    const results = data.results ?? [];
    renderResults(results, { turn, query, mode, requestedLimit: initialSearchLimit });
    setSummary(sanitizeSearchNotice(data.warning) || `找到 ${results.length} 个文件。`);
  });

  if (turn.dataset.loading === "true") {
    renderAssistantError(turn, els.summaryText.textContent || "查询失败。");
  }
}

async function searchFiles(query, mode, limit) {
  const isDeep = mode === "deep";
  return api("/api/search", {
    method: "POST",
    timeoutMs: isDeep ? 75000 : 20000,
    body: {
      query,
      mode,
      limit
    }
  });
}

function appendUserMessage(query) {
  const item = document.createElement("article");
  item.className = "message user";
  item.innerHTML = `
    <div class="message-body user-bubble">
      <p>${escapeHtml(query)}</p>
    </div>
  `;
  els.chatFeed.appendChild(item);
  scrollChatToBottom();
}

function appendAssistantLoading(text) {
  const item = document.createElement("article");
  item.className = "message assistant is-loading";
  item.dataset.loading = "true";
  item.innerHTML = `
    <div class="avatar" aria-hidden="true">AI</div>
    <div class="message-body">
      <div class="message-kicker">SearchX 助手</div>
      <div class="thinking"><span></span><span></span><span></span>${escapeHtml(text)}</div>
    </div>
  `;
  els.chatFeed.appendChild(item);
  scrollChatToBottom();
  return item;
}

function renderAssistantError(turn, message) {
  turn.classList.remove("is-loading");
  turn.dataset.loading = "false";
  turn.querySelector(".message-body").innerHTML = `
    <div class="message-kicker">查询失败</div>
    <p>${escapeHtml(message)}</p>
  `;
  scrollChatToBottom();
}

function renderResults(results, { turn, query, mode, requestedLimit }) {
  turn.classList.remove("is-loading");
  turn.dataset.loading = "false";
  const body = turn.querySelector(".message-body");

  if (results.length === 0) {
    body.innerHTML = `
      <div class="message-kicker">未找到文件</div>
      <p>没有找到匹配文件。可以换一个关键词，或在配置里同步新的目录。</p>
    `;
    scrollChatToBottom();
    return;
  }

  body.innerHTML = `
    <div class="message-kicker">找到 ${results.length} 个文件</div>
    <p class="message-note">文件预览</p>
    <div class="file-grid"></div>
    <div class="load-more-wrap"></div>
  `;

  const grid = body.querySelector(".file-grid");
  renderFileGrid(grid, results);
  renderLoadMoreControl(body, { query, mode, results, requestedLimit });
  scrollChatToBottom();
}

function renderFileGrid(grid, results) {
  grid.innerHTML = "";
  results.forEach((result, index) => {
    grid.appendChild(createFileCard(result, index, results));
  });
}

function renderLoadMoreControl(body, context) {
  const wrap = body.querySelector(".load-more-wrap");
  if (!wrap) return;

  const currentLimit = Math.min(context.requestedLimit ?? context.results.length, maxSearchLimit);
  const nextLimit = Math.min(currentLimit + searchPageSize, maxSearchLimit);
  const canLoadMore = context.results.length >= currentLimit && currentLimit < maxSearchLimit;

  if (!canLoadMore) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }

  wrap.hidden = false;
  wrap.innerHTML = `
    <button class="load-more-button ghost" type="button">加载更多</button>
    <span class="load-more-note">已显示 ${context.results.length} 个，继续加载到 ${nextLimit} 个</span>
  `;

  const button = wrap.querySelector(".load-more-button");
  button.addEventListener("click", () => loadMoreResults(body, context, nextLimit));
}

async function loadMoreResults(body, context, nextLimit) {
  if (state.busy) return;

  const button = body.querySelector(".load-more-button");
  if (button) {
    button.disabled = true;
    button.textContent = "加载中...";
  }

  await withBusy("加载更多", async () => {
    const data = await searchFiles(context.query, context.mode, nextLimit);
    const nextResults = data.results ?? [];
    context.results.splice(0, context.results.length, ...nextResults);

    const grid = body.querySelector(".file-grid");
    renderFileGrid(grid, context.results);
    renderLoadMoreControl(body, { ...context, requestedLimit: nextLimit });
    setSummary(sanitizeSearchNotice(data.warning) || `已加载 ${context.results.length} 个文件。`);
  });

  if (button?.isConnected) {
    button.disabled = false;
    button.textContent = "加载更多";
  }
}

function createFileCard(result, index, results) {
  const source = result.source ?? {};
  const card = document.createElement("article");
  card.className = `file-card kind-${safeClass(source.kind ?? "other")}`;
  card.tabIndex = 0;
  card.role = "button";
  card.ariaLabel = `预览 ${result.title}`;
  card.innerHTML = `
    <div class="file-preview">${renderFilePreview(result)}</div>
    <div class="file-info">
      <div class="file-title">${escapeHtml(result.title)}</div>
      <div class="file-path">${escapeHtml(result.displayPath ?? source.sourcePath ?? "")}</div>
      <div class="result-meta">
        <span class="pill">${escapeHtml(kindLabel(source.kind))}</span>
        <span class="pill">${escapeHtml(fileExtension(source, result))}</span>
        <span class="pill">${formatBytes(source.size)}</span>
        <span class="pill score">${Math.round((result.score ?? 0) * 100)}%</span>
      </div>
    </div>
  `;
  bindCardPreviewFallback(card);

  const open = () => openPreview(results, index);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return card;
}

function renderFilePreview(result) {
  const source = result.source ?? {};
  const kind = source.kind ?? "other";
  const title = escapeHtml(result.title);
  const encodedId = result.id ? encodeURIComponent(result.id) : "";
  const previewUrl = encodedId && state.previewRoutesReady && isPreviewable(source) ? `/api/assets/${encodedId}/preview` : "";
  const fallback = renderFileFallback(source, result);

  if (previewUrl && (kind === "image" || isVisualDocument(source))) {
    return `
      <div class="file-thumb">
        <img class="file-thumb-media" src="${previewUrl}" alt="${title}" loading="lazy" decoding="async" />
        <span class="preview-badge">${kind === "image" ? "缩略图" : "预览"}</span>
      </div>
      ${fallback}
    `;
  }

  if (previewUrl && (kind === "document" || kind === "text")) {
    return `
      <div class="file-thumb">
        <iframe class="file-thumb-frame" src="${previewUrl}" title="${title}" loading="lazy"></iframe>
        <span class="preview-badge">文档</span>
      </div>
      ${fallback}
    `;
  }

  return fallback;
}

function renderFileFallback(source = {}, result = {}) {
  const ext = fileExtension(source, result);
  const kind = source.kind ?? "other";

  return `
    <div class="file-fallback">
      <div class="file-ext">${escapeHtml(ext)}</div>
      <div class="file-kind">${escapeHtml(kindLabel(kind))}</div>
    </div>
  `;
}

function bindCardPreviewFallback(card) {
  const preview = card.querySelector(".file-preview");
  const media = preview?.querySelector("img, iframe");
  if (!preview || !media) return;

  const markFailed = () => preview.classList.add("is-failed");
  media.addEventListener("error", markFailed);
  media.addEventListener("load", () => {
    if (media.tagName !== "IFRAME") return;
    try {
      const text = media.contentDocument?.body?.textContent ?? "";
      if (/Not found|Asset not found|Preview is only available/i.test(text)) markFailed();
    } catch {
      // Browser-rendered PDFs may not expose their document; the visible preview is still valid.
    }
  });
}

function openPreview(results, index) {
  if (!Array.isArray(results) || !Number.isInteger(index) || index < 0 || index >= results.length) return;
  state.previewResults = results;
  state.previewIndex = index;
  renderPreview();
  openDialog(els.previewDialog);
}

function showAdjacentPreview(direction) {
  if (state.previewResults.length === 0) return;
  const current = state.previewIndex < 0 ? 0 : state.previewIndex;
  const next = (current + direction + state.previewResults.length) % state.previewResults.length;
  openPreview(state.previewResults, next);
}

function renderPreview() {
  const result = state.previewResults[state.previewIndex];
  if (!result) return;

  const source = result.source ?? {};
  const canDownload = Boolean(result.id && isPreviewable(source) && state.previewRoutesReady);
  const encodedId = result.id ? encodeURIComponent(result.id) : "";
  const previewUrl = encodedId ? `/api/assets/${encodedId}/preview` : "";
  const downloadUrl = encodedId ? `/api/assets/${encodedId}/download` : "";

  els.previewTitle.textContent = result.title;
  els.previewCounter.textContent = `${state.previewIndex + 1} / ${state.previewResults.length}`;
  els.detailMeta.innerHTML = renderDetailMeta(source, result);
  els.previewPrevButton.disabled = state.previewResults.length <= 1;
  els.previewNextButton.disabled = state.previewResults.length <= 1;
  els.downloadLink.href = downloadUrl || "#";
  els.downloadLink.hidden = !canDownload;
  els.markdownPanel.hidden = true;
  els.markdownToggleButton.textContent = "!";
  els.markdownToggleButton.classList.remove("active");
  els.markdownToggleButton.setAttribute("aria-expanded", "false");
  els.markdownToggleButton.title = "查看技术信息";
  els.markdownBody.textContent = "";
  els.previewStage.innerHTML = renderPreviewStage(result, previewUrl);
  bindPreviewErrorHandlers(result);
}

function renderPreviewStage(result, previewUrl) {
  const source = result.source ?? {};
  const kind = source.kind ?? "other";
  const title = escapeHtml(result.title);

  if (!previewUrl) {
    return renderPreviewFallback(result, "这个结果没有可预览的文件映射。");
  }
  if (!state.previewRoutesReady && isPreviewable(source)) {
    return renderPreviewFallback(result, "预览接口还没有在当前服务进程中生效。请重启 SearchX 服务后刷新页面。");
  }

  if (kind === "image" || isVisualDocument(source)) {
    return `<img class="preview-full-media" src="${previewUrl}" alt="${title}" />`;
  }
  if (kind === "document" || kind === "text") {
    return `<iframe class="preview-full-frame" src="${previewUrl}" title="${title}"></iframe>`;
  }
  if (state.allowRawPreview && kind === "video") {
    return `<video class="preview-full-media" src="/api/assets/${encodeURIComponent(result.id)}/raw" controls playsinline></video>`;
  }
  if (state.allowRawPreview && kind === "audio") {
    return `<audio class="preview-audio-player" src="/api/assets/${encodeURIComponent(result.id)}/raw" controls></audio>`;
  }
  return renderPreviewFallback(result, "这个文件类型暂不支持原文件预览，可以查看技术信息或下载。");
}

function bindPreviewErrorHandlers(result) {
  const media = els.previewStage.querySelector("img, video, audio, iframe");
  if (!media) return;
  media.addEventListener("error", () => {
    els.previewStage.innerHTML = renderPreviewFallback(
      result,
      "预览接口暂不可用。若刚更新过代码，请重启 SearchX 服务后刷新页面。"
    );
  });
  media.addEventListener("load", () => {
    if (media.tagName !== "IFRAME") return;
    try {
      const text = media.contentDocument?.body?.textContent ?? "";
      if (/Not found|Asset not found|Preview is only available/i.test(text)) {
        els.previewStage.innerHTML = renderPreviewFallback(
          result,
          "预览接口返回 404。请重启 SearchX 服务后刷新页面。"
        );
      }
    } catch {
      // Cross-origin or plugin-rendered frames are fine.
    }
  });
}

function renderPreviewFallback(result, message) {
  const source = result.source ?? {};
  return `
    <div class="preview-fallback">
      <div class="file-ext">${escapeHtml(fileExtension(source, result))}</div>
      <div class="preview-fallback-title">${escapeHtml(result.title)}</div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

async function toggleMarkdownPanel() {
  if (els.markdownPanel.hidden) {
    els.markdownPanel.hidden = false;
    els.markdownToggleButton.classList.add("active");
    els.markdownToggleButton.setAttribute("aria-expanded", "true");
    els.markdownToggleButton.title = "收起技术信息";
    await loadPreviewMarkdown();
    return;
  }
  els.markdownPanel.hidden = true;
  els.markdownToggleButton.classList.remove("active");
  els.markdownToggleButton.setAttribute("aria-expanded", "false");
  els.markdownToggleButton.title = "查看技术信息";
}

async function loadPreviewMarkdown() {
  const result = state.previewResults[state.previewIndex];
  if (!result) return;

  if (!result.id) {
    els.markdownBody.textContent = result.snippet || "这个结果没有映射到 catalog 资产。";
    return;
  }

  if (state.markdownCache.has(result.id)) {
    els.markdownBody.textContent = state.markdownCache.get(result.id);
    return;
  }

  els.markdownBody.textContent = "正在读取技术信息...";
  await withBusy("读取技术信息", async () => {
    const data = await api(`/api/assets/${encodeURIComponent(result.id)}/markdown`);
    const markdown = data.markdown || "这个文件没有技术信息。";
    state.markdownCache.set(result.id, markdown);
    if (state.previewResults[state.previewIndex]?.id === result.id) {
      els.markdownBody.textContent = markdown;
    }
  });

  if (els.markdownBody.textContent === "正在读取技术信息...") {
    els.markdownBody.textContent = els.summaryText.textContent || "读取技术信息失败。";
  }
}

function renderDetailMeta(source = {}, result = {}) {
  const path = result.displayPath ?? source.sourcePath ?? "";
  return `
    <span class="pill">${escapeHtml(kindLabel(source.kind))}</span>
    <span class="pill">${escapeHtml(fileExtension(source, result))}</span>
    <span class="pill">${formatBytes(source.size)}</span>
    <span class="pill path-pill">${escapeHtml(path)}</span>
  `;
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
  setConfigView("tasks");
  await startBackgroundSync({ rootIds: [rootId], force: els.forceConvertInput.checked }, "目录同步任务已在后台运行。");
}

async function startBackgroundSync(body, startMessage) {
  if (isActiveJob(state.syncJob)) {
    setConfigView("tasks");
    setSummary("已有同步任务在后台运行。");
    return;
  }

  const queuedProgress = {
    phase: "queued",
    message: "提交同步任务。",
    processed: 0,
    total: 0,
    converted: 0,
    unchanged: 0,
    skipped: 0,
    removed: 0
  };
  state.syncJob = {
    id: "",
    type: "sync",
    status: "queued",
    progress: queuedProgress
  };
  showProgress(queuedProgress, state.syncJob);
  updateSyncControls();

  try {
    const created = await api("/api/sync/jobs", {
      method: "POST",
      body
    });
    setSummary(startMessage);
    await handleSyncJob(created.job, { refreshCatalogOnDone: true });
  } catch (error) {
    state.syncJob = null;
    clearSyncPoll();
    updateSyncControls();
    setSummary(error.message || String(error));
    els.taskSummary.textContent = error.message || "同步任务提交失败。";
  }
}

async function restoreSyncJob() {
  let jobs = [];
  try {
    const data = await api("/api/jobs");
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    jobs = [];
  }

  const storedJobId = readStoredSyncJobId();
  let job = jobs.find(isActiveJob);
  if (!job && storedJobId) {
    job = jobs.find((item) => item.id === storedJobId);
    if (!job) {
      try {
        const data = await api(`/api/jobs/${encodeURIComponent(storedJobId)}`);
        job = data.job;
      } catch {
        job = null;
      }
    }
  }

  if (job) {
    await handleSyncJob(job, { refreshCatalogOnDone: isActiveJob(job) });
    return;
  }

  if (!state.syncJob) {
    clearStoredSyncJobId();
    resetSyncProgress();
  }
}

async function pollSyncJob(jobId, refreshCatalogOnDone) {
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    await handleSyncJob(data.job, { refreshCatalogOnDone });
  } catch (error) {
    clearSyncPoll();
    state.syncJob = null;
    clearStoredSyncJobId();
    updateSyncControls();
    els.taskSummary.textContent = error.message || "无法读取后台任务进度。";
  }
}

async function handleSyncJob(job, { refreshCatalogOnDone = false } = {}) {
  if (!job) return;
  state.syncJob = job;
  writeStoredSyncJobId(job.id);
  showProgress(job.progress, job);
  updateSyncControls();

  if (isActiveJob(job)) {
    scheduleSyncPoll(job.id, refreshCatalogOnDone);
    return;
  }

  clearSyncPoll();
  if (job.status === "completed") {
    if (refreshCatalogOnDone) {
      await loadAll();
    }
    return;
  }

  if (job.status === "failed") {
    setSummary(job.error || job.progress?.message || "同步失败。");
  }
}

function scheduleSyncPoll(jobId, refreshCatalogOnDone) {
  clearSyncPoll();
  state.syncPollTimer = window.setTimeout(() => {
    void pollSyncJob(jobId, refreshCatalogOnDone);
  }, 900);
}

function clearSyncPoll() {
  if (!state.syncPollTimer) return;
  window.clearTimeout(state.syncPollTimer);
  state.syncPollTimer = null;
}

function showProgress(progress, job = state.syncJob) {
  els.progressWrap.hidden = false;
  const statusText = job?.status === "completed" ? "已完成" : job?.status === "failed" ? "失败" : "运行中";
  els.taskSummary.textContent = progress.message || `${statusText}：${phaseLabel(progress.phase) || "同步任务"}`;
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

function resetSyncProgress() {
  els.progressWrap.hidden = true;
  els.taskSummary.textContent = "当前没有运行中的同步任务。";
  els.syncProgress.value = 0;
  els.progressLabel.textContent = "准备中";
  els.progressPercent.textContent = "0%";
  els.progressStats.textContent = "";
  updateSyncControls();
}

function isActiveJob(job) {
  return job?.status === "queued" || job?.status === "running";
}

function updateSyncControls() {
  const active = isActiveJob(state.syncJob);
  els.syncButton.disabled = active;
  els.syncButton.textContent = active ? "同步运行中" : "同步全部目录";
  for (const button of document.querySelectorAll("[data-sync]")) {
    button.disabled = active;
  }
}

function readStoredSyncJobId() {
  try {
    return window.localStorage.getItem(syncJobStorageKey);
  } catch {
    return null;
  }
}

function writeStoredSyncJobId(jobId) {
  try {
    window.localStorage.setItem(syncJobStorageKey, jobId);
  } catch {
    // Local storage can be unavailable in restricted browser modes.
  }
}

function clearStoredSyncJobId() {
  try {
    window.localStorage.removeItem(syncJobStorageKey);
  } catch {
    // Local storage can be unavailable in restricted browser modes.
  }
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
      hybrid: "快速混合检索",
      deep: "智能检索"
    }[mode] || mode
  );
}

function sanitizeSearchNotice(message) {
  if (!message) return "";
  return String(message)
    .replaceAll("自然语言检索", "查询")
    .replaceAll("自然语言模式", "智能检索")
    .replaceAll("自然语言入口", "智能检索入口");
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
    updateSyncControls();
    if (els.statusText.textContent === label) els.statusText.textContent = previous || "就绪";
  }
}

function setDisabled(disabled) {
  for (const element of document.querySelectorAll("button, input, select, textarea")) {
    if (element.hasAttribute("data-stay-enabled")) continue;
    element.disabled = disabled;
  }
}

function openDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "open");
}

function closeDialog(dialog) {
  if (dialog.open && typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
}

function setConfigView(view = "general") {
  for (const item of els.configMenuItems) {
    const active = item.dataset.configView === view;
    item.classList.toggle("active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  }
  for (const panel of els.configPanels) {
    panel.classList.toggle("active", panel.dataset.configPanel === view);
  }
}

function setSelectValue(select, value) {
  const hasOption = Array.from(select.options).some((option) => option.value === value);
  if (!hasOption && value) {
    select.appendChild(new Option(value, value));
  }
  select.value = value;
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
      throw new Error("请求超时。当前查询会调用本地模型，首次加载可能较慢；请稍后重试或改用关键词。");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });
}

function kindLabel(kind) {
  return (
    {
      document: "文档",
      image: "图片",
      audio: "音频",
      video: "视频",
      archive: "压缩包",
      text: "文本",
      other: "文件"
    }[kind] || "文件"
  );
}

function isPreviewable(source = {}) {
  return source.kind === "image" || source.kind === "document" || source.kind === "text";
}

function isVisualDocument(source = {}) {
  if (source.kind !== "document") return false;
  return new Set(["DOC", "DOCX", "ODP", "ODS", "ODT", "PPT", "PPTX", "RTF", "XLS", "XLSX"]).has(fileExtension(source));
}

function fileExtension(source = {}, result = {}) {
  const explicit = source.sourceExt ? String(source.sourceExt).replace(/^\./, "") : "";
  if (explicit) return explicit.toUpperCase();
  const path = String(result.displayPath ?? result.title ?? "");
  const match = path.match(/\.([^./\\]+)$/);
  return match ? match[1].toUpperCase() : "FILE";
}

function safeClass(value) {
  return String(value ?? "other")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "") || "other";
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
