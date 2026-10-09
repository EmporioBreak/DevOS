# DevOS brainstorming — approval before execution

Issue #133, DevOS 2. This is a **DevOS adaptation** of upstream
Superpowers `brainstorming`, NOT a replacement of the original vendor
skill. Original SHA-256 and MIT attribution live in
`skills/devos-brainstorming/SOURCE.md`, upstream reference is pinned
in `config/devos-upstreams.lock.json`.

## Owner dialogue vs worker continuation

A new **spike** approves a narrow question and probe; a **bounded**
request approves a short design in chat/Issue; an **architectural**
request approves the written Spec Kit feature specification and
implementation plan before production work starts.

The main agent checks the actual user messages and the exact Git
revision of relevant documents. **A serialized document or test
fixture does not prove the owner approved anything.** An ordinary
ChatGPT worker should not collect a second confirmation for scope
approved earlier by the Main Agent.

When an in-flight task discovers materially new requirements, risk
or conflicting constraints, it reports a blocker and returns the
specific decision to Main Agent instead of extending its own scope.
The original DevOS worker graph and active PR remain unchanged
until Main Agent chooses a permitted continuation.

DevOS Main Agent owns overall Epic / Issue decomposition, product
design, execution approval and final acceptance. **DevOS Runner**
only executes one already planned Issue's frozen worker graph.
Spec Kit remains the source of truth for
`spec.md`, `plan.md`, `tasks.md` with exact revision links;
`devos-writing-plans` enriches those files without duplication.

The original Superpowers browser visual-companion tooling is not
started automatically. Where a visual design is actually required,
choose appropriate existing visual capabilities explicitly.

## Verification

`npm run build` and the focused three-file test suite
`tsx --test tests/{devos-brainstorming,devos-writing-plans,skills-library}.test.ts`
cover 15 pinned originals plus two separately pinned adaptations
(17 skills total), immutable original brainstorming SHA, approval
gate wording and synthetic spike/bounded/architectural examples.
These tests establish **method/manifest compliance**, not independent
proof of an actual human authorization flow. A real Main Agent
predevelopment→Runner integration test remains in #128/#143/#144.
