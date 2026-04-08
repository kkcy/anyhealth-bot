const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a value is a real UUID. Returns an error string if invalid, null if valid.
 * Use inside tool execute() so the LLM gets a clear, actionable error instead of a raw Zod rejection.
 */
export function validateUuid(value: string | undefined, fieldName: string, source: string): string | null {
  if (!value) return null; // let optionality be handled by Zod
  if (!UUID_RE.test(value)) {
    return `Invalid ${fieldName}: "${value}" is not a valid UUID. Use the exact UUID returned by ${source} (e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890").`;
  }
  return null;
}

/**
 * Validate multiple UUID fields at once. Returns a JSON error string if any are invalid, null if all valid.
 */
export function validateUuids(fields: Array<{ value: string | undefined; name: string; source: string }>): string | null {
  for (const f of fields) {
    const err = validateUuid(f.value, f.name, f.source);
    if (err) return JSON.stringify({ error: err });
  }
  return null;
}
