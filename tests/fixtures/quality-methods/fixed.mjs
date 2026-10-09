// Minimal root-cause fix: validation happens before normalization; no truncation.
export function normalizeQuery(value) {
  if (typeof value !== "string" || value.length > 10) {
    throw new RangeError("Query exceeds 10 characters");
  }
  return value.trim();
}
