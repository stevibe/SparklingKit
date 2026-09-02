import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Activity, AudioLines, ChevronRight, CircleAlert, Clock3, Eye, EyeOff, FileCog, Files, Image as ImageIcon, Languages, LoaderCircle, Plus, Save, ScanSearch, ScanText, Server, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { cn } from "../components/ui";
import { SearchSelect } from "../components/SearchSelect";
import { useToast } from "../components/ToastProvider";
import { announceSettingsUpdated } from "../settings-events";
import type { EndpointHealth, EndpointKind, ModelInputCapability, PromptPreset, Settings } from "../types";

type SettingsServiceKind = EndpointKind | "system-status";

const endpointMeta: Record<EndpointKind, { title: string; caption: string; tint: string; icon: typeof AudioLines }> = {
  stt: { title: "Speech to text", caption: "Audio and video transcription", tint: "endpoint-icon endpoint-stt", icon: AudioLines },
  ocr: { title: "Document OCR", caption: "Images and scanned PDF documents", tint: "endpoint-icon endpoint-ocr", icon: ScanText },
  llm: { title: "Language model", caption: "Chat and prompt-powered transformations", tint: "endpoint-icon endpoint-llm", icon: Sparkles },
  translation: { title: "Translation", caption: "Dedicated multilingual translation model", tint: "endpoint-icon endpoint-translation", icon: Languages },
  grounding: { title: "Grounding", caption: "Evidence location, highlighting, and redaction", tint: "endpoint-icon endpoint-grounding", icon: ScanSearch },
  "image-generation": { title: "Image generation", caption: "Text prompts to generated images", tint: "endpoint-icon endpoint-image-generation", icon: ImageIcon },
};

const systemStatusMeta = {
  title: "System monitor",
  caption: "Host, GPU, memory, and model status",
  tint: "endpoint-icon endpoint-system-status",
  icon: Activity,
};

const settingsSections = [
  { key: "general" as const, label: "General", title: "General", description: "Regional preferences", icon: Clock3 },
  { key: "services" as const, label: "Services", title: "Model services", description: "Endpoints and models", icon: Server },
  { key: "processing" as const, label: "Processing", title: "Processing", description: "Jobs and recovery", icon: SlidersHorizontal },
  { key: "prompts" as const, label: "Prompts", title: "Prompt presets", description: "Reusable instructions", icon: FileCog },
];

const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const timezoneOptions = (() => {
  try {
    const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
    return supportedValuesOf ? supportedValuesOf("timeZone") : ["UTC", browserTimezone];
  } catch {
    return ["UTC", browserTimezone];
  }
})();

type AudioProfile = "balanced" | "low-memory" | "high-throughput" | "custom";

const audioProfiles: Record<Exclude<AudioProfile, "custom">, { label: string; description: string; values: Omit<Settings["audio"], "sampleRate"> }> = {
  balanced: {
    label: "Balanced",
    description: "Safe defaults for most local models and workstations.",
    values: { chunkTargetSec: 60, chunkOverlapSec: 3, maxCompletionTokens: 2048, requestTimeoutSec: 180, adaptiveSplit: true, minAdaptiveChunkSec: 15 },
  },
  "low-memory": {
    label: "Low-memory",
    description: "Smaller requests for constrained or slower hardware.",
    values: { chunkTargetSec: 30, chunkOverlapSec: 2, maxCompletionTokens: 1024, requestTimeoutSec: 240, adaptiveSplit: true, minAdaptiveChunkSec: 10 },
  },
  "high-throughput": {
    label: "High-throughput",
    description: "Larger requests for fast models with generous context limits.",
    values: { chunkTargetSec: 120, chunkOverlapSec: 3, maxCompletionTokens: 2048, requestTimeoutSec: 180, adaptiveSplit: true, minAdaptiveChunkSec: 15 },
  },
};

function audioProfile(audio: Settings["audio"]): AudioProfile {
  for (const [key, profile] of Object.entries(audioProfiles) as Array<[Exclude<AudioProfile, "custom">, typeof audioProfiles.balanced]>) {
    if (Object.entries(profile.values).every(([field, value]) => audio[field as keyof Settings["audio"]] === value)) return key;
  }
  return "custom";
}

export function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [settings, setSettings] = useState<Settings>();
  const [prompts, setPrompts] = useState<PromptPreset[]>([]);
  const [tests, setTests] = useState<Partial<Record<EndpointKind, EndpointHealth | "testing">>>({});
  const [showKeys, setShowKeys] = useState<Partial<Record<EndpointKind, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"general" | "services" | "processing" | "prompts">("general");
  const [selectedService, setSelectedService] = useState<SettingsServiceKind>();
  const [editingPrompt, setEditingPrompt] = useState<PromptPreset>();
  const toast = useToast();
  const activeSection = settingsSections.find((section) => section.key === tab)!;
  const selectedServiceMeta = selectedService === "system-status" ? systemStatusMeta : selectedService ? endpointMeta[selectedService] : undefined;

  function close() {
    const hasBackground = Boolean((location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation);
    if (hasBackground) navigate(-1);
    else navigate("/", { replace: true });
  }

  useEffect(() => {
    Promise.all([api.settings(), api.prompts()]).then(([loadedSettings, loadedPrompts]) => { setSettings(loadedSettings); setPrompts(loadedPrompts); }).catch((value) => setError(value.message));
  }, []);
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editingPrompt) setEditingPrompt(undefined);
      else if (selectedService) setSelectedService(undefined);
      else close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editingPrompt, location.state, selectedService]);

  function selectSection(section: typeof tab) {
    setTab(section);
    setSelectedService(undefined);
  }

  async function save() {
    if (!settings || saving) return;
    setSaving(true);
    setError("");
    try {
      const savedSettings = await api.saveSettings(settings);
      setSettings(savedSettings);
      announceSettingsUpdated(savedSettings);
      toast.success("Settings saved", "Your changes are now active.");
    }
    catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
    finally { setSaving(false); }
  }
  async function test(kind: EndpointKind) {
    if (!settings) return;
    setTests((value) => ({ ...value, [kind]: "testing" }));
    try { const result = await api.testEndpoint(kind, settings.endpoints[kind]); setTests((value) => ({ ...value, [kind]: result })); }
    catch (testError) { setTests((value) => ({ ...value, [kind]: { kind, ok: false, latencyMs: 0, model: settings.endpoints[kind].model, availableModels: [], error: testError instanceof Error ? testError.message : String(testError) } })); }
  }
  function endpointChange(kind: EndpointKind, field: "baseUrl" | "model" | "apiKey", value: string) {
    setSettings((current) => current ? ({ ...current, endpoints: { ...current.endpoints, [kind]: { ...current.endpoints[kind], [field]: value } } }) : current);
  }
  function endpointCapabilityChange(kind: EndpointKind, capability: ModelInputCapability, enabled: boolean) {
    setSettings((current) => {
      if (!current) return current;
      const endpoint = current.endpoints[kind];
      const capabilities = new Set(endpoint.capabilities || ["text"]);
      if (enabled) capabilities.add(capability);
      else capabilities.delete(capability);
      capabilities.add("text");
      return { ...current, endpoints: { ...current.endpoints, [kind]: { ...endpoint, capabilities: [...capabilities] } } };
    });
  }
  function selectAudioProfile(profile: AudioProfile) {
    if (!settings || profile === "custom") return;
    setSettings({ ...settings, audio: { ...settings.audio, ...audioProfiles[profile].values } });
  }
  async function savePreset(prompt: PromptPreset) {
    const savedPrompt = await api.savePrompt(prompt);
    setPrompts((items) => [...items.filter((item) => item.slug !== savedPrompt.slug), savedPrompt].sort((a, b) => a.name.localeCompare(b.name)));
    setEditingPrompt(undefined);
    toast.success("Prompt preset saved", savedPrompt.name);
  }

  return (
    <div className="settings-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav" aria-label="Settings categories">
          <div className="settings-modal-nav-head"><button className="settings-close-button" onClick={close} aria-label="Close settings"><X size={22} /></button></div>
          <p className="settings-nav-label">Categories</p>
          <div className="settings-nav-list">{settingsSections.map(({ key, label, description, icon: Icon }) => <button key={key} className={tab === key ? "active" : ""} onClick={() => selectSection(key)} aria-current={tab === key ? "page" : undefined}><Icon size={18} /><span><strong>{label}</strong><small>{description}</small></span></button>)}</div>
        </nav>

        <main className="settings-panel">
          <header className="settings-dialog-header">
            <div className="settings-dialog-title">
              {selectedService && <button className="settings-level-back" onClick={() => setSelectedService(undefined)} aria-label="Back to model services"><ChevronRight size={20} /></button>}
              <div><h1 id="settings-title">{selectedServiceMeta?.title || activeSection.title}</h1><p>{selectedServiceMeta?.caption || activeSection.description}</p></div>
            </div>
            <div className="settings-dialog-actions">
              {tab === "prompts" && <button className="button-secondary" onClick={() => setEditingPrompt(blankPrompt())}><Plus size={16} />New preset</button>}
              {tab !== "prompts" && !(tab === "services" && !selectedService) && settings && <button className="button-primary" onClick={save} disabled={saving}>{saving ? <><LoaderCircle size={16} className="animate-spin" />Saving…</> : <><Save size={16} />Save changes</>}</button>}
            </div>
          </header>
          {error && <div className="error-card settings-error"><CircleAlert size={18} />{error}</div>}
          {!settings ? <div className="settings-loading"><div className="skeleton h-40" /><div className="skeleton h-40" /></div> : <div className="settings-panel-body">
          {tab === "general" && <section>
            <div className="settings-section-block"><h3>Region and time</h3><div className="settings-group settings-value-group">
              <div className="settings-value-row"><span><strong>Time zone</strong><small>Used for displayed dates and times, and when naming new job and conversation folders. Existing work is not renamed.</small></span><span className="timezone-setting-control"><SearchSelect value={settings.ui.timezone} onChange={(timezone) => setSettings({ ...settings, ui: { ...settings.ui, timezone } })} options={[...(!["UTC", ...timezoneOptions].includes(settings.ui.timezone) ? [{ value: settings.ui.timezone, label: settings.ui.timezone.replaceAll("_", " ") }] : []), { value: "UTC", label: "UTC" }, ...timezoneOptions.filter((timezone) => timezone !== "UTC").map((timezone) => ({ value: timezone, label: timezone.replaceAll("_", " ") }))]} searchPlaceholder="Search time zones" emptyMessage="No time zones found" ariaLabel="Time zone" /><button className="button-secondary compact" onClick={() => setSettings({ ...settings, ui: { ...settings.ui, timezone: browserTimezone } })}>Use device time zone</button></span></div>
            </div><p className="settings-footnote">This device reports <strong>{browserTimezone.replaceAll("_", " ")}</strong>.</p></div>
            <div className="settings-section-block"><h3>Deployment</h3><div className="settings-group settings-value-group">
              <div className="settings-value-row settings-deployment-row"><span><strong>Application and model services</strong><small>Choose whether SparklingKit and the reference models share one DGX Spark, run on separate hosts, or use independently configured services.</small></span><span className="settings-deployment-control"><strong>{deploymentModeLabel(settings.setup.mode)}</strong><button className="button-secondary compact" onClick={() => navigate("/setup")}>Change setup</button></span></div>
            </div><p className="settings-footnote">Changing the setup verifies and updates service endpoints. Your jobs, chats, workflows, and files are not removed.</p></div>
          </section>}
          {tab === "services" && !selectedService && <section className="settings-section-block">
            <h3>System</h3>
            <div className="settings-group settings-service-list">
              <button className="settings-service-row" onClick={() => setSelectedService("system-status")}>
                <span className={systemStatusMeta.tint}><Activity size={18} /></span>
                <span className="settings-service-copy"><strong>{systemStatusMeta.title}</strong><small>{systemStatusMeta.caption}</small></span>
                <span className="settings-service-summary"><strong>{settings.systemStatus.baseUrl || "No endpoint configured"}</strong><small className={settings.systemStatus.baseUrl ? "ready" : ""}>{settings.systemStatus.baseUrl ? "Visible" : "Hidden"}</small></span>
                <ChevronRight size={18} />
              </button>
            </div>
            <h3 className="settings-service-section-title">AI services</h3>
            <div className="settings-group settings-service-list">{(["stt", "ocr", "llm", "translation", "grounding", "image-generation"] as EndpointKind[]).map((kind) => {
              const meta = endpointMeta[kind]; const endpoint = settings.endpoints[kind]; const Icon = meta.icon;
              const configured = Boolean(endpoint.baseUrl && endpoint.model);
              const state = !endpoint.enabled ? "Disabled" : configured ? "Enabled" : "Needs setup";
              return <button className="settings-service-row" key={kind} onClick={() => setSelectedService(kind)}>
                <span className={meta.tint}><Icon size={18} /></span>
                <span className="settings-service-copy"><strong>{meta.title}</strong><small>{meta.caption}</small></span>
                <span className="settings-service-summary"><strong>{endpoint.model || "No model selected"}</strong><small className={cn(endpoint.enabled && configured ? "ready" : endpoint.enabled ? "warning" : "")}>{state}</small></span>
                <ChevronRight size={18} />
              </button>;
            })}</div>
            <p className="settings-footnote">Select an item to configure its connection and availability.</p>
          </section>}

          {tab === "services" && selectedService === "system-status" && <section className="settings-service-detail">
            <div className="settings-section-block"><h3>Connection</h3><div className="settings-group">
              <div className="settings-service-enable-row"><div className="settings-group-identity"><span className={systemStatusMeta.tint}><Activity size={18} /></span><div><h3>Sidebar status</h3><p>Show live machine and accelerator information.</p></div></div><div className="settings-group-actions"><span className={cn("status-badge", settings.systemStatus.baseUrl ? "status-done" : "status-idle")}>{settings.systemStatus.baseUrl ? "Visible" : "Hidden"}</span></div></div>
              <div className="settings-control-grid">
                <label className="field-label settings-control-full">Base URL <span className="font-normal text-muted">(optional)</span><input className="input mt-2" value={settings.systemStatus.baseUrl} placeholder="http://dgx-spark.local:8330" onChange={(event) => setSettings({ ...settings, systemStatus: { baseUrl: event.target.value } })} /></label>
              </div>
            </div><p className="settings-footnote">SparklingKit reads <strong>/v1/status</strong> from this service. Clear the URL and save to hide the machine-status block from the sidebar.</p></div>
          </section>}

          {tab === "services" && selectedService && selectedService !== "system-status" && (() => {
            const kind = selectedService as EndpointKind; const meta = endpointMeta[kind]; const endpoint = settings.endpoints[kind]; const result = tests[kind]; const Icon = meta.icon;
            return <section className="settings-service-detail">
              <div className="settings-section-block"><h3>Connection</h3><div className="settings-group">
                <div className="settings-service-enable-row"><div className="settings-group-identity"><span className={meta.tint}><Icon size={18} /></span><div><h3>Service availability</h3><p>Allow SparklingKit to use this endpoint.</p></div></div><div className="settings-group-actions">{result && result !== "testing" && <span className={cn("status-badge", result.ok ? "status-done" : "status-failed")}>{result.ok ? `${result.latencyMs} ms` : result.enabled ? "Offline" : "Disabled"}</span>}<label className={cn("settings-toggle", endpoint.enabled && "active")} title={`Enable ${meta.title}`}><input type="checkbox" checked={endpoint.enabled} onChange={(event) => setSettings({ ...settings, endpoints: { ...settings.endpoints, [kind]: { ...endpoint, enabled: event.target.checked } } })} /><i /></label><button className="button-secondary compact" onClick={() => test(kind)} disabled={result === "testing" || !endpoint.enabled}>{result === "testing" ? <><LoaderCircle size={15} className="animate-spin" /><span>Testing</span></> : <><span className="test-label-full">Test connection</span><span className="test-label-short">Test</span></>}</button></div></div>
                <div className="settings-control-grid">
                  <label className="field-label settings-control-wide">Base URL<input className="input mt-2" value={endpoint.baseUrl} onChange={(event) => endpointChange(kind, "baseUrl", event.target.value)} /></label>
                  <label className="field-label">Model<input className="input mt-2" value={endpoint.model} onChange={(event) => endpointChange(kind, "model", event.target.value)} /></label>
                  <label className="field-label settings-control-full">API key <span className="font-normal text-muted">(optional)</span><span className="relative mt-2 block"><input className="input pr-11" type={showKeys[kind] ? "text" : "password"} value={endpoint.apiKey} placeholder="Not required for local endpoints" onChange={(event) => endpointChange(kind, "apiKey", event.target.value)} /><button className="settings-secret-toggle" onClick={() => setShowKeys((value) => ({ ...value, [kind]: !value[kind] }))} type="button" aria-label={showKeys[kind] ? "Hide API key" : "Show API key"}>{showKeys[kind] ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
                </div>
                {kind === "llm" && <div className="settings-capabilities"><div><strong>Accepted inputs</strong><small>Controls which linked materials SparklingKit may send to this model.</small></div><div className="settings-capability-options"><label><input type="checkbox" checked disabled /><span><strong>Text</strong><small>Required for chat</small></span></label><label><input type="checkbox" checked={endpoint.capabilities?.includes("image") || false} onChange={(event) => endpointCapabilityChange(kind, "image", event.target.checked)} /><span><strong>Images</strong><small>OpenAI-compatible image input</small></span></label></div></div>}
                {result && result !== "testing" && !result.ok && <p className="settings-inline-error">{result.error}</p>}
                {result && result !== "testing" && result.ok && result.availableModels.length > 0 && !result.availableModels.includes(endpoint.model) && <p className="settings-inline-warning">Connected, but the configured model was not advertised. Available: {result.availableModels.join(", ")}</p>}
              </div><p className="settings-footnote">Changes take effect after you save. Connection tests use the values currently shown above.</p></div>
            </section>;
          })()}

          {tab === "processing" && <section>
            <div className="settings-section-block"><h3>Transcription processing</h3><div className="settings-group settings-processing-group">
              <label className="settings-profile-row"><span><strong>Processing profile</strong><small>{audioProfile(settings.audio) === "custom" ? "Your custom transcription limits and recovery behavior." : audioProfiles[audioProfile(settings.audio) as Exclude<AudioProfile, "custom">].description}</small></span><SearchSelect className="settings-profile-select" value={audioProfile(settings.audio)} onChange={(value) => selectAudioProfile(value as AudioProfile)} options={[{ value: "balanced", label: "Balanced" }, { value: "low-memory", label: "Low-memory" }, { value: "high-throughput", label: "High-throughput" }, { value: "custom", label: "Custom" }]} searchPlaceholder="Search profiles" ariaLabel="Processing profile" /></label>
              <details className="settings-advanced"><summary><span><strong>Advanced transcription settings</strong><small>Model limits, request timing, and adaptive recovery</small></span><ChevronRight size={17} /></summary><div className="settings-advanced-body">
                <NumberSetting label="Processing window" description="Audio sent to the speech model in each request." value={settings.audio.chunkTargetSec} suffix="seconds" min={15} max={3600} onChange={(value) => setSettings({ ...settings, audio: { ...settings.audio, chunkTargetSec: value } })} />
                <NumberSetting label="Window overlap" description="Context repeated at window boundaries to avoid clipped words." value={settings.audio.chunkOverlapSec} suffix="seconds" min={0} max={30} step={0.5} onChange={(value) => setSettings({ ...settings, audio: { ...settings.audio, chunkOverlapSec: value } })} />
                <NumberSetting label="Maximum output tokens" description="Stops a model from generating an unbounded transcript for one window." value={settings.audio.maxCompletionTokens} suffix="tokens" min={128} max={32768} onChange={(value) => setSettings({ ...settings, audio: { ...settings.audio, maxCompletionTokens: value } })} />
                <NumberSetting label="Request timeout" description="Maximum time allowed for one speech-model request." value={settings.audio.requestTimeoutSec} suffix="seconds" min={15} max={3600} onChange={(value) => setSettings({ ...settings, audio: { ...settings.audio, requestTimeoutSec: value } })} />
                <ToggleSetting label="Adaptive recovery" description="Automatically divide only a difficult section and retry it at smaller sizes." checked={settings.audio.adaptiveSplit} onChange={(value) => setSettings({ ...settings, audio: { ...settings.audio, adaptiveSplit: value } })} />
                <NumberSetting label="Smallest recovery window" description="Adaptive retries will not divide audio below this duration." value={settings.audio.minAdaptiveChunkSec} suffix="seconds" min={5} max={300} onChange={(value) => setSettings({ ...settings, audio: { ...settings.audio, minAdaptiveChunkSec: value } })} />
              </div></details>
            </div><p className="settings-footnote">New jobs use these values. A recovering job keeps its original window layout so completed work remains valid.</p></div>
            <div className="settings-section-block"><h3>Workflow behavior</h3><div className="settings-group settings-info-group"><div className="settings-info-row"><span className="settings-row-icon"><AudioLines size={18} /></span><div><strong>Complete transcripts</strong><p>Long recordings are split and merged automatically into one continuous transcript.</p></div><small>Automatic</small></div><div className="settings-info-row"><span className="settings-row-icon"><Files size={18} /></span><div><strong>Complete OCR documents</strong><p>PDF pages and image sets are processed in the background and delivered as one document.</p></div><small>Automatic</small></div></div></div>
            <div className="settings-section-block"><h3>Jobs and storage</h3><div className="settings-group settings-value-group">
              <NumberSetting label="Concurrent jobs" description="Maximum number of jobs processed at the same time." value={settings.queue.workers} onChange={(value) => setSettings({ ...settings, queue: { ...settings.queue, workers: value } })} />
              <NumberSetting label="Recovery attempts" description="Retries for a failed model request before recording a warning." value={settings.queue.maxRetriesPerChunk} onChange={(value) => setSettings({ ...settings, queue: { ...settings.queue, maxRetriesPerChunk: value } })} />
              <NumberSetting label="Keep recovery data" description="Days to retain private intermediate files used to resume work." value={settings.retention.purgeWorkDirAfterDays} suffix="days" onChange={(value) => setSettings({ ...settings, retention: { purgeWorkDirAfterDays: value } })} />
            </div><p className="settings-footnote">Concurrent job changes take effect after the server restarts. Other changes apply to newly queued jobs.</p></div>
          </section>}

          {tab === "prompts" && <section>
            <div className="settings-section-block"><h3>Your presets</h3><div className="settings-group preset-list">{prompts.map((prompt) => <button key={prompt.slug} className="preset-row" onClick={() => setEditingPrompt(structuredClone(prompt))}><span className="preset-row-icon"><FileCog size={17} /></span><span className="min-w-0 flex-1 text-left"><strong>{prompt.name}</strong><small>{prompt.description}</small></span><span className="preset-slug">{prompt.slug}</span><ChevronRight size={17} className="text-muted" /></button>)}</div></div>
          </section>}
          </div>}
        </main>
      </div>

      {editingPrompt && <PromptEditor prompt={editingPrompt} onClose={() => setEditingPrompt(undefined)} onSave={savePreset} />}
    </div>
  );
}

function NumberSetting({ label, description, value, suffix, min, max, step, onChange }: { label: string; description: string; value: number; suffix?: string; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="settings-value-row"><span><strong>{label}</strong><small>{description}</small></span><span className="settings-number-control"><input className="input" type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <small>{suffix}</small>}</span></label>;
}

function ToggleSetting({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="settings-value-row"><span><strong>{label}</strong><small>{description}</small></span><span className={cn("settings-toggle", checked && "active")}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></span></label>;
}

function deploymentModeLabel(mode: Settings["setup"]["mode"]) {
  if (mode === "all-in-one") return "One DGX Spark";
  if (mode === "split") return "Split deployment";
  return "Custom services";
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="field-label">{label}<input className="input mt-2" type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function PromptEditor({ prompt: initial, onClose, onSave }: { prompt: PromptPreset; onClose: () => void; onSave: (prompt: PromptPreset) => Promise<void> }) {
  const [prompt, setPrompt] = useState(initial); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function save() { setSaving(true); setError(""); try { await onSave(prompt); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } finally { setSaving(false); } }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal-card"><div className="flex items-start justify-between"><div><p className="eyebrow">PROMPT PRESET</p><h2 className="mt-1 text-xl font-semibold">{initial.name || "New preset"}</h2></div><button className="button-ghost" onClick={onClose}>Close</button></div><div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="field-label">Name<input className="input mt-2" value={prompt.name} onChange={(e) => setPrompt({ ...prompt, name: e.target.value })} /></label><label className="field-label">Slug<input className="input mt-2" value={prompt.slug} onChange={(e) => setPrompt({ ...prompt, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label></div><label className="field-label mt-4 block">Description<input className="input mt-2" value={prompt.description} onChange={(e) => setPrompt({ ...prompt, description: e.target.value })} /></label><label className="field-label mt-4 block">System prompt<textarea className="input mt-2 min-h-24" value={prompt.system} onChange={(e) => setPrompt({ ...prompt, system: e.target.value })} /></label><label className="field-label mt-4 block">User template <span className="font-normal text-muted">(must include {"{{text}}"})</span><textarea className="input mt-2 min-h-36 font-mono text-[16px]" value={prompt.userTemplate} onChange={(e) => setPrompt({ ...prompt, userTemplate: e.target.value })} /></label><div className="mt-4 grid gap-4 sm:grid-cols-3"><NumberField label="Temperature" value={prompt.params.temperature} onChange={(value) => setPrompt({ ...prompt, params: { ...prompt.params, temperature: value } })} /><NumberField label="Max output tokens" value={prompt.params.maxTokens} onChange={(value) => setPrompt({ ...prompt, params: { ...prompt.params, maxTokens: value } })} /><NumberField label="Max input tokens" value={prompt.chunking.maxInputTokens} onChange={(value) => setPrompt({ ...prompt, chunking: { ...prompt.chunking, maxInputTokens: value } })} /></div>{error && <p className="mt-4 text-sm text-red-600">{error}</p>}<div className="mt-6 flex justify-end gap-2"><button className="button-secondary" onClick={onClose}>Cancel</button><button className="button-primary" onClick={save} disabled={saving}>{saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}Save preset</button></div></div></div>;
}

function blankPrompt(): PromptPreset {
  return { name: "", slug: "", description: "", system: "You are a precise and helpful editor.", userTemplate: "Process the following source:\n\n{{text}}", params: { temperature: 0.2, maxTokens: 4096 }, chunking: { maxInputTokens: 24000, strategy: "map-reduce" } };
}
