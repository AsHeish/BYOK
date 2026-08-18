import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, LoaderCircle, RefreshCw, Save, Trash2, Upload, Wifi } from "lucide-react";
import {
  PROVIDER_DEFAULT_BASE_URLS,
  PROVIDER_DEFAULT_MODELS,
} from "../../shared/defaults";
import {
  applyConfigurationProfile,
  deleteConfigurationProfile,
  importConfigurationProfiles,
  loadConfigurationProfiles,
  saveConfigurationProfile,
  saveSettings,
  serializeConfigurationProfiles,
  updateConfigurationProfile,
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
  onTestConnection: (settings: AgentSettings) => Promise<{ latencyMs: number }>;
}

export function SettingsPanel({
  settings,
  onChange,
  onSave,
  onTestConnection,
}: SettingsPanelProps) {
  const [profileName, setProfileName] = useState("");
  const [profiles, setProfiles] = useState<AiConfigurationProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileNotice, setProfileNotice] = useState<string | undefined>();
  const [testingConnection, setTestingConnection] = useState(false);
  const [importingProfiles, setImportingProfiles] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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
      setProfileName("");
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

  async function handleUpdateProfile() {
    if (!selectedProfile) {
      setProfileNotice("Choose a saved profile first.");
      return;
    }

    try {
      const nextProfiles = await updateConfigurationProfile(selectedProfile.id, settings);
      setProfiles(nextProfiles);
      setProfileNotice(`Updated "${selectedProfile.name}".`);
    } catch (error) {
      setProfileNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    setProfileNotice("Testing connection...");
    try {
      const result = await onTestConnection(settings);
      setProfileNotice(`Connection successful (${result.latencyMs.toLocaleString()} ms).`);
    } catch (error) {
      setProfileNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setTestingConnection(false);
    }
  }

  function handleExportProfiles() {
    try {
      const blob = new Blob([serializeConfigurationProfiles(profiles)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `byok-ai-profiles-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setProfileNotice(`Exported ${profiles.length} profile${profiles.length === 1 ? "" : "s"} with API keys.`);
    } catch (error) {
      setProfileNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleImportProfiles(file?: File) {
    if (!file) {
      return;
    }

    setImportingProfiles(true);
    setProfileNotice("Importing profiles...");
    try {
      const imported = await importConfigurationProfiles(JSON.parse(await file.text()));
      setProfiles(imported.profiles);
      setSelectedProfileId(imported.importedIds[0] || imported.profiles[0]?.id || "");
      setProfileNotice(`Imported ${imported.importedIds.length} profile${imported.importedIds.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setProfileNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingProfiles(false);
    }
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
          New profile name
          <input
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder="Work Groq, Personal OpenAI..."
            spellCheck={false}
          />
        </label>

        <div className="button-row profile-create-actions">
          <button
            className="secondary-button button-with-icon"
            disabled={testingConnection || !settings.apiBaseUrl.trim() || !settings.apiKey.trim() || !settings.model.trim()}
            onClick={() => void handleTestConnection()}
          >
            {testingConnection ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wifi aria-hidden="true" />}
            {testingConnection ? "Testing..." : "Test Connection"}
          </button>
          <button
            className="primary-button button-with-icon"
            disabled={!profileName.trim()}
            onClick={() => void handleSaveProfile()}
          >
            <Save aria-hidden="true" />
            Save Profile
          </button>
        </div>

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

        <div className="button-row profile-record-actions">
          <button
            className="primary-button button-with-icon"
            disabled={!selectedProfile}
            onClick={() => void handleApplyProfile()}
          >
            <Check aria-hidden="true" />
            Apply
          </button>
          <button
            className="secondary-button button-with-icon"
            disabled={!selectedProfile}
            onClick={() => void handleUpdateProfile()}
          >
            <RefreshCw aria-hidden="true" />
            Update
          </button>
          <button
            className="danger-button subtle-danger button-with-icon"
            disabled={!selectedProfile}
            onClick={() => void handleDeleteProfile()}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </button>
        </div>

        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleImportProfiles(file);
          }}
        />
        <div className="button-row profile-transfer-actions">
          <button
            className="secondary-button button-with-icon"
            disabled={importingProfiles}
            onClick={() => importInputRef.current?.click()}
          >
            {importingProfiles ? <LoaderCircle className="spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
            {importingProfiles ? "Importing..." : "Import"}
          </button>
          <button
            className="secondary-button button-with-icon"
            disabled={profiles.length === 0}
            onClick={handleExportProfiles}
          >
            <Download aria-hidden="true" />
            Export
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

        <label>
          AI timeout seconds
          <input
            value={settings.requestTimeoutSeconds}
            min={10}
            max={300}
            type="number"
            onChange={(event) =>
              onChange({
                ...settings,
                requestTimeoutSeconds: Number(event.target.value),
              })
            }
          />
        </label>

        <label>
          Prompt cache
          <select
            value={settings.promptCacheMode}
            onChange={(event) =>
              onChange({
                ...settings,
                promptCacheMode: event.target.value as AgentSettings["promptCacheMode"],
              })
            }
          >
            <option value="auto">Auto: provider/model aware</option>
            <option value="on">On: send cache hints</option>
            <option value="off">Off</option>
          </select>
        </label>

        <label>
          Input cost / 1M
          <input
            value={settings.inputTokenCostPerMillion ?? ""}
            min={0}
            step="0.000001"
            type="number"
            onChange={(event) =>
              onChange({
                ...settings,
                inputTokenCostPerMillion: parseOptionalNumber(event.target.value),
              })
            }
            placeholder="Optional USD rate"
          />
        </label>

        <label>
          Cached input / 1M
          <input
            value={settings.cachedInputTokenCostPerMillion ?? ""}
            min={0}
            step="0.000001"
            type="number"
            onChange={(event) =>
              onChange({
                ...settings,
                cachedInputTokenCostPerMillion: parseOptionalNumber(event.target.value),
              })
            }
            placeholder="Defaults to input rate"
          />
        </label>

        <label>
          Output cost / 1M
          <input
            value={settings.outputTokenCostPerMillion ?? ""}
            min={0}
            step="0.000001"
            type="number"
            onChange={(event) =>
              onChange({
                ...settings,
                outputTokenCostPerMillion: parseOptionalNumber(event.target.value),
              })
            }
            placeholder="Optional USD rate"
          />
        </label>

        <label className="checkbox-setting">
          <input
            type="checkbox"
            checked={settings.saveRunHistory}
            onChange={(event) =>
              onChange({ ...settings, saveRunHistory: event.target.checked })
            }
          />
          <span>Save run reports locally</span>
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

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
