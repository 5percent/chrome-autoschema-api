const STORAGE_KEY = "autoschemaData";
const CONFIG_KEY = "autoschemaConfig";
const DB_NAME = "autoschema-db";
const DB_VERSION = 1;
const STORE_NAME = "kv";
let storageMutationQueue = Promise.resolve();
let dbPromise = null;
let migrationPromise = null;

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

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return dbPromise;
}

async function readRecord(key) {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const record = await requestToPromise(store.get(key));
  await transactionDone(transaction);
  return record?.value;
}

async function writeRecord(key, value) {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.put({ key, value });
  await transactionDone(transaction);
}

async function deleteRecord(key) {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.delete(key);
  await transactionDone(transaction);
}

async function ensureDataMigrated() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const existing = await readRecord(STORAGE_KEY);
      if (existing) {
        return;
      }

      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const legacyData = stored[STORAGE_KEY];
      if (!legacyData) {
        return;
      }

      await writeRecord(STORAGE_KEY, legacyData);
      await chrome.storage.local.remove(STORAGE_KEY);
    })();
  }

  return migrationPromise;
}

export async function getData() {
  await ensureDataMigrated();
  const stored = await readRecord(STORAGE_KEY);
  return stored || structuredClone(defaultData);
}

function enqueueStorageMutation(operation) {
  const nextOperation = storageMutationQueue.then(operation, operation);
  storageMutationQueue = nextOperation.then(
    () => undefined,
    () => undefined,
  );
  return nextOperation;
}

export async function saveData(data) {
  await enqueueStorageMutation(async () => {
    await ensureDataMigrated();
    data.updatedAt = new Date().toISOString();
    await writeRecord(STORAGE_KEY, data);
  });
}

export async function updateData(updater) {
  return enqueueStorageMutation(async () => {
    await ensureDataMigrated();
    const current = await getData();
    const next = (await updater(current)) || current;
    next.updatedAt = new Date().toISOString();
    await writeRecord(STORAGE_KEY, next);
    return next;
  });
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
  await enqueueStorageMutation(async () => {
    await ensureDataMigrated();
    await deleteRecord(STORAGE_KEY);
  });
}

export function getStorageKey() {
  return STORAGE_KEY;
}
