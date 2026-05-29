# BYOK AI Browser Agent

A minimal Manifest V3 Chrome/Edge extension that runs a bring-your-own-key AI browser agent. The user configures an OpenAI-compatible or Gemini-compatible API endpoint, enters a task, and the extension observes the current page, asks the model for one JSON action, validates it, executes it, and repeats until done or stopped.

## File Tree

```text
.
├── index.html
├── package.json
├── public
│   └── manifest.json
├── src
│   ├── background
│   │   ├── chromeAsync.ts
│   │   ├── index.ts
│   │   ├── modelClient.ts
│   │   ├── prompts.ts
│   │   └── safety.ts
│   ├── content
│   │   ├── actions.ts
│   │   ├── domMap.ts
│   │   └── index.ts
│   ├── popup
│   │   ├── App.tsx
│   │   ├── components
│   │   │   ├── ActionLog.tsx
│   │   │   ├── ConfirmationCard.tsx
│   │   │   ├── SettingsPanel.tsx
│   │   │   └── TaskRunner.tsx
│   │   ├── main.tsx
│   │   └── styles.css
│   └── shared
│       ├── defaults.ts
│       ├── ids.ts
│       ├── storage.ts
│       └── types.ts
├── tsconfig.json
└── vite.config.ts
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

For local iteration, run `npm run build` after changes and reload the unpacked extension.

## Provider Settings

The popup settings support:

- `provider`: OpenAI-compatible, Gemini-compatible, Groq, or custom.
- `apiBaseUrl`: defaults to `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`, or `https://api.groq.com/openai/v1`.
- `apiKey`: stored with `chrome.storage.local`.
- `model`: any model name accepted by the configured compatible endpoint.
- `maxSteps`: maximum observe/act loop iterations.

The extension uses `fetch` against `POST {apiBaseUrl}/chat/completions` with OpenAI-compatible chat-completions JSON. No paid SDK is used.

## Safety Model

The agent loop executes one action at a time:

1. Content script observes readable page text and visible interactive elements.
2. Background service worker asks the model for strict JSON.
3. `src/background/safety.ts` validates the action.
4. Hard safety blocks stop unsupported or sensitive actions.
5. Content script executes the validated action and observes again.

The extension refuses CAPTCHA/security bypass, paywall bypass, secret extraction, and sensitive-field typing. For quizzes and tests, it can explain, suggest, fill, or select answers at the user's request.

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
    "text": "optional",
    "url": "optional",
    "direction": "down"
  }
}
```

Supported action types are `click`, `type`, `select`, `scroll`, `navigate`, `extract`, `ask_user`, and `done`.

## Known First-Version Limits

- Only `http` and `https` pages are supported.
- Browser internal pages, extension store pages, some PDFs, and restricted pages cannot be controlled.
- The DOM mapper is intentionally small and visible-element focused.
- Confirmation state is kept in the service worker while it is active.
- Strong API-key encryption is not implemented because no user-held secret is collected.
