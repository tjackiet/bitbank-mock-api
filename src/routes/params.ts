export function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
