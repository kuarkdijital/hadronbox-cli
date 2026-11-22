export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

/** Narrows a parsed JSON value to an object; throws (→ UNEXPECTED_RESPONSE in the API client) otherwise. */
export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) throw new Error('expected a JSON object');
  // isRecord + isJsonValue together prove the object shape; TS cannot intersect the two guards by itself.
  return value as JsonObject;
}
