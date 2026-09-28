import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, LoaderCircle, RefreshCw, Save, Trash2, Upload, Wifi } from "lucide-react";
import {
  DEFAULT_JEV_PROFILE_ID,
  JEV_MODEL,
  MAX_REQUEST_TIMEOUT_SECONDS,
  MIN_REQUEST_TIMEOUT_SECONDS,
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
  onTestConnection: (settings: AgentSettings, target?: "jev") => Promise<{ latencyMs: number }>;
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
  const [jevNotice, setJevNotice] = useState<string | undefined>();
  const [testingConnection, setTestingConnection] = useState(false);
  const [importingProfiles, setImportingProfiles] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveProfileTarget, setSaveProfileTarget] = useState<AiConfigurationProfile>();
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void refreshProfiles();
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
  );
  const jevSelected = Boolean(settings.jev && settings.jev.mode !== "off");
  const jevOnly = settings.jev?.mode === "only";
  const canUpdateSelectedProfile = Boolean(selectedProfile && (selectedProfile.id !== DEFAULT_JEV_PROFILE_ID || jevOnly));

  function selectProvider(provider: Provider | "jev" | "jev-only") {
    if (provider === "jev" || provider === "jev-only") {
      if (provider === "jev-only") {
        setSelectedProfileId(DEFAULT_JEV_PROFILE_ID);
      }
      onChange({
        ...settings,
        jev: {
          apiKey: settings.jev?.apiKey || (provider === "jev-only" ? profiles.find((profile) => profile.id === DEFAULT_JEV_PROFILE_ID)?.jev?.apiKey : "") || "",
          mode: provider === "jev-only" ? "only" : settings.jev?.mode === "shadow" ? "shadow" : "fast",
        },
      });
      return;
    }
    updateProvider(provider);
  }

  function updateProvider(provider: Provider, keepJev = false) {
    const currentDefaultModel = PROVIDER_DEFAULT_MODELS[settings.provider];
    const shouldReplaceModel =
      !settings.model.trim() || settings.model === currentDefaultModel;

    onChange({
      ...settings,
      provider,
      jev: keepJev ? settings.jev : settings.jev ? { ...settings.jev, mode: "off" } : undefined,
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
        : settings.jev?.mode === "only" ? DEFAULT_JEV_PROFILE_ID : nextProfiles[0]?.id || "",
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
    if (!selectedProfile || !canUpdateSelectedProfile) {
      setProfileNotice("Choose a matching saved profile first.");
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

  async function handleSaveSettings(profileToUpdate?: AiConfigurationProfile) {
    setSavingSettings(true);
    let settingsSaved = false;
    try {
      await onSave();
      settingsSaved = true;
      if (profileToUpdate) {
        const nextProfiles = await updateConfigurationProfile(profileToUpdate.id, settings);
        setProfiles(nextProfiles);
      }
      setSaveProfileTarget(undefined);
      setProfileNotice(profileToUpdate ? `Settings saved and "${profileToUpdate.name}" updated.` : "Settings saved.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfileNotice(settingsSaved ? `Settings saved, but the profile update failed: ${message}` : message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestConnection(target?: "jev") {
    const showNotice = target === "jev" ? setJevNotice : setProfileNotice;
    setTestingConnection(true);
    showNotice("Testing connection...");
    try {
      const result = await onTestConnection(settings, target);
      showNotice(`${target === "jev" ? "Jev connection" : "Connection"} successful (${result.latencyMs.toLocaleString()} ms).`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
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
            disabled={testingConnection || (jevOnly ? !settings.jev?.apiKey.trim() : !settings.apiBaseUrl.trim() || !settings.apiKey.trim() || !settings.model.trim())}
            onClick={() => void handleTestConnection(jevOnly ? "jev" : undefined)}
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
            disabled={profiles.length === 0 || savingSettings || Boolean(saveProfileTarget)}
          >
            {profiles.length === 0 ? (
              <option value="">No saved profiles</option>
            ) : null}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} - {profile.jev?.mode === "only" ? `Jev Only / ${JEV_MODEL}` : `${profile.jev && profile.jev.mode !== "off" ? "Jev + " : ""}${profile.provider} / ${profile.model}`}
              </option>
            ))}
          </select>
        </label>

        <div className="button-row profile-record-actions">
          <button
            className="primary-button button-with-icon"
            disabled={!selectedProfile || savingSettings || Boolean(saveProfileTarget)}
            onClick={() => void handleApplyProfile()}
          >
            <Check aria-hidden="true" />
            Apply
          </button>
          <button
            className="secondary-button button-with-icon"
            disabled={!canUpdateSelectedProfile || savingSettings || Boolean(saveProfileTarget)}
            onClick={() => void handleUpdateProfile()}
          >
            <RefreshCw aria-hidden="true" />
            Update
          </button>
          <button
            className="primary-button button-with-icon"
            aria-label="Save Settings"
            title="Save settings"
            disabled={savingSettings || Boolean(saveProfileTarget)}
            onClick={() => selectedProfile && canUpdateSelectedProfile ? setSaveProfileTarget(selectedProfile) : void handleSaveSettings()}
          >
            {savingSettings ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
            Save
          </button>
        </div>

        {saveProfileTarget ? (
          <div className="profile-save-prompt" role="group" aria-label="Save settings confirmation">
            <p>Save settings and update "{saveProfileTarget.name}"?</p>
            <div className="button-row profile-save-actions">
              <button
                className="primary-button button-with-icon"
                disabled={savingSettings}
                onClick={() => void handleSaveSettings(saveProfileTarget)}
              >
                <Save aria-hidden="true" />
                Save &amp; Update
              </button>
              <button className="secondary-button" disabled={savingSettings} onClick={() => void handleSaveSettings()}>
                Save Only
              </button>
              <button className="secondary-button" disabled={savingSettings} onClick={() => setSaveProfileTarget(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

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
          <button
            className="danger-button subtle-danger button-with-icon profile-delete-button"
            aria-label="Delete profile"
            title={selectedProfile?.id === DEFAULT_JEV_PROFILE_ID ? "The default Jev profile cannot be deleted" : "Delete profile"}
            disabled={!selectedProfile || selectedProfile.id === DEFAULT_JEV_PROFILE_ID || savingSettings || Boolean(saveProfileTarget)}
            onClick={() => void handleDeleteProfile()}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>

        {profileNotice ? (
          <p className="profile-notice" role="status">{profileNotice}</p>
        ) : null}
      </div>

      <div className="field-grid">
        <label>
          Provider
          <select
            value={jevOnly ? "jev-only" : jevSelected ? "jev" : settings.provider}
            onChange={(event) => selectProvider(event.target.value as Provider | "jev" | "jev-only")}
          >
            <option value="openai">OpenAI-compatible</option>
            <option value="gemini">Gemini-compatible</option>
            <option value="groq">Groq</option>
            <option value="custom">Custom</option>
            <option value="jev">Jev + LLM (hybrid)</option>
            <option value="jev-only">Jev Only (browser actions)</option>
          </select>
        </label>

        {jevSelected && !jevOnly ? (
          <label>
            LLM planner provider
            <select value={settings.provider} onChange={(event) => updateProvider(event.target.value as Provider, true)}>
              <option value="openai">OpenAI-compatible</option>
              <option value="gemini">Gemini-compatible</option>
              <option value="groq">Groq</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        ) : null}

        {!jevOnly ? <>
        <label>
          {jevSelected ? "LLM API base URL" : "API base URL"}
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
          {jevSelected ? "LLM API key" : "API key"}
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
          {jevSelected ? "LLM model" : "Model"}
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

        <label
          className="checkbox-setting"
          title="Request non-thinking generation from the provider. Some models require reasoning or ignore unsupported options. Test Connection checks whether the API accepts this setting."
        >
          <input
            type="checkbox"
            checked={settings.disableThinking === true}
            onChange={(event) => onChange({ ...settings, disableThinking: event.target.checked })}
          />
          <span>Disable model thinking</span>
        </label>
        {settings.disableThinking ? <p className="storage-note">Provider/model support required. Mandatory-reasoning models cannot turn thinking off.</p> : null}

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
            min={MIN_REQUEST_TIMEOUT_SECONDS}
            max={MAX_REQUEST_TIMEOUT_SECONDS}
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

        </> : null}

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

      <fieldset className="jev-settings">
        <legend>{jevOnly ? "Jev Only (experimental)" : "Jev actions (experimental)"}</legend>
        <label>
          TypeSafe API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={settings.jev?.apiKey || ""}
            onChange={(event) => onChange({
              ...settings,
              jev: { mode: settings.jev?.mode || "off", apiKey: event.target.value },
            })}
          />
        </label>
        {!jevOnly ? <div className="jev-mode-control" role="group" aria-label="Jev action mode">
          {(["off", "shadow", "fast"] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              aria-pressed={(settings.jev?.mode || "off") === mode}
              disabled={mode !== "off" && !settings.jev?.apiKey.trim()}
              title={mode === "off" ? "Use only the LLM" : mode === "shadow" ? "Record Jev choices without executing them" : "Jev chooses actions; the LLM supplies missing text or handles unsupported tasks"}
              onClick={() => onChange({ ...settings, jev: { apiKey: settings.jev?.apiKey || "", mode } })}
            >
              {mode === "off" ? "Off" : mode === "shadow" ? "Shadow" : "Fast"}
            </button>
          ))}
        </div> : null}
        <label>
          Jev model
          <input value={JEV_MODEL} readOnly />
        </label>
        <button
          type="button"
          className="secondary-button button-with-icon"
          disabled={testingConnection || !settings.jev?.apiKey.trim()}
          onClick={() => void handleTestConnection("jev")}
        >
          {testingConnection ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wifi aria-hidden="true" />}
          Test Jev
        </button>
        {jevNotice ? <p className="profile-notice" role="status">{jevNotice}</p> : null}
        <p className="storage-note">TypeSafe receives the task, page URL/title, up to 6,000 characters of page text, eligible controls and recent actions. {jevOnly ? "No LLM requests." : "Fast can send field context to the configured LLM for text generation and return unsupported tasks to the LLM planner."} Profile exports include saved keys.</p>
      </fieldset>

      <p className="storage-note">
        Stored locally in this browser profile. Use scoped, revocable keys.
      </p>
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
