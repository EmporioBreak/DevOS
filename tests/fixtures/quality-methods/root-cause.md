# Debugging evidence (synthetic fixture only)

Symptom: `normalizeQuery("hello")` returned `"hel"`.
Reproducer: run query.test.mjs using buggy.mjs; expect two failing assertions.
Root cause: a `.slice(0,3)` truncation is performed before any validation.
Incorrect suggestion: accept truncated input and update the test.
Correct change: validate input length explicitly and return the untruncated
normalized value. Verify two tests pass against fixed.mjs.
This fixture is not a claim of a production bugfix or a real code-review approval.

Review feedback example: a reviewer suggests removing the length guard for
speed. Evaluate the claim against the accepted 10-character constraint and
reject it with evidence; accept the valid suggestion to test the error case.
