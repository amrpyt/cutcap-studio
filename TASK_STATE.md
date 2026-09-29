# Task State

## Goal
Replace the long single-page frontend with a calm five-stage lightweight workflow while preserving all current editor behavior and the existing Node backend.

## Constraints
- Keep the existing plain HTML/CSS/JavaScript runtime for maximum speed and low memory use.
- No new runtime dependencies.
- Sidebar workflow: Video, Cut Settings, Review, Logo, Export.
- Simple defaults with advanced settings in native disclosures. BoardUI is not used.
- Preserve current API routes, editing behavior, cancellation, progress, and tests.

## Changed files
- `index.html`
- `app.js`
- `TASK_STATE.md`
- `tests/workflow.behavior.test.js`
- `tests/server.integration.test.js`

## Remaining steps
1. Complete: dark studio rail, focused stage workspace, project context, export summary and inline feedback. Native advanced disclosures; no new dependencies.
2. Complete: shared review player, explicit zero-cut-ready state, busy navigation lock, stale-settings lock, hidden-player pause, deferred logo video and hidden-timeline drawing guard.
3. Complete: syntax check and all 30 tests pass, including five controller behavior regression tests.
4. Complete: live browser import, analysis (zero cuts), review with visible player, restored logo, export success and stale-settings lock verified. All five stages checked at 390px; no horizontal page overflow observed. Browser error log empty. Test export used existing two-second synthetic fixture, not user footage.
5. Complete: local connection recovery added. Long requests have no Node request timeout; job results are retained for 2 hours; a dropped job response is recovered by polling `/api/job-result`; uncaught server errors are written to `server-error.log`. Direct test aborted a request mid-analysis and recovered the completed result.

## Verification limits
- No low-end hardware benchmark or long/4K media stress test performed.
- Native file dialogs were not retested; manual-path import was used.
- Existing saved logo was preserved; logo drag/keyboard movement not end-to-end tested this turn.
- Runtime remains plain HTML/CSS/JavaScript. Server reliability changes are isolated to request recovery, timeouts and diagnostics; encoding behavior is unchanged.
- If the Node process genuinely crashes, the active Auto-Editor child is terminated with it; the completed result can only be recovered when the process itself stays alive. `server-error.log` now records the crash reason.

## Next command
No further implementation required for this pass. Refresh the app to load the redesign.
