# Dependency security debt

Last reviewed: 2026-10-07.

## Direct Desktop Commander status

DevOS pins `@wonderwhy-er/desktop-commander@0.2.52`.

Public advisory databases list historical direct Desktop Commander issues affecting older versions, including:

- CVE-2026-10691 / GHSA-r87g-78mx-3wg4: uncontrolled resource consumption, affected versions before 0.2.39, fixed in 0.2.39.
- CVE-2026-10690 / GHSA-5xx3-j724-wmx5: SSRF reported against 0.2.37-era code.

The pinned 0.2.52 version is newer than those affected direct-version ranges. Current public package scans do not report a direct vulnerability in 0.2.52.

References:
- https://github.com/advisories/GHSA-r87g-78mx-3wg4
- https://github.com/advisories/GHSA-5xx3-j724-wmx5
- https://security.snyk.io/package/npm/%40wonderwhy-er%2Fdesktop-commander/0.2.52

## Residual transitive debt

The checked-in lockfile still contains older transitive packages through Desktop Commander's `exceljs@4.4.0` dependency chain, including:

- `inflight@1.0.6`
- `rimraf@2.7.1`
- `fstream@1.0.12`
- nested `glob@7.2.3`

Those packages are not direct DevOS dependencies and are retained by the currently pinned upstream dependency graph. They are technical/security-maintenance debt even where a specific advisory is not directly reachable from DevOS usage.

Upstream context:
- https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/297

## Reachability

Desktop Commander is intentionally exposed by DevOS as privileged local tooling. Therefore dependency findings in Desktop Commander or code paths reachable through its file/process tools cannot be dismissed solely because they are transitive.

At the same time, historical findings against old Desktop Commander versions must not be reported as active direct vulnerabilities when the pinned version is outside the affected range.

## Upgrade policy

- Keep Desktop Commander pinned to an explicitly reviewed version.
- Do not apply unrelated `npm audit fix --force` upgrades.
- Prefer an upstream Desktop Commander release that removes or upgrades the legacy ExcelJS transitive chain once compatibility is confirmed.
- Any dependency version change must pass `npm run build && npm test` plus connector smoke coverage before merge.

## Fresh npm audit

A fresh `npm audit --json` run is required as part of release verification before claiming an exact current finding count.

The previous README count of 11 findings is intentionally not treated as timeless truth. Exact counts can change with the npm advisory database even when `package-lock.json` does not change.
