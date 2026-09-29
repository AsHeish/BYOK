# BYOK AI Browser Agent

A minimal Manifest V3 Chrome/Edge side-panel extension that runs a bring-your-own-key AI browser agent. The user configures an OpenAI-compatible, Gemini-compatible, Groq, or custom API endpoint, enters a task, and the extension observes the current page, asks the model for one JSON action or a short action batch, executes it, and repeats until done or stopped.

## File Tree

```text
.
|-- index.html
|-- sidepanel.html
|-- package.json
|-- public
|   `-- manifest.json
|-- src
|   |-- background
|   |   |-- chromeAsync.ts
|   |   |-- index.ts
|   |   |-- modelClient.ts
|   |   |-- pdfText.ts
|   |   |-- prompts.ts
|   |   `-- safety.ts
|   |-- content
|   |   |-- actions.ts
|   |   |-- domMap.ts
|   |   `-- index.ts
|   |-- sidepanel
|   |   |-- App.tsx
|   |   |-- components
|   |   |   |-- ActionLog.tsx
|   |   |   |-- FileStagingPanel.tsx
|   |   |   |-- SettingsPanel.tsx
|   |   |   |-- TaskRunner.tsx
|   |   |   `-- UsageDashboard.tsx
|   |   |-- main.tsx
|   |   `-- styles.css
|   `-- shared
|       |-- defaults.ts
|       |-- fileData.ts
|       |-- ids.ts
|       |-- storage.ts
|       `-- types.ts
|-- tsconfig.json
`-- vite.config.ts
```

## Setup

```bash
npm install
npm run build
```

Then load the extension:

1. Chrome: open `chrome://extensions`.
2. Edge: open `edge://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select the generated `dist` folder.
6. Click the extension icon to open the browser's right-side side panel.

Use `Ctrl+Shift+Y` on Windows/Linux or `Command+Shift+Y` on macOS to open the panel from the keyboard.

For local iteration, run `npm run build` after changes and reload the unpacked extension.
Run `npm test` for the focused agent behavior tests.

## Provider Settings

The side-panel settings support:

- `provider`: OpenAI-compatible, Gemini-compatible, Groq, or custom.
- `apiBaseUrl`: defaults to `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`, or `https://api.groq.com/openai/v1`.
- `apiKey`: stored with `chrome.storage.local`.
- `model`: any model name accepted by the configured compatible endpoint.
- `openAiApi`: with the OpenAI-compatible provider, **OpenAI endpoint** selects Responses (`/responses`) or Chat Completions (`/chat/completions`). Unset, `api.openai.com` uses Responses and other hosts use Chat Completions.
- `maxSteps`: maximum observe/act loop iterations for the LLM planner, default `60`. Jev Fast phases have no numeric navigation limit.
- `requestTimeoutSeconds`: AI request timeout per attempt, default `60` seconds.
- `promptCacheMode`: `auto` selects cache hints by provider and model, `on` forces cache hints, and `off` disables them.
- `disableThinking`: **Disable model thinking** below Model requests non-thinking generation. It is off by default, preserving the provider's normal behavior, and is saved with each AI profile.
- Optional token pricing rates: input, cached input, and output USD per 1M tokens for the dashboard cost estimate.
- `saveRunHistory`: stores sanitized run reports locally; screenshots, uploaded files, form values, and API keys are never included in reports.
- Named AI profiles: test the current connection, save new profiles, apply or update a selected profile, and delete profiles from Settings. Profiles can be exported and imported as versioned JSON. Exports include API keys in plaintext; imported name conflicts are retained as renamed copies such as `Work (imported)`. Profiles do not store Jev settings.

The **Save** button is beside **Update** in the profile toolbar. With a matching profile selected, it offers **Save & Update** to persist the current settings and replace that profile's values, **Save Only** to leave the profile unchanged, or **Cancel**. Without a matching profile, Save persists settings directly.

Each task carries the configuration currently shown in the side panel, including unsaved provider changes. The worker uses that snapshot for the entire run, including summaries and completion checks, instead of reloading a different saved provider. Save is still required to retain settings across reloads. Requests from an outdated side panel that omit the configuration are rejected; reload the extension and reopen its side panel after an upgrade.

The extension uses `fetch` from the open side-panel document against `POST {apiBaseUrl}/responses` (OpenAI Responses JSON) or `POST {apiBaseUrl}/chat/completions` (OpenAI-compatible chat-completions JSON). Keeping model HTTP outside the Manifest V3 service worker avoids Chrome's 30-second service-worker fetch-response limit. No paid SDK is used.
Each AI request uses the configured timeout. A timed-out step gets up to four attempts. Provider compatibility downgrades for rejected prompt-cache fields and JSON response-format fields use separate bounded retries, so earlier timeouts cannot consume a promised compatibility fallback. Authentication and other non-compatible HTTP failures are returned immediately. Chat shows the active timeout retry and next attempt number, while the action log retains every retry.

## Model Thinking

Enable **Settings > Disable model thinking**, then use **Test Connection** with the current configuration. **Save** retains the setting; **Save & Update** also updates the selected profile. The option applies to all LLM requests: chat, browser planning, summaries, completion checks, connection tests, and Jev Fast's field-text helper. Jev requests are unchanged.

The request parameter depends on the endpoint:

| Endpoint/model | Disabled-thinking request |
| --- | --- |
| Local or custom Qwen3/Gemma4 models (including `qwen-3.6-27b` and `gemma-4-31b`) | `chat_template_kwargs: { enable_thinking: false }` |
| OpenRouter (`openrouter.ai`) | `reasoning: { enabled: false }` |
| Other OpenAI-compatible, Groq, and Gemini endpoints | `reasoning_effort: "none"` |

Support depends on the provider, model, and server configuration. Some models require reasoning, some do not recognize the parameter, and some gateways ignore unsupported fields. A successful connection test confirms API acceptance, not that the model used zero reasoning tokens. Gemini 2.5 Pro and Gemini 3 models do not support fully disabling thinking. For local Qwen/Gemma deployments, the server must honor chat-template kwargs. This option does not hide or strip reasoning text; it requests non-thinking inference. Disabling thinking can reduce latency and token use, but can also reduce answer quality.

When an endpoint rejects the parameter, the error is returned; the extension does not remove the setting and silently retry with thinking enabled. Other compatibility retries retain the disabled-thinking parameter. Leave the toggle unchecked for the provider default. See [vLLM reasoning controls](https://docs.vllm.ai/en/latest/features/reasoning_outputs/), [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai#thinking), and [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Jev Actions

Enter a TypeSafe API key under **Settings > Jev actions**. Entering a key selects **Fast**; clearing it turns Jev off. **Off**, **Shadow**, and **Fast** remain available while a key is present. Without a key, Jev is never called and only the LLM runs. An LLM API key and model are always required.

Jev settings are global. **Save** retains them, and they stay unchanged when you switch provider or apply, save, or update AI profiles. Profile exports do not include the TypeSafe key. Earlier Jev Only settings load as Fast when a key exists, and the retired `Jev Only (default)` profile is no longer shown.

Jev chooses one operation plus compatible targets in a single TypeSafe request. Supported operations are observed link/button/checkbox clicks, empty-field fills, native dropdown selection, scrolling, short waits, completion, and fallback. For fills, put an exact value in double quotes, for example: `Search for "typescript" and open the first result`. Code supplies that exact value without an LLM helper call; Jev selects its field and value index. Existing field values are preserved. Summaries, uploads, screenshots, and narrative research answers go to the LLM planner.

The controller operates on its starting owned tab. Observed links can leave the original site. There are no keyword-based bans on submit, transaction, account, or sensitive-looking controls, and a model's high-risk label does not itself stop execution. HTTP(S) URLs are not rejected because their paths or query parameters contain words such as delete or token. File inputs still use the explicit staged-upload workflow. Browser protocol, permission, disabled/read-only, and stale-target constraints remain.

CAUTION: Removing these policy refusals allows task instructions to cause form submissions and state-changing actions. Review the task and use Stop when needed. Redaction of detected secret values remains independent of permission to interact with a control.

There is no numeric navigation cap. Repeated unchanged action/target states and prolonged unproductive waits hand control to the LLM planner; different actions, focus changes, and scroll progress are distinct. Suspected stalls get a short re-observation window for delayed updates. Stop aborts active model/helper requests. Unlimited overall steps can continue to incur costs until completion or Stop.

Completion requires both `operation=done` and a separate `completion=verified` answer at confidence >= 0.95, followed by a fresh semantic observation and evidence-ledger checks. This is model-backed verification, not an independent guarantee of task correctness. Use deterministic outcome checks for critical workflows and benchmark tasks.

The client validates the operation first, then every answer required by that operation. Invalid unused speculative answers are ignored and identified in Console rather than forcing LLM fallback; a `done` decision still requires a valid completion answer. Probabilities must match the offered options, remain finite in [0, 1], and select a highest-probability option. Totals within 0.02 of 1 are normalized to tolerate small rounding differences; larger errors are rejected with the question name and failure reason, without logging page content.

For native radio/checkbox clicks, an explicitly associated label is a valid click surface even when it covers the native input. Styled controls can use their visible label when the input is transparent. Unrelated overlays or another option's label remain blocked, and single-use action guards still prevent replay.

## Jev Hybrid And Shadow

Configure the LLM provider as usual and add a TypeSafe key. Fast permits field-text generation and planner fallback with that configured LLM:

- **Off** (default): the existing LLM agent runs without Jev requests.
- **Shadow**: Jev records operation/target choices; only the LLM's actions execute. No speculative text-helper calls are made. This mode adds latency and is for evaluation.
- **Fast**: Jev controls supported actions directly, rather than waiting for LLM navigation delegation. The configured LLM supplies field text only when Jev selects `generate`, or performs recovery work for unsupported/uncertain decisions with the completed-action history. A successful recovery batch can return control to Jev.

After one successful LLM recovery batch, the runtime completes the normal interaction wait and takes a fresh observation. If the page changed and no document, screenshot, or staged upload still needs the LLM, it logs **Returning control to Jev** and lets Jev continue. The resumed Jev call receives prior Jev actions and the completed LLM recovery batch; it does not restart the task or clear the evidence ledger. This supports flows such as LLM answer selection plus Continue, then Jev on the next quiz question.

To avoid repeated handoffs, two consecutive returns to Jev that execute no browser actions leave the LLM in control for the rest of the task. A return in which Jev executes an action resets that counter. Jev API/validation failures, text-helper failures, and staged uploads keep the LLM in control without automatic Jev retries. Failed or unchanged LLM batches do not trigger a return. Stop, `ask_user`, and completed tasks never restart Jev. Shadow behavior is unchanged. These handoff limits do not add a total navigation cap to Jev.

Field text uses one request with a 10-second deadline and a 1,024-token output limit. Only a JSON object containing exactly one nonempty `text` string of at most 2,000 characters is accepted; no action output is executable. The helper must not invent personal data or missing values. Its output is reused across a stale retry only when the full helper context, target fingerprint, and recent history are identical. Every generated fill is checked by the content-side guard after generation and before mutation. Helper usage appears separately from Jev decisions, and its tokens/cost are included in the normal LLM totals.

Only content-confirmed `notExecuted` refusals can retry, at most twice. An ambiguous mutation outcome stops instead of repeating the action or handing it to another model. Fast can hand over when no mutation is in doubt.

## Jev Safety, Data And Timing

Requests use `POST https://api.typesafe.ai/v1/systemone`, pinned to `jev-1.13.0`, with a two-second deadline and no automatic HTTP retries. The task, URL/title, up to 6,000 characters of page text, up to 80 eligible control descriptions, ordinary field values, and recent action history are sent. Detected password/credential/OTP/payment values are redacted, but detection is not universal: avoid sensitive page content. Screenshots are not part of the Jev loop. Keys stay in extension-owned storage/transport; profile exports do not include the TypeSafe key.

Each action has a single-use guard bound to the document, URL, form-state fingerprint, and selected target fingerprints. The content executor checks identity, visibility, disabled/read-only state, current geometry, and occlusion. A verified offscreen target is scrolled into view before execution; stale targets are never replaced heuristically. Missing IDs return a recoverable explanation to the planner instead of a misleading sensitive-action refusal.

Guarded interactions wait for two animation frames, capped at 80 ms; autocomplete fills wait for visible options, capped at 200 ms. The resulting atomic observation is reused for the next Jev decision, avoiding the LLM loop's extra 800 ms settlement wait. These waits are not completion guarantees. Navigation retains Chrome tab-completion handling, and explicit waits remain available for delayed page state.

Console shows Jev request latency, Fast/Shadow counts, fallbacks, helper calls, tokens/cost, and a latest-decision inspector with each head's confidence and top alternatives. Logs retain per-step decisions without storing field values in the inspector. Counters and the latest inspector state survive run-history reloads. Jev cost estimates use $0.042 per million reported input tokens with free output tokens, per [TypeSafe documentation](https://docs.typesafe.ai/models), September 22, 2026. Missing usage can undercount charges.

Compare the same tasks in Off/Fast with the same providers: record full turn duration, median/p95 latency, actual outcome success, model calls, failures, and combined cost. Shadow is for decision evaluation, not speed. Automated tests use mocks; no live Jev speed claim or universal outcome verifier is implied. Research prose and specialized repository ranking remain LLM tasks, not a Jev-only research product.

## Prompt Caching

The agent structures model requests for provider-side prefix caching:

- Static agent instructions are sent first.
- The user's task is sent as a stable message that remains unchanged during a run.
- Changing step data, previous results, and page observations are sent last.
- OpenAI and custom provider requests include `prompt_cache_key` and `prompt_cache_retention: "in_memory"` when prompt cache mode is `auto`.
- `qwen-3.6-27b` and `gemma-4-31b` use the automatic-prefix strategy and send a stable vLLM-compatible `cache_salt` instead of OpenAI retention fields.
- Prompt cache mode `on` forces those cache hints for any provider; `off` omits them.
- If a compatible endpoint rejects cache fields, the request is retried without them.
- The background console logs `cachedPromptTokens` and `promptCacheHitRate` when the provider returns OpenAI, vLLM, or compatible cache usage fields.

Automatic prefix caching for Qwen and Gemma must also be enabled on the inference server. For vLLM, start the model server with `--enable-prefix-caching`. The gateway must route repeated requests to a worker that shares the same KV cache; a client request field cannot enable or share GPU KV storage by itself. If the server omits cached-token telemetry, compare time-to-first-token or inspect server prefix-cache metrics to verify hits.

OpenAI-compatible APIs are still stateless, so the extension must send the full current prompt on every step. The cache benefit comes from the model provider reusing repeated prefix tokens internally.

The dynamic observation also begins with a compact page-state summary: viewport progress, focused element, empty fillable controls, already filled/selected controls, and visible drag/drop candidates. That high-signal state is followed by trimmed readable text and the full interactive element list.

## Uploads, Downloads, and Summaries

The Chat composer includes a **File Dock** where the user can stage one local file. The agent can only upload that staged file with `upload_file`; it cannot browse arbitrary local paths or silently choose files.

The background worker listens for completed browser downloads and can list recent downloads with `list_downloads`. Download metadata is included in the model context so the agent can reference recent PDF downloads by `downloadId`.

The agent can summarize normal web pages with `summarize_page`. Full-page prose is extracted with Mozilla Readability and converted to Markdown; form controls and media are removed before conversion. `read_page` provides that cleaned document to the next agent step, while `extract` remains the structured path for headings, links, tables, and forms.

It can summarize PDFs from a staged PDF, a PDF URL, the current PDF tab URL, or a recent PDF download source with `summarize_pdf`. PDF text extraction uses the open-source `pdfjs-dist` package with a lightweight fallback extractor.

## Completion, Waiting, and Visual Fallback

Every run has a requirement ledger. The model proposes requirements, but the extension assigns IDs and only accepts evidence IDs that the runtime actually created. A `done` action is rejected recoverably unless it is the only action, declares `outcome` as `completed` or `partial`, and every requirement is evidence-backed or explicitly blocked. A fresh page observation and final model validation run before completion is accepted.

`wait_for` polls a condition without blocking the Stop button. Supported conditions are `document_ready`, `dom_stable`, `url_changed`, `text_present`, `text_absent`, `element_hidden`, and `element_enabled`. Waits are capped at 15 seconds and return a fresh observation.

`press_key` supports `Tab`, `Shift+Tab`, `PageUp`, and `PageDown`. PageUp/PageDown scroll the selected page or nested scroll container without advancing input focus. Unknown or missing keys are rejected rather than silently becoming Tab. Skipped/repeated fills no longer automatically press Tab. Existing nonempty field values remain preserved. `read_page` reads content but does not move the viewport or create new actionable element IDs; the planner must scroll and use the current observation rather than guess IDs from earlier steps.

Before another LLM step, ordinary browser interactions automatically wait for a complete, unchanged DOM across consecutive samples (at least 800ms, capped at 3 seconds), then the loop takes a fresh observation. The stability signature includes visible text, interactive control values/states, open shadow roots, and accessible same-origin frames. Navigation actions separately wait for Chrome tab completion. For workflows with a specific delayed completion signal, use `wait_for` explicitly.

`inspect_screenshot` is an explicit fallback for charts, canvas, diagrams, layout, and icon-only controls. It captures only the visible active tab when that tab belongs to the current agent run. The image is resized, sent to the model once, redacted from debug logs, and never persisted. If the provider rejects visual input, the step is retried text-only and vision is disabled for that run.

## Run History

The History view stores up to 50 sanitized reports with task status, requirement progress, findings, final Markdown output, and usage. Reports can be copied, rerun on the current page, deleted individually, or cleared. Runs left active by a service-worker restart are marked `interrupted`.

## Chat

The Chat view shows user requests, final Markdown answers, page and PDF summaries, and questions that need user input. Each assistant message includes its persisted end-to-end response duration as an unlabeled compact value. Replies to questions retain the paused task context. Each prior user message has a rerun action that submits the same prompt as a new turn. Up to 100 chat messages are stored locally and can be cleared from the Chat header. Suggestions can be edited, added, deleted, or reset and are stored locally in the browser profile. They fold after the first message but remain available from the Suggestions chevron.

On the first request, one model call receives the recent conversation and current browser observation, then returns `mode: "chat"` with a direct answer or `mode: "browser"` with the first browser action. This avoids a separate classification request. Browser-task continuations and later agent steps stay in browser mode. Chat shows only the latest timed action while work is running; the full operational log remains in Console. During a model request, Chat displays a short thinking status. The composer Send button becomes Stop for the full active task; Stop aborts the model HTTP request immediately and cancels the remaining task without creating an error reply.

## Iframes and Shadow DOM

Page observation walks the top document, accessible same-origin iframe documents, and open shadow DOM roots. Mapped elements include optional `frame` and `root` context in the model prompt so repeated controls in embedded widgets can be distinguished.

Cross-origin iframes and closed shadow roots are detected as inaccessible where possible. The agent will report them in the prompt context, but it cannot inspect or control their private DOM from the top-page content script.

## Token Dashboard

The Console tab includes the operational action log and a token dashboard that updates after each model request:

- prompt, cached prompt, completion, and total tokens
- cache hit requests and cached-token percentage
- last and average AI response latency
- status of the last model request
- estimated cost when pricing rates are configured in Settings

Cost estimates use the configured USD per 1M token rates. If no rates are configured, token and latency metrics still update and the cost tile shows `Set rates`.

## Agent Loop

The agent loop executes one action or a bounded action batch at a time:

1. Content script observes readable page text and visible interactive elements.
2. Background service worker asks the model for strict JSON containing `mode` and the answer or first action.
3. Chat mode returns the direct answer immediately; browser mode normalizes either `action` or `actions` into ordered actions.
4. Content script executes up to 10 supported actions in order.
5. Fail-safe mode stops the remaining batch on failure, stale elements, `ask_user`, `done`, navigation, `read_page`, `inspect_screenshot`, `wait_for`, or a tab-changing action, then sends completed-action progress into the next model prompt.

`src/background/safety.ts` validates observed actions before execution. Guarded content actions reject stale documents, changed targets/form state, occlusion, and replay. Controlled file upload remains limited to the one file explicitly staged in the side panel and requires the LLM workflow.

API keys are profile-local extension data, not a secure vault. Use scoped, revocable keys.

## Model Response Format

The model must return strict JSON only and choose `mode` as `chat` or `browser`. Chat mode returns one `done` action containing the direct answer. Browser mode uses `action` for one action or `actions` for an ordered batch of up to 10 actions. The extension executes browser actions until the batch ends or a fail-safe stop condition:

```json
{
  "mode": "browser",
  "thought_summary": "short user-visible reasoning",
  "risk_level": "low",
  "actions": [
    {
      "type": "fill",
      "elementId": "el-12",
      "text": "answer text"
    },
    {
      "type": "click",
      "elementId": "el-20"
    }
  ]
}
```

Supported action types are `click`, `multi_click`, `drag`, `multi_drag`, `upload_file`, `fill`, `type`, `select`, `press_key`, `summarize_page`, `read_page`, `inspect_screenshot`, `summarize_pdf`, `list_downloads`, `scroll`, `navigate`, `go_back`, `go_forward`, `reload`, `open_tab`, `switch_tab`, `close_tab`, `wait_for`, `extract`, `ask_user`, and `done`. `go_back` and `go_forward` use browser history. `open_tab` uses `url`, while `switch_tab`, `close_tab`, and optional `reload` targeting use `tabAlias` such as `tab-2`. For multiple-answer checkbox questions, `multi_click` uses `elementIds` to select several options in one browser action. For multiple drag-and-drop pairs, `multi_drag` uses `dragPairs: [{ "elementId": "source", "targetElementId": "target" }]`. For file uploads, `upload_file` uses a page `elementId` and optional staged `fileId`; for PDFs, `summarize_pdf` can use `url`, `fileId`, or `downloadId`.

The agent tracks tabs with aliases (`tab-1`, `tab-2`, ...). A same-tab task leaves the seed tab ungrouped. When the agent first opens or adopts an additional tab, it atomically moves the seed and new tab into one visible `AI Agent` tab group; later owned tabs join that group. Only the seed tab, extension-created tabs, and popups opened by an owned tab are accessible. Removing a tab from an established group revokes agent access. The model receives a compact tracked-tab list every step, but only the active tab's DOM observation is sent. To interact with another tab, the model must switch to that alias first and wait for the next observation.

Page observations are trimmed to roughly 4,000 input tokens. The readable text window is scroll-aware, so as the page scrolls down, old upper-page text drops out and lower-page text enters the model context.

## Known First-Version Limits

- Only `http` and `https` pages are supported.
- Browser internal pages, extension store pages, some PDFs, and restricted pages cannot be controlled.
- The DOM mapper is intentionally small and visible-element focused. Same-origin iframes and open shadow roots are supported; cross-origin iframes and closed shadow roots remain browser-restricted.
- Drag-and-drop support uses synthetic pointer, mouse, and HTML5 drag events. Some sites only accept browser-trusted physical drag gestures, so specific quiz widgets may need targeted handling.
- Downloaded files are detected through Chrome's downloads metadata. PDF summarization can fetch the original URL or use a staged PDF, but it cannot read arbitrary downloaded file paths directly from disk.
- Screenshot fallback requires an OpenAI-compatible provider/model that accepts `image_url` message parts.
- Strong API-key encryption is not implemented because no user-held secret is collected.
