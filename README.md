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
|   |   |   |-- SettingsPanel.tsx
|   |   |   `-- TaskRunner.tsx
|   |   |-- main.tsx
|   |   `-- styles.css
|   `-- shared
|       |-- defaults.ts
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

For local iteration, run `npm run build` after changes and reload the unpacked extension.

## Provider Settings

The side-panel settings support:

- `provider`: OpenAI-compatible, Gemini-compatible, Groq, or custom.
- `apiBaseUrl`: defaults to `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`, or `https://api.groq.com/openai/v1`.
- `apiKey`: stored with `chrome.storage.local`.
- `model`: any model name accepted by the configured compatible endpoint.
- `maxSteps`: maximum observe/act loop iterations, default `60`.
- `requestTimeoutSeconds`: AI request timeout per attempt, default `60`.
- Named AI profiles: save the current provider/base URL/API key/model/max steps/timeout under a name, then apply or delete profiles from Settings.

The extension uses `fetch` against `POST {apiBaseUrl}/chat/completions` with OpenAI-compatible chat-completions JSON. No paid SDK is used.
Each AI request uses the configured timeout and automatically retries before surfacing a timeout error.

## Prompt Caching

The agent structures model requests for provider-side prefix caching:

- Static agent instructions are sent first.
- The user's task is sent as a stable message that remains unchanged during a run.
- Changing step data, previous results, and page observations are sent last.
- OpenAI provider requests include `prompt_cache_key` and `prompt_cache_retention: "in_memory"`.
- If a compatible endpoint rejects OpenAI cache fields, the request is retried without them.
- The background console logs `cachedPromptTokens` and `promptCacheHitRate` when the provider returns cache usage.

OpenAI-compatible APIs are still stateless, so the extension must send the full current prompt on every step. The cache benefit comes from the model provider reusing repeated prefix tokens internally.

## Agent Loop

The agent loop executes one action or a bounded action batch at a time:

1. Content script observes readable page text and visible interactive elements.
2. Background service worker asks the model for strict JSON.
3. Background normalizes either `action` or `actions` into ordered actions.
4. Content script executes up to 10 supported actions in order.
5. Fail-safe mode stops the remaining batch on failure, stale elements, `ask_user`, `done`, or navigation, then sends completed-action progress into the next model prompt.

`src/background/safety.ts` is present for reinstating policy checks, but this local test build currently bypasses background safety validation. Content execution still only supports the defined action schema.

API keys are profile-local extension data, not a secure vault. Use scoped, revocable keys.

## Model Response Format

The model must return strict JSON only. Use `action` for one action, or `actions` for an ordered batch of up to 10 actions. The extension executes until the batch ends or a fail-safe stop condition:

```json
{
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

Supported action types are `click`, `multi_click`, `drag`, `multi_drag`, `fill`, `type`, `select`, `press_key`, `scroll`, `navigate`, `extract`, `ask_user`, and `done`. For multiple-answer checkbox questions, `multi_click` uses `elementIds` to select several options in one browser action. For multiple drag-and-drop pairs, `multi_drag` uses `dragPairs: [{ "elementId": "source", "targetElementId": "target" }]`.

Page observations are trimmed to roughly 4,000 input tokens. The readable text window is scroll-aware, so as the page scrolls down, old upper-page text drops out and lower-page text enters the model context.

## Known First-Version Limits

- Only `http` and `https` pages are supported.
- Browser internal pages, extension store pages, some PDFs, and restricted pages cannot be controlled.
- The DOM mapper is intentionally small and visible-element focused.
- Drag-and-drop support uses synthetic pointer, mouse, and HTML5 drag events. Some sites only accept browser-trusted physical drag gestures, so specific quiz widgets may need targeted handling.
- Strong API-key encryption is not implemented because no user-held secret is collected.
