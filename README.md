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
- `maxSteps`: maximum observe/act loop iterations, default `60`.
- `requestTimeoutSeconds`: AI request timeout per attempt, default `60` seconds.
- `promptCacheMode`: `auto` selects cache hints by provider and model, `on` forces cache hints, and `off` disables them.
- Optional token pricing rates: input, cached input, and output USD per 1M tokens for the dashboard cost estimate.
- `saveRunHistory`: stores sanitized run reports locally; screenshots, uploaded files, form values, and API keys are never included in reports.
- Named AI profiles: test the current connection, save new profiles, apply or update a selected profile, and delete profiles from Settings. Profiles can be exported and imported as versioned JSON. Exports include API keys in plaintext; imported name conflicts are retained as renamed copies such as `Work (imported)`.

The extension uses `fetch` from the open side-panel document against `POST {apiBaseUrl}/chat/completions` with OpenAI-compatible chat-completions JSON. Keeping model HTTP outside the Manifest V3 service worker avoids Chrome's 30-second service-worker fetch-response limit. No paid SDK is used.
Each AI request uses the configured timeout. A timed-out step gets up to four attempts. Provider compatibility downgrades for rejected prompt-cache fields and JSON response-format fields use separate bounded retries, so earlier timeouts cannot consume a promised compatibility fallback. Authentication and other non-compatible HTTP failures are returned immediately. Chat shows the active timeout retry and next attempt number, while the action log retains every retry.

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

`src/background/safety.ts` is present for reinstating policy checks, but this local test build currently bypasses background safety validation. Content execution still only supports the defined action schema. Controlled file upload is limited to the one file explicitly staged in the side panel.

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
