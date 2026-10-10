/** Normalize QA-only labels without altering non-whitespace characters. */
export function normalizeQaLabel(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}
