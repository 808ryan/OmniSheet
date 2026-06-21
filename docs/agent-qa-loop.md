# OmniSheet Agent QA Loop

Use this loop after feature work so the agent verifies OmniSheet instead of handing manual testing back to Ryan. The loop has two layers:

- Automated checks: `agent:check` and `agent:browser`.
- Desktop interaction: Codex uses Computer Use to click, type, inspect, and resize the real Tauri app.

For user-facing work, the desktop interaction layer is required. `npm run agent:qa` by itself is not the complete QA loop.

## Local Commands

Run commands from `app/`.

- `npm run agent:check`: frontend lint, frontend build, and Rust tests.
- `npm run agent:browser`: Playwright smoke tests against Vite with `VITE_OMNISHEET_AGENT_MOCK=1`.
- `npm run agent:tauri`: launches `npm run tauri dev` with `OMNISHEET_AGENT_QA=1`, `OMNISHEET_AGENT_QA_RESET=1`, and `OMNISHEET_DATABASE_PATH=.codex/agent-qa/omnisheet-agent-qa.db`, writing logs under `.codex/logs/`.
- `npm run agent:qa`: runs `agent:check` and `agent:browser`.

## Agent QA Data

Desktop Agent QA startup resets an isolated QA SQLite database at `.codex/agent-qa/omnisheet-agent-qa.db` and seeds deterministic QA data:

- Engagements: `Apple ITGC (A100)` and `Internal Admin (I200)`.
- Activities: `Control Testing (CTRL)`, `Walkthrough (WALK)`, and `Planning (PLAN)`.
- Timeline entries for the current local date, including one uncategorized review item.
- History, diagnostics, settings, and summary layout fixtures.

The browser mock uses matching names and command behavior, but it is in-memory and does not touch SQLite. The real user database under the OS app data directory must not be used for Agent QA; the desktop app refuses to start in Agent QA mode unless `OMNISHEET_DATABASE_PATH` is set.

## Browser Pass

`npm run agent:browser` must verify:

- The app renders the main shell rather than the runtime fallback.
- Day, Week, History, Codes, Settings, Diagnostics, and Summary View open.
- Seeded timeline/code/history/diagnostics/summary data is visible.
- A representative create, edit, save, and close-editor flow works without alerts.
- Feature-specific workflows that changed in the current work, using focused assertions in `app/tests/agent/agent-smoke.spec.ts`.

If the browser pass fails, fix the app or mock harness and rerun it.

The browser pass is a fast guardrail. It does not replace clicking through the changed feature in the real desktop app.

### Feature Assertions

When adding coverage for a feature:

- Scope assertions to the feature surface, such as a panel, table, modal, or `data-testid`.
- Avoid broad `getByText()` checks when the same label can appear in the sidebar, timeline, summary, and editor.
- Exercise at least one meaningful state transition, not only initial rendering.
- Keep deterministic mock behavior in `app/src/lib/agentMockApi.ts` aligned with desktop seed behavior in `app/src-tauri/src/agent_qa.rs`.

Current browser workflow coverage includes:

- AI text submission creates a deterministic timeline entry.
- Timeline entry edit, save, and close-editor flow.
- Quick Add renders stable grouped tiles, filters by search, and creates a blank-description manual entry without opening the editor.

## Changed-Feature Desktop Pass

Use this pass for every user-facing feature, workflow, or layout change. This is the part of the loop that should feel like Codex is using the app the way Ryan would.

Before launching the app, write a short checklist from the user request and the code diff:

- Changed feature:
- Affected view/panel:
- Expected behavior:
- Desktop interactions to prove it:
- Visual/layout risks to inspect:

Then run the desktop pass:

1. Start `npm run agent:tauri` from `app/`.
2. Wait for the `OmniSheet` desktop window.
3. Use Computer Use to capture the window screenshot.
4. Verify the seeded Day view is visible, including `QA seeded control walkthrough`.
5. Execute the changed-feature checklist first. Click the changed surface, type or edit representative data, save/cancel where relevant, and verify the visible result.
6. Inspect the changed feature for obvious visual defects: clipped text, overlap, hidden controls, broken empty/loading/error states, and awkward resize behavior.
7. Click through Week, History, Codes, Settings, Diagnostics, and Summary View as the general smoke pass.
8. Open a timeline entry, edit or cancel one field path, and close the editor unless the changed-feature checklist already covered an equivalent editor path.
9. Resize the window once and check for obvious clipping, overlap, or hidden controls.
10. If anything fails visually or functionally, fix it and repeat the relevant browser and desktop steps.

If Computer Use is unavailable or fails before the desktop pass is complete, do not describe the Agent QA loop as complete. Report the blocker and the last verified step.

## Examples

If the change is Quick Add:

- Search for a seeded activity.
- Click or drag an activity tile.
- Verify the timeline entry appears with the expected engagement/activity.
- Check the tile grid for stable spacing and no text overflow.
- Resize once and verify the Quick Add panel is still usable.

If the change is the timeline editor:

- Open a seeded timeline entry.
- Edit a field that the change touched.
- Save or cancel, depending on the intended behavior.
- Verify the timeline block and editor state match the action.
- Check Day and Week views if the edited value appears in both.

If the change is Settings or Diagnostics:

- Navigate directly to that tab.
- Change or filter the specific control touched by the feature.
- Verify the visible state and persistence/reload behavior where applicable.
- Check error/empty states if the feature includes them.

## Final Report Template

Include this in the final handoff:

- Changed: brief implementation summary.
- Changed-feature desktop pass: checklist items executed with Computer Use and what was observed.
- Verified: exact commands and general smoke interactions completed.
- Not run: any skipped QA step and why.
- Risk: remaining uncertainty, if any.
