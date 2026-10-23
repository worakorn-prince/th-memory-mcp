import { filterSecrets } from "./capture-core.js";

const MAX_METADATA_DEPTH = 10;

export function redactSecrets(text: string): string {
  return filterSecrets(text);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_METADATA_DEPTH) return "[REDACTED]";
  if (ancestors.has(value)) return "[Circular]";

  if (Array.isArray(value)) {
    ancestors.add(value);
    const out = value.map((item) => redactValue(item, depth + 1, ancestors));
    ancestors.delete(value);
    return out;
  }

  if (!isPlainObject(value)) {
    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(value));
    } catch {
      return "[REDACTED]";
    }
    return redactValue(serialized, depth + 1, ancestors);
  }

  ancestors.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[redactSecrets(key)] = redactValue(item, depth + 1, ancestors);
  }
  ancestors.delete(value);
  return out;
}

export function redactMetadata(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}
