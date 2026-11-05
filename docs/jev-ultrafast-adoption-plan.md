# Plan: adopt jev-ultrafast patterns in the extension

Branch: `feat/jev-quiz-and-snapshot-improvements` (from `main` at `eb6291a`).
Status: all phases (0 to 9) are implemented and verified; version 0.2.40. Nothing is committed.

## Goal

Adopt the ideas from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) that fit a Manifest V3 extension, while keeping every current capability. The runtime is not changed.

## Scope

Copied from jev-ultrafast (requested):
1. Page snapshot
2. Element cap
3. Freshness
4. Jev request
5. Confidence
6. Retries and model
7. Completion
8. Goal handling

Also in scope: click and input behavior inside the content script, settings, traces.

Out of scope (runtime):
- Chrome DevTools Protocol or `chrome.debugger` input
- A Python or out-of-extension process
- Trusted (OS-level) input events
- Background-tab focus emulation

## Corrections to the earlier comparison

- The combobox wait already exists: `waitForInteraction` in `src/content/actions.ts` waits up to 200 ms for visible `[role=option]` items.
- Skipping non-empty fields on fill is deliberate and relied on by the prompts. It stays the default.
- The LLM path already reports omitted controls through `interactiveElementCount`. The Jev path does not use it yet.

## Constraints

- All current tests stay green after every phase. Baseline: 323 passed, 3 skipped.
- Existing guards (document, form, fingerprint, occlusion, replay) are never weakened.
- The 0.95 gates for generic actions and completion stay unless a phase explicitly says otherwise and the user agrees.
- No browser mutation is ever retried.
- No sensitive field value is added to a request, log or export.
- Each phase can be reviewed and reverted on its own.
- A user-facing release bumps the version in `package.json`, `public/manifest.json` and `package-lock.json` (two fields).
- `npm run build` is the final check for each phase.

## The eight areas

### 1. Page snapshot

jev-ultrafast: one browser call reads controls, names, values and visible text atomically. A map keeps live element references. Freshness uses a semantic page key, not mutation counts.

This extension: `observePage` already returns one atomic observation with fingerprints, frame and shadow-root coverage, and viewport-aware text (10,000 characters, 6,000 sent to Jev).

To copy:
- Measure and reduce per-element work in `observePage` (batched style and geometry reads, question context computed once per group).
- Send only visible text to Jev, trimmed the same way as the LLM path, and report the character budget used.
- Keep a stable semantic page key that ignores animation-only mutations.
- Golden tests prove the observation output is unchanged by the speed work.

Done when: snapshot time is measured before and after, and output is byte-identical on fixtures.

### 2. Element cap

jev-ultrafast: keeps up to 250 candidates and reports how many were omitted; truncated candidates cannot be selected.

This extension: 80 for both the LLM and Jev paths.

To copy:
- Raise the Jev cap toward 250. The LLM path stays at 80 unless measurements justify a change.
- Pass `interactiveElementCount` and the omitted count to Jev, so it can choose "scroll" instead of guessing.
- When trimming, rank choice groups, the Continue/Next control and the focused control above decorative controls.
- Choose the final cap with token and latency numbers, not by assumption.

Done when: a 60-question quiz page never loses its Continue control, and the omitted count is visible to Jev.

### 3. Freshness

jev-ultrafast: before a click or select, compares the document, URL, viewport, safe form values, the target and nearby scope text. Unrelated visible changes do not invalidate the decision. Geometry and hit-testing run just before input.

This extension: guards bind document, form fingerprint, target fingerprint, single-use ID and occlusion. Any form-state change rejects the action. The target fingerprint already includes its enclosing form, dialog or row text, so text scoping already matched jev-ultrafast. Its page key also hashes every form value on the page, so the page-wide form check was never a gap against it.

Done (beyond jev-ultrafast, on the user's decision): Jev guards for native radio, checkbox and select controls compare only the control's own group state instead of the page-wide form state.
- Group = same-name radio or checkbox peers plus controls in the nearest fieldset, radiogroup, group, list item, row or dialog, falling back to the parent. Groups over 40 controls fall back to the strict check.
- Only a click or select whose targets all report group state is scoped. Fill, scroll, buttons, links and custom controls keep the page-wide check. The LLM planner path is unchanged.
- Document, URL, target fingerprint, replay and occlusion checks are unchanged.
- The older test that required a page-wide refusal now states that it applies to default guards and to non-choice targets.

Done when: unrelated edits outside a choice control's group no longer refuse a Jev click, while a changed group, changed target, replayed guard or non-choice target still do. Covered by tests and mutation checks.

### 4. Jev request

jev-ultrafast: one request carries an operation question plus compatible target questions; only the selected head is consumed; each target head carries current values and the full next-step rules; the last 10 actions are included.

This extension: already does this, and adds completion, fill value and a separate quiz route.

To copy:
- Add per-action outcome to the history sent to Jev ("page changed", "no visible change", navigated URL).
- Add a "stuck" cross-check head beside completion, so Jev can say it is looping.
- Keep the `requiredQuestions` selector behavior.

Done when: history entries record real outcomes, and a repeated no-change action is visible in the request.

### 5. Confidence

jev-ultrafast: validates distribution, range and argmax. It applies no confidence threshold.

This extension: validates the same way, then gates at 0.95 (generic, completion) and 0.80 (quiz).

To copy:
- Keep the strict validation exactly as is.
- Make the quiz gate a setting (default 0.80) and surface each head's confidence in the trace.
- Do not remove the generic 0.95 gate: this extension has an LLM fallback, jev-ultrafast does not.
- Add a labeled calibration set from real quiz pages, so thresholds are chosen from measured accuracy and not assumed.

Done when: the gate is configurable, defaults are unchanged, and a calibration test exists.

### 6. Retries and model

jev-ultrafast: up to 3 attempts on 429/503/529 with backoff; model defaults to `jev-latest` and is configurable.

This extension: no retries, 2 s deadline, pinned `jev-1.13.0`.

To copy:
- Retry the prediction only, at most twice, on 429/503/529, with short backoff. The 2 s deadline applies per attempt.
- Stop cancels pending retries.
- Never retry a click, fill or select.
- Allow a model setting, but keep `jev-1.13.0` as the default because thresholds were tuned against it. Record the model revision that answered in each trace.

Done when: tests cover retry, exhaustion, cancellation and the no-mutation-retry rule.

### 7. Completion

jev-ultrafast: `DONE` is only a model report; the example checks the real final page independently.

This extension: `DONE` needs a second head at 0.95, a fresh observation and an evidence ledger.

To copy:
- Add independent outcome checks that do not use the model, starting with quizzes: count answered question groups from the DOM and refuse completion if any is unanswered.
- Keep the existing completion head and evidence ledger.
- Report unanswered or ambiguous questions before finishing.

Done when: a quiz with an unanswered question cannot be reported as complete.

### 8. Goal handling

jev-ultrafast: one natural-language goal, bounded by 60 actions and 120 model calls. Repeating a goal list is treated as a single goal. Three unchanged pages in a row mean "blocked".

This extension: multi-step tasks, a requirements ledger, run history, no numeric Jev cap.

To copy:
- Add a model-call budget for Jev phases (default generous, configurable) that hands over to the LLM when reached, not a hard stop.
- Stop and hand over after three consecutive Jev actions that left the page unchanged.
- Keep requirements, run history and re-entry to Jev from the LLM.

Done when: tests cover the budget handoff and the three-unchanged stop, with existing behavior intact otherwise.

## Phases

| Phase | Work | Areas |
|---|---|---|
| 0 | Baseline suite and build. Add per-step timings (snapshot, Jev, click or input, LLM fallback) to the Console and run report | all |
| 1 | Element cap, omitted count, quiz-priority ranking | 2 |
| 2 | Snapshot speed, semantic page key, golden tests | 1 |
| 3 | Scoped freshness for Jev clicks and selects | 3 |
| 4 | Outcome history, stuck head, budget and unchanged-page handoff | 4, 8 |
| 5 | Bounded retries, model setting, model revision in trace | 6 |
| 6 | Configurable quiz gate, calibration set, trace export | 5 |
| 7 | Independent quiz outcome check | 7 |
| 8 | Optional replace-value fill, explicit opt-in only | click and input |
| 9 | README, version bump, full suite and build | all |

## Risks

| Risk | Mitigation |
|---|---|
| Larger cap raises token cost and latency | Measure in phase 0; keep LLM cap at 80 |
| Snapshot work changes output | Golden tests before and after |
| Scoped freshness lets a stale decision through | Strict guard stays the default; scoped check limited to Jev clicks and selects; targeted tests |
| Retries add latency | At most two, only on listed status codes |
| Stuck head or budget hands over too early | Configurable, covered by tests |
| Independent quiz check misreads a custom widget | Falls back to the existing completion path, never auto-completes |
| Replace-fill overwrites user data | Opt-in, never on sensitive or read-only fields, verified after write |
| Screenshots may contain sensitive content | Already documented; policy becomes a setting |

## Open decisions

All three were settled: replace-value fill is included (opt-in), 250 is the Jev element cap, and nothing is committed.

## Notes

- Phase 8 as built: `JevSettings.replaceFilledFields` (off by default; a checkbox in Settings). Skip-if-filled stays the default for Jev and the LLM planner. When on, Jev offers a filled, editable, non-sensitive, non-read-only text field as a fill target, showing its current value, and the fill guard carries `replaceExisting`. Only `guardObservedAction` can set that flag, so a guard supplied by a model is overwritten. The page script replaces the value only when the flag is present and the field is not sensitive; it makes no change if the field already holds the value, and fails the action if the page does not keep the new value. Verification after writing applies to replacements only, not to ordinary fills. Contenteditable replacement is implemented the same way but is not covered by a test because jsdom does not support it.

- Phase 7 as built (reframed from quizzes to any radio choice): each observation now carries `choiceGroups` (visible native radio groups, grouped by form and name, plus ARIA radiogroups, with how many have no selection); the field is absent when a page has none. Jev's request includes it. When Jev reports DONE, the extension refuses completion and hands over to the LLM if the fresh page still has unanswered groups and Jev has clicked a radio earlier in the run. The gate does not apply if Jev never answered a choice, so optional radio groups on unrelated pages do not block completion. It only adds a refusal; it never completes a task. Limits: only radio-style groups are counted (checkboxes are optional by nature), unnamed or fully hidden native radios and custom widgets without radio roles are not counted, so the check can under-report but not over-report, and a group that is optional by design will hand over to the LLM once Jev has answered some other choice on the run.

- Phase 6 as built (reframed, because the quiz route no longer exists in this tree): Settings now has controls for the Jev model, requests per run and minimum confidence; empty fields use the defaults. The minimum confidence can only be raised (0.95 to 0.99) and applies to the operation, target, fill-value and completion heads and to LLM-path navigation; the 0.95 default and the stuck-veto threshold are unchanged. The Token Console has a "Download Jev trace" button that exports the latest run's decisions (kept in memory, up to 200, reset when a new run starts): per head the choice, confidence and top three options, plus kind, operation, veto or fallback reason, model revision, attempts, elapsed time and tokens, and the page URL reduced to origin and path. It contains no task text, page text, labels or typed values. The trace is lost if the service worker restarts. A calibration set from real pages was not built because no such data exists here; the gate behavior is covered by a table-driven test over floors and confidence levels instead.

- Phase 5 as built: the Jev prediction request is retried at most twice (3 attempts) on HTTP 429, 503 and 529, with 250 ms then 500 ms backoff; jev-ultrafast uses 500 ms then 1 s. Each attempt has its own 2 s deadline, Stop cancels the pause, and timeouts, network errors and other HTTP errors are not retried. Browser actions never pass through this path. This replaced the earlier tests that asserted 429 and 529 were never retried. `JevSettings.model` (letters, digits, `.`, `_`, `-`, up to 64 characters; invalid values fall back to `jev-1.13.0`) is sent with every Jev request, including the connection test and the LLM-path navigation. The revision Jev reports in its response is logged with each decision and kept as `lastModel`, with a `retries` count, in the usage snapshot, run report and Console. Retries of a request that finally fails are not counted in `retries`, only in its error message. The model and budget settings have no controls yet; both are in phase 6.

- Phase 4 as built: each executed Jev action gets an `outcome` ("navigated to <url>", "page changed", "no visible change") that reaches Jev's `recentActions` and the LLM handover text. When an action's reply looks unchanged the loop re-reads the page once before recording "no visible change", because the content-script reply can precede an asynchronous page response. Three consecutive unchanged actions hand over to the LLM (re-entry to Jev stays allowed). A best-effort `stuck` head is asked once two actions exist; it can only veto at 0.95 or more and only if one of the last two outcomes was "no visible change". A per-run Jev request budget (default 120, `JevSettings.maxRequests`, 1 to 1000, invalid values fall back to 120) hands over to the LLM without re-entry. The budget has no settings control yet; that belongs to phase 6.

- `.gitignore` (`*.db.bak`) and `.github/` were changed or untracked before this work and are not part of it.
- Speed figures reported by jev-ultrafast (7.1 s on Google Flights, 178 ms median Jev latency) are their own recording and have not been reproduced here.
