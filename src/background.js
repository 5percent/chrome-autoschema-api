import {
  addSample,
  buildApiKey,
  inferSchema,
  mergeSchema,
  toDomain,
  tryJsonParse,
} from "./schema.js";
import {
  clearData,
  defaultConfig,
  getConfig,
  getData,
  saveConfig,
  updateData,
} from "./storage.js";

const DEBUGGER_VERSION = "1.3";
const MAX_TRACKED_TABS = 10;

const attachedTabs = new Set();
const requestMetaById = new Map();
const STATIC_EXT_RE =
  /\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|map|mp4|webm|mp3|wav|pdf|zip)(?:$|\?)/i;
const STATIC_RESOURCE_TYPES = new Set([
  "Image",
  "Stylesheet",
  "Font",
  "Media",
  "Script",
]);

async function configureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("setPanelBehavior failed", error);
  }
}

function shouldTrackUrl(urlString) {
  return /^https?:\/\//i.test(urlString || "");
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

function matchDomain(hostname, list) {
  const host = String(hostname || "").toLowerCase();
  return list.some((rule) => host === rule || host.endsWith(`.${rule}`));
}

function isStaticResource(urlString, resourceType) {
  if (STATIC_RESOURCE_TYPES.has(resourceType)) return true;
  return STATIC_EXT_RE.test(String(urlString || ""));
}

async function shouldCaptureRequest(urlString, resourceType) {
  if (!shouldTrackUrl(urlString)) return false;

  const config = {
    ...defaultConfig,
    ...(await getConfig()),
  };

  if (!config.enabled) return false;
  if (config.onlyXhrFetch && !["XHR", "Fetch"].includes(resourceType)) {
    return false;
  }
  if (config.ignoreStatic && isStaticResource(urlString, resourceType)) {
    return false;
  }

  const domain = toDomain(urlString);
  const whitelist = normalizeDomainList(config.whitelistDomains);

  // Whitelist-only mode: empty whitelist means capture nothing.
  if (whitelist.length === 0) {
    return false;
  }
  if (!matchDomain(domain, whitelist)) {
    return false;
  }

  return true;
}

async function shouldStoreRequestMeta(urlString) {
  if (!shouldTrackUrl(urlString)) return false;

  const config = {
    ...defaultConfig,
    ...(await getConfig()),
  };

  if (!config.enabled) return false;

  const domain = toDomain(urlString);
  const whitelist = normalizeDomainList(config.whitelistDomains);

  if (whitelist.length === 0) {
    return false;
  }
  if (!matchDomain(domain, whitelist)) {
    return false;
  }

  return true;
}

function toMcpSchema(data) {
  const domains = Object.values(data?.domains || {});
  return {
    format: "chrome-mcp-site-schema",
    generatedAt: new Date().toISOString(),
    source: "AutoSchema API Collector",
    sites: domains.map((domainBucket) => {
      const operations = Object.entries(domainBucket.apis || {}).map(
        ([apiKey, api]) => ({
          id: `${domainBucket.domain}::${apiKey}`,
          name: `${api.method} ${api.pathTemplate}`,
          domain: domainBucket.domain,
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
          agentGuide: `When calling ${api.method} ${api.pathTemplate} on ${domainBucket.domain}, follow requestSchema and parse responseSchema.`,
        }),
      );

      return {
        domain: domainBucket.domain,
        capturedAt: domainBucket.capturedAt,
        operationCount: operations.length,
        operations,
      };
    }),
  };
}

async function ensureTabAttached(tabId) {
  if (attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    attachedTabs.add(tabId);
  } catch (error) {
    console.warn("attach debugger failed", tabId, error);
  }
}

async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    console.warn("detach debugger failed", tabId, error);
  }
  attachedTabs.delete(tabId);
}

async function trimTrackedTabs() {
  if (attachedTabs.size <= MAX_TRACKED_TABS) return;
  const overflowCount = attachedTabs.size - MAX_TRACKED_TABS;
  const toDetach = Array.from(attachedTabs).slice(0, overflowCount);
  await Promise.all(toDetach.map((tabId) => detachTab(tabId)));
}

function getOrCreateApiBucket(
  domainBucket,
  apiKey,
  method,
  path,
  pathTemplate,
) {
  if (!domainBucket.apis[apiKey]) {
    domainBucket.apis[apiKey] = {
      method,
      path,
      pathTemplate,
      statuses: {},
      requestSchema: null,
      responseSchema: null,
      sampleRequests: [],
      sampleResponses: [],
      count: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
  }
  return domainBucket.apis[apiKey];
}

function parsePostData(postData) {
  if (!postData) return undefined;
  const parsed = tryJsonParse(postData);
  if (parsed.ok) return parsed.data;
  return { raw: String(postData).slice(0, 2000) };
}

function getRequestMapKey(tabId, requestId) {
  return `${tabId}:${requestId}`;
}

async function shouldPersistCapturedRequest(meta) {
  return shouldCaptureRequest(meta?.url, meta?.resourceType);
}

async function upsertApiRecord(meta, responsePayload) {
  if (!meta || !shouldTrackUrl(meta.url)) return;

  await updateData(async (data) => {
    const url = new URL(meta.url);
    const domain = toDomain(meta.url);
    const path = url.pathname || "/";
    const pathTemplate = buildApiKey(meta.method, meta.url).replace(
      `${meta.method.toUpperCase()} `,
      "",
    );
    const apiKey = `${meta.method.toUpperCase()} ${pathTemplate}`;

    if (!data.domains[domain]) {
      data.domains[domain] = {
        domain,
        capturedAt: new Date().toISOString(),
        apis: {},
      };
    }

    const bucket = getOrCreateApiBucket(
      data.domains[domain],
      apiKey,
      meta.method.toUpperCase(),
      path,
      pathTemplate,
    );
    bucket.count += 1;
    bucket.lastSeen = new Date().toISOString();
    bucket.statuses[
      String(meta.status || responsePayload?.status || "unknown")
    ] =
      (bucket.statuses[
        String(meta.status || responsePayload?.status || "unknown")
      ] || 0) + 1;

    const requestBody = parsePostData(meta.postData);
    if (requestBody !== undefined) {
      bucket.sampleRequests = addSample(bucket.sampleRequests, requestBody);
      bucket.requestSchema = mergeSchema(
        bucket.requestSchema,
        inferSchema(requestBody),
      );
    }

    const responseBody = responsePayload?.body;
    if (responseBody !== undefined) {
      const parsed = tryJsonParse(responseBody);
      const schemaSource = parsed.ok
        ? parsed.data
        : { raw: String(responseBody).slice(0, 2000) };
      bucket.sampleResponses = addSample(bucket.sampleResponses, schemaSource);
      bucket.responseSchema = mergeSchema(
        bucket.responseSchema,
        inferSchema(schemaSource),
      );
    }

    return data;
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url || tab.url;
  const shouldAttach =
    changeInfo.status === "loading" ||
    changeInfo.status === "complete" ||
    !!changeInfo.url;

  if (!shouldAttach) return;
  if (!shouldTrackUrl(nextUrl)) return;
  await ensureTabAttached(tabId);
  await trimTrackedTabs();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && shouldTrackUrl(tab.url)) {
      await ensureTabAttached(tabId);
      await trimTrackedTabs();
    }
  } catch (error) {
    console.warn("onActivated tabs.get failed", error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachTab(tabId);
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (!tabId || !attachedTabs.has(tabId)) return;
  const requestKey = getRequestMapKey(tabId, params.requestId);

  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    const resourceType = params.type || "Other";
    const capture = await shouldStoreRequestMeta(request.url);
    if (!capture) return;

    requestMetaById.set(requestKey, {
      tabId,
      url: request.url,
      method: request.method || "GET",
      postData: request.postData,
      resourceType,
      timestamp: Date.now(),
    });
  }

  if (method === "Network.responseReceived") {
    const meta = requestMetaById.get(requestKey);
    if (!meta) return;
    meta.status = params.response?.status;
    meta.resourceType = params.type || meta.resourceType;
  }

  if (method === "Network.loadingFinished") {
    const meta = requestMetaById.get(requestKey);
    if (!meta) return;

    if (!(await shouldPersistCapturedRequest(meta))) {
      requestMetaById.delete(requestKey);
      return;
    }

    let responseBody;
    try {
      const response = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId: params.requestId },
      );

      if (response?.base64Encoded) {
        responseBody = atob(response.body || "");
      } else {
        responseBody = response?.body;
      }
    } catch (error) {
      responseBody = undefined;
    }

    await upsertApiRecord(meta, { body: responseBody });
    requestMetaById.delete(requestKey);
  }

  if (method === "Network.loadingFailed") {
    const meta = requestMetaById.get(requestKey);
    if (!meta) return;

    meta.status = params.errorText || meta.status || "failed";
    meta.resourceType = params.type || meta.resourceType;

    if (await shouldPersistCapturedRequest(meta)) {
      await upsertApiRecord(meta, {
        status: params.errorText || "failed",
      });
    }

    requestMetaById.delete(requestKey);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await configureSidePanelBehavior();
  await getConfig().then((config) =>
    saveConfig({ ...defaultConfig, ...config }),
  );
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && shouldTrackUrl(tab.url)) {
      await ensureTabAttached(tab.id);
    }
  }
  await trimTrackedTabs();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (error) {
    console.warn("open side panel failed", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "autoschema:get-status") {
    getConfig().then((config) => {
      const whitelist = normalizeDomainList(config.whitelistDomains);
      sendResponse({
        trackedTabs: attachedTabs.size,
        enabled: !!config.enabled,
        whitelistCount: whitelist.length,
      });
    });
    return true;
  }

  if (message?.type === "autoschema:clear") {
    clearData().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "autoschema:export") {
    getData().then((data) => sendResponse({ ok: true, data }));
    return true;
  }

  if (message?.type === "autoschema:export-mcp") {
    getData().then((data) =>
      sendResponse({ ok: true, data: toMcpSchema(data) }),
    );
    return true;
  }

  if (message?.type === "autoschema:get-config") {
    getConfig().then((config) => sendResponse({ ok: true, config }));
    return true;
  }

  if (message?.type === "autoschema:update-config") {
    saveConfig(message?.patch || {}).then((config) =>
      sendResponse({ ok: true, config }),
    );
    return true;
  }

  if (message?.type === "autoschema:toggle-enabled") {
    getConfig()
      .then((config) => saveConfig({ enabled: !config.enabled }))
      .then((config) => sendResponse({ ok: true, config }));
    return true;
  }
});
