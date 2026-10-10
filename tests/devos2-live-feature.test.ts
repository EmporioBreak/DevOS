import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeQaLabel } from './fixtures/devos2-live-feature/normalize-qa-label.js';

const cases: Array<[string, string, string]> = [
  ['collapses mixed whitespace', '  Alpha \t  Beta\n', 'Alpha Beta'],
  ['whitespace only', '\t\n ', ''],
  ['preserves Cyrillic and emoji', ' Ёж \t 🦊 ', 'Ёж 🦊'],
  ['leaves clean labels unchanged', 'Alpha', 'Alpha'],
  ['handles empty input', '', ''],
  ['handles nonbreaking and Unicode spaces', '\u00a0A\u2003\u202fB\u00a0', 'A B'],
  ['preserves combining marks and punctuation', '  e\u0301 ! \t 🦊  ', 'e\u0301 ! 🦊'],
  ['does not strip zero-width format characters', '\u200bA\u200b', '\u200bA\u200b'],
];

for (const [name, input, expected] of cases) {
  test(name, () => assert.equal(normalizeQaLabel(input), expected));
}
