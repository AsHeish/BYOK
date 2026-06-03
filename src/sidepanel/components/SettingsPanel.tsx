import { useEffect, useMemo, useState } from "react";
import {
  PROVIDER_DEFAULT_BASE_URLS,
  PROVIDER_DEFAULT_MODELS,
} from "../../shared/defaults";
import {
  applyConfigurationProfile,
  deleteConfigurationProfile,
  loadConfigurationProfiles,
  saveConfigurationProfile,
  saveSettings,
} from "../../shared/storage";
import type {
  AgentSettings,
  AiConfigurationProfile,
  Provider,
} from "../../shared/types";

interface SettingsPanelProps {
  settings: AgentSettings;
  onChange: (settings: AgentSettings) => void;
  onSave: () => Promise<void>;
}

export function SettingsPanel({
  settings,
  onChange,
  onSave,
}: SettingsPanelProps) {
  const [profileName, setProfileName] = useState("");
  const [profiles, setProfiles] = useState<AiConfigurationProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileNotice, setProfileNotice] = useState<string | undefined>();

  useEffect(() => {
    void refreshProfiles();
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
  );

  function updateProvider(provider: Provider) {
    const currentDefaultModel = PROVIDER_DEFAULT_MODELS[settings.provider];
    const shouldReplaceModel =
      !settings.model.trim() || settings.model === currentDefaultModel;

    onChange({
      ...settings,
      provider,
      apiBaseUrl:
        provider === "custom"
          ? settings.apiBaseUrl
          : PROVIDER_DEFAULT_BASE_URLS[provider],
      model:
        shouldReplaceModel && provider !== "custom"
          ? PROVIDER_DEFAULT_MODELS[provider]
          : settings.model,
    });
  }

  async function refreshProfiles() {
    const nextProfiles = await loadConfigurationProfiles();
    setProfiles(nextProfiles);
    setSelectedProfileId((current) =>
      current && nextProfiles.some((profile) => profile.id === current)
        ? current
        : nextProfiles[0]?.id || "",
    );
  }

  async function handleSaveProfile() {
    try {
      const nextProfiles = await saveConfigurationProfile(
        profileName,
        settings,
      );
      const saved = nextProfiles.find(
        (profile) =>
          profile.name.toLowerCase() === profileName.trim().toLowerCase(),
      );
      setProfiles(nextProfiles);
      setSelectedProfileId(saved?.id || nextProfiles[0]?.id || "");
      setProfileNotice(`Saved "${profileName.trim()}".`);
    } catch (error) {
      setProfileNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleApplyProfile() {
    if (!selectedProfile) {
      setProfileNotice("Choose a saved profile first.");
      return;
    }

    const nextSettings = applyConfigurationProfile(settings, selectedProfile);
    onChange(nextSettings);
    await saveSettings(nextSettings);
    setProfileNotice(`Applied "${selectedProfile.name}".`);
  }

  async function handleDeleteProfile() {
    if (!selectedProfile) {
      setProfileNotice("Choose a saved profile first.");
      return;
    }

    const nextProfiles = await deleteConfigurationProfile(selectedProfile.id);
    setProfiles(nextProfiles);
    setSelectedProfileId(nextProfiles[0]?.id || "");
    setProfileNotice(`Deleted "${selectedProfile.name}".`);
  }

  return (
    <section className="panel settings-panel" aria-label="Settings">
      <div className="profile-box">
        <div className="section-heading compact-heading">
          <h2>AI Profiles</h2>
          <span>{profiles.length}</span>
        </div>

        <label>
          Save current as
          <div className="inline-control">
            <input
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder="Work Groq, Personal OpenAI..."
              spellCheck={false}
            />
            <button
              className="secondary-button"
              disabled={!profileName.trim()}
              onClick={() => void handleSaveProfile()}
            >
              Save
            </button>
          </div>
        </label>

        <label>
          Saved profiles
          <select
            value={selectedProfileId}
            onChange={(event) => setSelectedProfileId(event.target.value)}
            disabled={profiles.length === 0}
          >
            {profiles.length === 0 ? (
              <option value="">No saved profiles</option>
            ) : null}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} - {profile.provider} / {profile.model}
              </option>
            ))}
          </select>
        </label>

        <div className="button-row">
          <button
            className="primary-button"
            disabled={!selectedProfile}
            onClick={() => void handleApplyProfile()}
          >
            Apply
          </button>
          <button
            className="danger-button subtle-danger"
            disabled={!selectedProfile}
            onClick={() => void handleDeleteProfile()}
          >
            Delete
          </button>
        </div>

        {profileNotice ? (
          <p className="profile-notice">{profileNotice}</p>
        ) : null}
      </div>

      <div className="field-grid">
        <label>
          Provider
          <select
            value={settings.provider}
            onChange={(event) => updateProvider(event.target.value as Provider)}
          >
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
            onChange={(event) =>
              onChange({ ...settings, apiBaseUrl: event.target.value })
            }
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />
        </label>

        <label>
          API key
          <input
            value={settings.apiKey}
            onChange={(event) =>
              onChange({ ...settings, apiKey: event.target.value })
            }
            placeholder={settings.provider === "groq" ? "gsk_..." : "sk-..."}
            type="password"
            spellCheck={false}
          />
        </label>

        <label>
          Model
          <input
            value={settings.model}
            onChange={(event) =>
              onChange({ ...settings, model: event.target.value })
            }
            placeholder={
              settings.provider === "groq"
                ? "llama-3.3-70b-versatile"
                : "gpt-4o-mini"
            }
            spellCheck={false}
          />
        </label>

        <label>
          Max steps
          <input
            value={settings.maxSteps}
            min={1}
            max={60}
            type="number"
            onChange={(event) =>
              onChange({
                ...settings,
                maxSteps: Number(event.target.value),
              })
            }
          />
        </label>
      </div>

      <p className="storage-note">
        Stored locally in this browser profile. Use scoped, revocable keys.
      </p>

      <button className="primary-button full-width" onClick={onSave}>
        Save Settings
      </button>
    </section>
  );
}
