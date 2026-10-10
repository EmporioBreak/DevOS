// Baseline defect: silently truncates valid user input before checking length.
export function normalizeQuery(value) { return value.trim().slice(0, 3); }
