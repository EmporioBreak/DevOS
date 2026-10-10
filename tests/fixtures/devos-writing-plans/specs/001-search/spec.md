# Feature Specification: Query Search

**User Story US1:** Search normalized terms. If input is whitespace only,
return an empty set. Reject input over 200 characters with a validation error.

**Success Criteria:** Deterministic results from the same inputs and
no silent truncation; empty query is handled explicitly.
