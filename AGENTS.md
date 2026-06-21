# OmniSheet Agent Instructions

After any OmniSheet feature or UI change, use the Agent QA loop before final handoff unless the user explicitly asks to skip it. The loop is not just automated tests: it must include a feature-focused desktop click pass with Computer Use for user-facing changes.

From `app/`:

1. Run `npm run agent:check`.
2. Run `npm run agent:browser`.
3. For any user-facing feature, workflow, or layout change, run `npm run agent:tauri`, attach to the real `OmniSheet` desktop window with Computer Use, and follow `docs/agent-qa-loop.md`.

`npm run agent:tauri` must use the isolated QA database configured by `app/scripts/agent-tauri-dev.mjs`; never run Agent QA reset against the normal OmniSheet app data database.

Before the desktop pass, derive a short changed-feature checklist from the user request and the code diff. The checklist should name the changed feature, the affected view or panel, the expected behavior, and the specific clicks/typing/resizing needed to prove it works. In the desktop pass, verify that checklist first, then do the general smoke navigation.

When a feature introduces or changes a user-facing workflow, update `app/tests/agent/agent-smoke.spec.ts` with at least one focused assertion for that workflow. Prefer scoped locators and stable test ids over broad page text so sidebar/dashboard content does not make assertions ambiguous.

Final responses should state which parts of the loop ran, the changed-feature desktop interactions completed, what was verified, and any remaining risk or skipped step. If Computer Use was not run for a user-facing change, call that out as an incomplete QA pass.
