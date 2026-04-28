const apiListEl = document.getElementById("apiList");
const summaryEl = document.getElementById("summary");
const currentHostEl = document.getElementById("currentHost");
const toggleEnabledBtn = document.getElementById("toggleEnabled");
const toggleXhrFetchBtn = document.getElementById("toggleXhrFetch");
const toggleIgnoreStaticBtn = document.getElementById("toggleIgnoreStatic");
const apiSearchInputEl = document.getElementById("apiSearch");

let latestData = null;
let latestConfig = null;
let activeDomain = null;
let currentHost = null;
const expandedApiKeys = new Set();
let refreshTimer = null;
let apiSearchKeyword = "";

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function makeDownload(filename, contentObj) {
  const blob = new Blob([prettyJson(contentObj)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    {
      url,
      filename,
      saveAs: true,
    },
    () => {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  );
}

function normalizeDomainList(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) =>
      String(item || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function isHostWhitelisted(config, host) {
  if (!host) return false;
  const whitelist = new Set(normalizeDomainList(config?.whitelistDomains));
  return whitelist.has(String(host).toLowerCase());
}

function setToggleState(button, on) {
  button.classList.toggle("active", !!on);
}

function renderConfig() {
  const config = latestConfig || {};
  const hostInWhitelist = isHostWhitelisted(config, currentHost);

  setToggleState(toggleEnabledBtn, hostInWhitelist && !!config.enabled);
  setToggleState(toggleXhrFetchBtn, !!config.onlyXhrFetch);
  setToggleState(toggleIgnoreStaticBtn, !!config.ignoreStatic);

  currentHostEl.textContent = currentHost || "未识别";
}

function renderSummary() {
  const allDomains = latestData?.domains || {};
  const hostBucket = currentHost ? allDomains[currentHost] : null;
  const apiCount = Object.keys(hostBucket?.apis || {}).length;
  const filteredCount = getFilteredEntries(hostBucket?.apis || {}).length;
  summaryEl.textContent = currentHost
    ? `当前 Host: ${currentHost} | ${filteredCount}/${apiCount} 个 API`
    : "无法识别当前页面 Host";
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getFilteredEntries(apis) {
  const keyword = normalizeSearchText(apiSearchKeyword);
  const entries = Object.entries(apis || {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  if (!keyword) {
    return entries;
  }

  return entries.filter(([apiKey, item]) => {
    const searchable = [
      apiKey,
      item?.method,
      item?.path,
      item?.pathTemplate,
      Object.keys(item?.statuses || {}).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return searchable.includes(keyword);
  });
}

function renderApiList() {
  apiListEl.innerHTML = "";
  if (!currentHost) {
    apiListEl.innerHTML = "<p>当前标签页不是可采集网页。</p>";
    return;
  }

  activeDomain = currentHost;
  if (!activeDomain || !latestData?.domains?.[activeDomain]) {
    apiListEl.innerHTML = "<p>当前 Host 暂无采集数据。</p>";
    return;
  }

  const apis = latestData.domains[activeDomain].apis || {};
  const entries = getFilteredEntries(apis);

  if (Object.keys(apis).length === 0) {
    apiListEl.innerHTML = "<p>该域名下暂无 API 数据。</p>";
    return;
  }

  if (entries.length === 0) {
    apiListEl.innerHTML = `<p>没有匹配 “${apiSearchKeyword}” 的 API。</p>`;
    return;
  }

  for (const [apiKey, item] of entries) {
    const box = document.createElement("div");
    box.className = "api-item";
    const expanded = expandedApiKeys.has(apiKey);
    const schemaBlock = expanded
      ? `<aside class="schema-pane"><pre>${prettyJson({
          requestSchema: item.requestSchema,
          responseSchema: item.responseSchema,
        })}</pre></aside>`
      : "";

    box.innerHTML = `
      <div class="api-main">
        <div class="api-head">
          <div><span class="tag">${item.method}</span> <strong>${item.pathTemplate}</strong></div>
          <div class="api-actions">
            <button class="ghost toggle-schema" data-api-key="${apiKey}">${expanded ? "收起 Schema" : "查看 Schema"}</button>
          </div>
        </div>
        <div class="muted">采集次数: ${item.count} | 最近: ${new Date(item.lastSeen).toLocaleString()}</div>
        <div class="muted">状态码分布: ${Object.keys(item.statuses || {}).join(", ") || "无"}</div>
      </div>
      ${schemaBlock}
    `;
    apiListEl.appendChild(box);
  }

  apiListEl.querySelectorAll(".toggle-schema").forEach((btn) => {
    btn.addEventListener("click", () => {
      const apiKey = btn.getAttribute("data-api-key");
      if (!apiKey) return;
      if (expandedApiKeys.has(apiKey)) {
        expandedApiKeys.delete(apiKey);
      } else {
        expandedApiKeys.add(apiKey);
      }
      renderApiList();
    });
  });
}

function buildCurrentDomainMcpPayload(domain, domainBucket) {
  const operations = Object.entries(domainBucket?.apis || {}).map(
    ([apiKey, api]) => ({
      id: `${domain}::${apiKey}`,
      name: `${api.method} ${api.pathTemplate}`,
      domain,
      method: api.method,
      pathTemplate: api.pathTemplate,
      requestSchema: api.requestSchema,
      responseSchema: api.responseSchema,
      examples: {
        requests: api.sampleRequests || [],
        responses: api.sampleResponses || [],
      },
      stats: {
        count: api.count || 0,
        statuses: api.statuses || {},
        lastSeen: api.lastSeen,
      },
      agentGuide: `When calling ${api.method} ${api.pathTemplate} on ${domain}, follow requestSchema and parse responseSchema.`,
    }),
  );

  return {
    format: "chrome-mcp-site-schema",
    generatedAt: new Date().toISOString(),
    source: "AutoSchema API Collector",
    sites: [
      {
        domain,
        capturedAt: domainBucket?.capturedAt,
        operationCount: operations.length,
        operations,
      },
    ],
  };
}

async function loadCurrentHost() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const activeTab = tabs[0];
  const urlString = activeTab?.url || "";

  if (!/^https?:\/\//i.test(urlString)) {
    currentHost = null;
    activeDomain = null;
    return;
  }

  const nextHost = new URL(urlString).hostname;
  if (nextHost !== currentHost) {
    expandedApiKeys.clear();
  }
  currentHost = nextHost;
  activeDomain = nextHost;
}

async function loadConfig() {
  const response = await chrome.runtime.sendMessage({
    type: "autoschema:get-config",
  });
  latestConfig = response?.config || {};
  renderConfig();
}

async function saveConfigPatch(patch) {
  const response = await chrome.runtime.sendMessage({
    type: "autoschema:update-config",
    patch,
  });
  latestConfig = response?.config || { ...latestConfig, ...patch };
  renderConfig();
}

async function toggleCurrentHostCapture() {
  if (!currentHost) {
    alert("当前标签页无法识别 Host");
    return;
  }

  const whitelist = new Set(
    normalizeDomainList(latestConfig?.whitelistDomains),
  );
  const host = String(currentHost).toLowerCase();
  if (whitelist.has(host)) {
    whitelist.delete(host);
  } else {
    whitelist.add(host);
  }

  const nextWhitelist = Array.from(whitelist);
  await saveConfigPatch({
    whitelistDomains: nextWhitelist,
    enabled: nextWhitelist.length > 0,
  });
}

async function loadData() {
  const response = await chrome.runtime.sendMessage({
    type: "autoschema:export",
  });
  latestData = response?.data || { domains: {} };
  renderSummary();
  renderApiList();
}

async function refreshForActiveTab() {
  await loadCurrentHost();
  renderConfig();
  await loadData();
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshForActiveTab();
  }, 120);
}

toggleEnabledBtn.addEventListener("click", toggleCurrentHostCapture);

toggleXhrFetchBtn.addEventListener("click", async () => {
  await saveConfigPatch({ onlyXhrFetch: !latestConfig?.onlyXhrFetch });
});

toggleIgnoreStaticBtn.addEventListener("click", async () => {
  await saveConfigPatch({ ignoreStatic: !latestConfig?.ignoreStatic });
});

document.getElementById("refresh").addEventListener("click", async () => {
  await refreshForActiveTab();
});

apiSearchInputEl?.addEventListener("input", () => {
  apiSearchKeyword = apiSearchInputEl.value || "";
  renderSummary();
  renderApiList();
});

chrome.tabs.onActivated.addListener(() => {
  scheduleRefresh();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab?.active) return;
  if (changeInfo.status === "complete" || changeInfo.url) {
    scheduleRefresh();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleRefresh();
  }
});

document.getElementById("exportSelectedJson").addEventListener("click", () => {
  if (!activeDomain || !latestData?.domains?.[activeDomain]) {
    alert("当前没有可导出的域名组");
    return;
  }

  const payload = {
    version: latestData.version,
    updatedAt: latestData.updatedAt,
    domain: activeDomain,
    apis: latestData.domains[activeDomain].apis,
  };

  makeDownload(`autoschema-${activeDomain}-${Date.now()}.json`, payload);
});

document.getElementById("exportSelectedMcp").addEventListener("click", () => {
  if (!activeDomain || !latestData?.domains?.[activeDomain]) {
    alert("当前没有可导出的域名组");
    return;
  }

  const payload = buildCurrentDomainMcpPayload(
    activeDomain,
    latestData.domains[activeDomain],
  );

  makeDownload(`autoschema-${activeDomain}-mcp-${Date.now()}.json`, payload);
});

async function init() {
  await loadCurrentHost();
  await loadConfig();
  await loadData();
}

init();
