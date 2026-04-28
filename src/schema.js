const MAX_SAMPLES = 5;

function classifyValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function emptySchema(type) {
  if (type === "object")
    return { type: "object", properties: {}, required: [] };
  if (type === "array") return { type: "array", items: {} };
  return { type };
}

export function inferSchema(value) {
  const type = classifyValue(value);
  const schema = emptySchema(type);

  if (type === "object") {
    const keys = Object.keys(value);
    schema.required = keys;
    for (const key of keys) {
      schema.properties[key] = inferSchema(value[key]);
    }
    return schema;
  }

  if (type === "array") {
    if (value.length === 0) {
      schema.items = { type: "unknown" };
      return schema;
    }

    let merged = inferSchema(value[0]);
    for (let i = 1; i < value.length; i += 1) {
      merged = mergeSchema(merged, inferSchema(value[i]));
    }
    schema.items = merged;
    return schema;
  }

  return schema;
}

function mergeRequired(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((key) => rightSet.has(key));
}

function dedupeTypes(types) {
  const flat = [];
  for (const t of types) {
    if (!t) continue;
    if (Array.isArray(t)) {
      flat.push(...t);
    } else {
      flat.push(t);
    }
  }
  return Array.from(new Set(flat));
}

export function mergeSchema(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aType = a.type;
  const bType = b.type;

  if (aType !== bType) {
    return { type: dedupeTypes([aType, bType]) };
  }

  if (aType === "object") {
    const result = {
      type: "object",
      properties: { ...a.properties },
      required: mergeRequired(a.required, b.required),
    };

    for (const [key, schema] of Object.entries(b.properties || {})) {
      result.properties[key] = mergeSchema(result.properties[key], schema);
    }

    return result;
  }

  if (aType === "array") {
    return {
      type: "array",
      items: mergeSchema(a.items, b.items),
    };
  }

  return { type: aType };
}

function normalizePathname(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  const normalized = segments.map((segment) => {
    if (/^[0-9]+$/.test(segment)) return ":id";
    if (/^[0-9a-fA-F-]{16,}$/.test(segment)) return ":token";
    return segment;
  });
  return `/${normalized.join("/")}`;
}

export function buildApiKey(method, urlString) {
  const url = new URL(urlString);
  return `${method.toUpperCase()} ${normalizePathname(url.pathname || "/")}`;
}

export function toDomain(urlString) {
  return new URL(urlString).hostname;
}

export function addSample(target, value) {
  if (value === undefined) return target;
  const next = Array.isArray(target) ? [...target] : [];
  if (next.length >= MAX_SAMPLES) return next;
  next.push(value);
  return next;
}

export function tryJsonParse(raw) {
  if (raw === undefined || raw === null) return { ok: false };
  if (typeof raw !== "string") return { ok: true, data: raw };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };

  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}
