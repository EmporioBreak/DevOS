# Tasks: Query Search

**Input**: [spec.md](spec.md), [plan.md](plan.md)

## Phase 1: Foundational

- [ ] T001 [US1] Add `normalizeQuery(input: string): string` to `src/query-normalize.ts` with tests in `tests/query-normalize.test.ts`; run `npm test -- query-normalize.test.ts` and expect PASS

## Phase 2: User Story 1 — Query Search

**Independent Test:** `npm test -- search.service.test.ts`

**Interfaces:** T001 provides `normalizeQuery(input: string): string`;
T003 exports `search(query: string): SearchResult[]` for later tasks.

- [ ] T002 [US1] RED: Add `tests/search.service.test.ts` for whitespace-only input, >200 character validation and deterministic results; run and expect FAIL because `search` is missing
- [ ] T003 [US1] GREEN: Implement `search(query: string): SearchResult[]` in `src/search.service.ts`; run `npm test -- search.service.test.ts` and expect PASS
- [ ] T004 [US1] REFACTOR: simplify implementation, keep interfaces unchanged; rerun tests and expect PASS
