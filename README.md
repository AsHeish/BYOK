# BYOK AI Browser Agent

A minimal Manifest V3 Chrome/Edge side-panel extension that runs a bring-your-own-key AI browser agent. The user configures an OpenAI-compatible, Gemini-compatible, Groq, or custom API endpoint, enters a task, and the extension observes the current page, asks the model for one JSON action, validates it, executes it, and repeats until done or stopped.

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
- `maxSteps`: maximum observe/act loop iterations.
- Named AI profiles: save the current provider/base URL/API key/model/max steps under a name, then apply or delete profiles from Settings.

The extension uses `fetch` against `POST {apiBaseUrl}/chat/completions` with OpenAI-compatible chat-completions JSON. No paid SDK is used.

## Safety Model

The agent loop executes one action at a time:

1. Content script observes readable page text and visible interactive elements.
2. Background service worker asks the model for strict JSON.
3. `src/background/safety.ts` validates the action.
4. Hard safety blocks stop unsupported or sensitive actions.
5. Content script executes the validated action and observes again.

The extension refuses CAPTCHA/security bypass, paywall bypass, secret extraction, and sensitive-field typing. For quizzes and tests, it can explain, suggest, fill, select, or drag answers at the user's request.

API keys are profile-local extension data, not a secure vault. Use scoped, revocable keys.

## Model Response Format

The model must return strict JSON only:

```json
{
  "thought_summary": "short user-visible reasoning",
  "risk_level": "low",
  "action": {
    "type": "click",
    "elementId": "optional",
    "targetElementId": "optional",
    "text": "optional",
    "key": "Tab",
    "url": "optional",
    "direction": "down"
  }
}
```

Supported action types are `click`, `drag`, `fill`, `type`, `select`, `press_key`, `scroll`, `navigate`, `extract`, `ask_user`, and `done`. For drag-and-drop widgets, the model uses `elementId` as the draggable item and `targetElementId` as the destination.

## Known First-Version Limits

- Only `http` and `https` pages are supported.
- Browser internal pages, extension store pages, some PDFs, and restricted pages cannot be controlled.
- The DOM mapper is intentionally small and visible-element focused.
- Drag-and-drop support uses synthetic pointer, mouse, and HTML5 drag events. Some sites only accept browser-trusted physical drag gestures, so specific quiz widgets may need targeted handling.
- Strong API-key encryption is not implemented because no user-held secret is collected.
