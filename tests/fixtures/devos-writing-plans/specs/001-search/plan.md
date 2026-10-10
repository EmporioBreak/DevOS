# Implementation Plan: Query Search

**Branch**: `task/201-search` | **Spec**: [spec.md](spec.md)

## Summary

Implement a pure in-memory `search(query: string): SearchResult[]` function,
based on the approved spec. No external database or background worker.

## Technical Context

**Language/Version**: TypeScript 5.9
**Testing**: Node Test Runner
**Constraints**: Never truncate queries silently

## Constitution Check

PASS: Single isolated testable workstream. No new executor.

## Project Structure

- Modify: `src/search.service.ts` — exported `search`
- Test: `tests/search.service.test.ts` — empty/long inputs
- Consume: `normalizeQuery(input: string): string` from T001

## Review Focus

- Whitespace-only query returns []
- Input over 200 characters throws ValidationError
- Valid repeated query returns deterministic results
