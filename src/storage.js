const STORAGE_KEY = "autoschemaData";
const CONFIG_KEY = "autoschemaConfig";

const defaultData = {
  version: 1,
  updatedAt: new Date().toISOString(),
  domains: {},
};

export const defaultConfig = {
  enabled: false,
  onlyXhrFetch: true,
  ignoreStatic: true,
  whitelistDomains: [],
};

export async function getData() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || structuredClone(defaultData);
}

export async function saveData(data) {
  data.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

export async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return {
    ...defaultConfig,
    ...(stored[CONFIG_KEY] || {}),
  };
}

export async function saveConfig(configPatch) {
  const current = await getConfig();
  const next = {
    ...current,
    ...(configPatch || {}),
  };
  next.whitelistDomains = Array.isArray(next.whitelistDomains)
    ? next.whitelistDomains
    : [];
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

export async function clearData() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export function getStorageKey() {
  return STORAGE_KEY;
}
