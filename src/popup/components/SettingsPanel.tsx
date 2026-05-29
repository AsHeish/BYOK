import { PROVIDER_DEFAULT_BASE_URLS, PROVIDER_DEFAULT_MODELS } from "../../shared/defaults";
import type { AgentSettings, Provider } from "../../shared/types";

interface SettingsPanelProps {
  settings: AgentSettings;
  onChange: (settings: AgentSettings) => void;
  onSave: () => Promise<void>;
}

export function SettingsPanel({ settings, onChange, onSave }: SettingsPanelProps) {
  function updateProvider(provider: Provider) {
    const currentDefaultModel = PROVIDER_DEFAULT_MODELS[settings.provider];
    const shouldReplaceModel = !settings.model.trim() || settings.model === currentDefaultModel;

    onChange({
      ...settings,
      provider,
      apiBaseUrl: provider === "custom" ? settings.apiBaseUrl : PROVIDER_DEFAULT_BASE_URLS[provider],
      model: shouldReplaceModel && provider !== "custom" ? PROVIDER_DEFAULT_MODELS[provider] : settings.model
    });
  }

  return (
    <section className="panel settings-panel" aria-label="Settings">
      <div className="field-grid">
        <label>
          Provider
          <select value={settings.provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
            <option value="openai">OpenAI-compatible</option>
            <option value="gemini">Gemini-compatible</option>
            <option value="groq">Groq</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <label>
          API base URL
          <input
            value={settings.apiBaseUrl}
            onChange={(event) => onChange({ ...settings, apiBaseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />
        </label>

        <label>
          API key
          <input
            value={settings.apiKey}
            onChange={(event) => onChange({ ...settings, apiKey: event.target.value })}
            placeholder={settings.provider === "groq" ? "gsk_..." : "sk-..."}
            type="password"
            spellCheck={false}
          />
        </label>

        <label>
          Model
          <input
            value={settings.model}
            onChange={(event) => onChange({ ...settings, model: event.target.value })}
            placeholder={settings.provider === "groq" ? "llama-3.3-70b-versatile" : "gpt-4o-mini"}
            spellCheck={false}
          />
        </label>

        <label>
          Max steps
          <input
            value={settings.maxSteps}
            min={1}
            max={30}
            type="number"
            onChange={(event) =>
              onChange({
                ...settings,
                maxSteps: Number(event.target.value)
              })
            }
          />
        </label>
      </div>

      <p className="storage-note">Stored locally in this browser profile. Use scoped, revocable keys.</p>

      <button className="primary-button full-width" onClick={onSave}>
        Save Settings
      </button>
    </section>
  );
}
