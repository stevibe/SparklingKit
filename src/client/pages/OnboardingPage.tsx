import { useMemo, useState } from "react";
import { Check, CircleAlert, Copy, Cpu, Eye, EyeOff, LoaderCircle, Network, ServerCog, Settings2 } from "lucide-react";
import { api } from "../api";
import { cn } from "../components/ui";
import { useToast } from "../components/ToastProvider";
import { ENDPOINT_KINDS, type EndpointConfig, type EndpointHealth, type EndpointKind, type Settings } from "../../shared/contracts";
import { referenceSettingsForHost } from "../../shared/reference-stack";

type OnboardingTab = "local" | "remote" | "manual";
type InstallSource = "hosted" | "github";

const serviceLabels: Record<EndpointKind, string> = {
  llm: "Multimodal LLM",
  ocr: "OCR",
  stt: "Transcription",
  translation: "Translation",
  grounding: "Grounding",
  "image-generation": "Image generation",
};

const serviceDescriptions: Record<EndpointKind, string> = {
  llm: "Chat, summaries, prompts, and optional image references",
  ocr: "Text extraction from images and scanned PDFs",
  stt: "Audio and video transcription",
  translation: "Dedicated multilingual translation",
  grounding: "Locate objects and regions inside images",
  "image-generation": "Generate images from text prompts",
};

const hostedInstallCommand = "curl -fsSL https://run.sparklingkit.com/dgx/stable/install.sh | bash -s -- --accept-model-licenses";
const githubInstallCommand = `git clone --depth 1 https://github.com/stevibe/SparklingKit.git
cd SparklingKit
./scripts/start-dgx-models.sh --accept-model-licenses`;

export function OnboardingPage({ settings, canCancel, onComplete, onCancel }: {
  settings: Settings;
  canCancel: boolean;
  onComplete: (settings: Settings) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<OnboardingTab>(settings.setup.mode === "split" ? "remote" : settings.setup.mode === "custom" && canCancel ? "manual" : "local");
  const [installSource, setInstallSource] = useState<InstallSource>("hosted");
  const [remoteHost, setRemoteHost] = useState(guessReferenceHost(settings));
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings));
  const [referenceChecks, setReferenceChecks] = useState<Partial<Record<EndpointKind, EndpointHealth | "testing">>>({});
  const [manualChecks, setManualChecks] = useState<Partial<Record<EndpointKind, EndpointHealth | "testing">>>({});
  const [verifiedReference, setVerifiedReference] = useState<Settings>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKeys, setShowKeys] = useState<Partial<Record<EndpointKind, boolean>>>({});
  const [error, setError] = useState("");
  const toast = useToast();
  const configuredCount = useMemo(() => ENDPOINT_KINDS.filter((kind) => isConfigured(settings.endpoints[kind])).length, [settings]);
  const manualConfiguredCount = ENDPOINT_KINDS.filter((kind) => isConfigured(draft.endpoints[kind])).length;

  function changeTab(next: OnboardingTab) {
    setTab(next);
    setError("");
    setVerifiedReference(undefined);
    setReferenceChecks({});
  }

  async function copyText(value: string, label = "Command copied") {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(label);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  async function verifyReference() {
    if (checking) return;
    setChecking(true);
    setError("");
    setVerifiedReference(undefined);
    setReferenceChecks(Object.fromEntries(ENDPOINT_KINDS.map((kind) => [kind, "testing"])));
    try {
      const host = tab === "local" ? "host.docker.internal" : remoteHost;
      const candidate = referenceSettingsForHost(settings, host, tab === "local" ? "all-in-one" : "split");
      const results = await Promise.all(ENDPOINT_KINDS.map(async (kind) => {
        try {
          return [kind, await api.testEndpoint(kind, candidate.endpoints[kind])] as const;
        } catch (value) {
          return [kind, failedHealth(kind, candidate.endpoints[kind], value)] as const;
        }
      }));
      const checks = Object.fromEntries(results) as Record<EndpointKind, EndpointHealth>;
      setReferenceChecks(checks);
      const failures = results.filter(([, result]) => !result.ok).map(([kind]) => serviceLabels[kind]);
      if (failures.length) {
        setError(`${6 - failures.length}/6 AI services responded. Check ${failures.join(", ")} and try again.`);
        return;
      }
      setVerifiedReference(candidate);
      toast.success("Six services verified", "Review the connection and apply when ready.");
    } catch (value) {
      setReferenceChecks({});
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setChecking(false);
    }
  }

  async function applyReference() {
    if (!verifiedReference || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api.saveSettings(verifiedReference);
      toast.success("Deployment connected", "Your jobs, chats, workflows, and files were preserved.");
      onComplete(saved);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  function updateEndpoint(kind: EndpointKind, patch: Partial<EndpointConfig>) {
    setDraft((current) => ({
      ...current,
      endpoints: {
        ...current.endpoints,
        [kind]: {
          ...current.endpoints[kind],
          ...patch,
          ...(patch.baseUrl?.trim() ? { enabled: true } : {}),
        },
      },
    }));
    setManualChecks((current) => ({ ...current, [kind]: undefined }));
    setError("");
  }

  async function testManualEndpoint(kind: EndpointKind) {
    const endpoint = draft.endpoints[kind];
    setManualChecks((current) => ({ ...current, [kind]: "testing" }));
    try {
      const result = await api.testEndpoint(kind, endpoint);
      setManualChecks((current) => ({ ...current, [kind]: result }));
    } catch (value) {
      setManualChecks((current) => ({ ...current, [kind]: failedHealth(kind, endpoint, value) }));
    }
  }

  async function saveManualSetup() {
    if (saving || manualConfiguredCount === 0) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api.saveSettings({ ...draft, setup: { completed: true, mode: "custom", onboardingVersion: 1, completedAt: new Date().toISOString() } });
      toast.success("Manual setup saved", `${manualConfiguredCount} service${manualConfiguredCount === 1 ? "" : "s"} configured.`);
      onComplete(saved);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  const installCommand = installSource === "hosted" ? hostedInstallCommand : githubInstallCommand;

  return <main className="onboarding-page">
    <div className="onboarding-shell">
      <header className="onboarding-header">
        <div className="brand-wordmark">SparklingKit</div>
        {canCancel && <button className="button-secondary compact" onClick={onCancel}>Back to workspace</button>}
      </header>

      <section className="onboarding-content onboarding-setup">
        <div className="onboarding-intro">
          <span>{canCancel ? "Deployment setup" : "Welcome to SparklingKit"}</span>
          <h1>Connect your AI services</h1>
          <p>Run the six-model reference stack on a DGX Spark or connect compatible services you already operate. SparklingKit keeps the workspace and inference layers independent.</p>
        </div>

        {canCancel && configuredCount > 0 && <div className="onboarding-existing-note">
          <CircleAlert size={20} />
          <span><strong>You already have {configuredCount} configured service{configuredCount === 1 ? "" : "s"}.</strong><small>Nothing changes until you apply this setup. Jobs, chats, workflows, and files will not be removed.</small></span>
        </div>}

        <div className="onboarding-tabs" role="tablist" aria-label="AI service deployment">
          <button className={tab === "local" ? "active" : ""} onClick={() => changeTab("local")} role="tab" aria-selected={tab === "local"}><Cpu size={18} /><span><strong>Run models locally</strong><small>DGX and app on this machine</small></span></button>
          <button className={tab === "remote" ? "active" : ""} onClick={() => changeTab("remote")} role="tab" aria-selected={tab === "remote"}><Network size={18} /><span><strong>Run models remotely</strong><small>DGX on another machine</small></span></button>
          <button className={tab === "manual" ? "active" : ""} onClick={() => changeTab("manual")} role="tab" aria-selected={tab === "manual"}><Settings2 size={18} /><span><strong>Configure manually</strong><small>Local or cloud endpoints</small></span></button>
        </div>

        {tab !== "manual" ? <div className="onboarding-tab-panel" role="tabpanel">
          <div className="onboarding-panel-heading">
            <span className="onboarding-option-icon">{tab === "local" ? <Cpu size={24} /> : <Network size={24} />}</span>
            <div><h2>{tab === "local" ? "Start the model stack on this machine" : "Start the model stack on your DGX Spark"}</h2><p>{tab === "local" ? "Local means the server running this SparklingKit container, not the phone or computer viewing this page." : "Use the same six-model installer, then provide an address reachable from the SparklingKit server."}</p></div>
          </div>

          <div className="onboarding-step"><span>1</span><div><h3>Install and start the six models</h3><p>Model weights remain on the DGX and are downloaded from their publishers.</p></div></div>
          <div className="onboarding-source-tabs"><button className={installSource === "hosted" ? "active" : ""} onClick={() => setInstallSource("hosted")}>Hosted installer</button><button className={installSource === "github" ? "active" : ""} onClick={() => setInstallSource("github")}>GitHub source</button></div>
          <div className="onboarding-command"><span><ServerCog size={18} /><code>{installCommand}</code></span><button onClick={() => void copyText(installCommand)} aria-label="Copy model installation command"><Copy size={17} /></button></div>
          <p className="onboarding-script-note">The hosted one-liner verifies the release bundle checksum and never installs Docker itself. It also installs <code>./sparklingkit-dgx</code> for future stack updates and rollback. Choose GitHub source if you prefer to inspect the files first.</p>

          <div className="onboarding-step onboarding-connect-step"><span>2</span><div><h3>{tab === "local" ? "Verify local services" : "Connect this workspace"}</h3><p>{tab === "local" ? "SparklingKit uses Docker's host gateway to reach ports 8331–8336." : "Ports 8330–8336 must be reachable from this server over a trusted LAN or VPN."}</p></div></div>
          {tab === "remote" && <label className="onboarding-host-field">DGX hostname or IP<input className="input" value={remoteHost} onChange={(event) => { setRemoteHost(event.target.value); setVerifiedReference(undefined); setReferenceChecks({}); setError(""); }} placeholder="192.168.22.33 or dgx-spark.local" /></label>}

          <ReferenceChecks checks={referenceChecks} />
          {error && <p className="onboarding-error" role="alert">{error}</p>}
          <div className="onboarding-review-note"><strong>Applying this preset updates six service URLs, six model names, and the optional system-monitor URL.</strong><span>It does not change workspace data or processing settings.</span></div>
          <div className="onboarding-actions">{canCancel && <button className="button-secondary" onClick={onCancel}>Cancel</button>}{!verifiedReference ? <button className="button-primary" onClick={() => void verifyReference()} disabled={checking || (tab === "remote" && !remoteHost.trim())}>{checking ? <><LoaderCircle size={18} className="animate-spin" />Checking six services…</> : "Verify services"}</button> : <button className="button-primary" onClick={() => void applyReference()} disabled={saving}>{saving ? <><LoaderCircle size={18} className="animate-spin" />Applying…</> : <><Check size={18} />Apply and continue</>}</button>}</div>
        </div> : <div className="onboarding-tab-panel onboarding-manual-panel" role="tabpanel">
          <div className="onboarding-panel-heading"><span className="onboarding-option-icon"><Settings2 size={24} /></span><div><h2>Configure services independently</h2><p>Add any compatible local, network, or cloud endpoint. You only need to configure the capabilities you plan to use.</p></div></div>

          <div className="onboarding-manual-list">{ENDPOINT_KINDS.map((kind) => {
            const endpoint = draft.endpoints[kind];
            const result = manualChecks[kind];
            return <section className="onboarding-manual-service" key={kind}>
              <header><div><strong>{serviceLabels[kind]}</strong><small>{serviceDescriptions[kind]}</small></div><label className={cn("settings-toggle", endpoint.enabled && "active")} title={`Enable ${serviceLabels[kind]}`}><input type="checkbox" checked={endpoint.enabled} onChange={(event) => updateEndpoint(kind, { enabled: event.target.checked })} /><i /></label></header>
              <div className="onboarding-manual-fields">
                <label>Base URL<input className="input" value={endpoint.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateEndpoint(kind, { baseUrl: event.target.value })} /></label>
                <label>Model<input className="input" value={endpoint.model} onChange={(event) => updateEndpoint(kind, { model: event.target.value })} /></label>
                <label className="onboarding-secret-field">API key <span>(optional)</span><span><input className="input" type={showKeys[kind] ? "text" : "password"} value={endpoint.apiKey} placeholder="Not required for most local services" onChange={(event) => updateEndpoint(kind, { apiKey: event.target.value })} /><button onClick={() => setShowKeys((current) => ({ ...current, [kind]: !current[kind] }))} aria-label={showKeys[kind] ? "Hide API key" : "Show API key"}>{showKeys[kind] ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
              </div>
              {kind === "llm" && <label className="onboarding-capability"><input type="checkbox" checked={endpoint.capabilities?.includes("image") || false} onChange={(event) => updateEndpoint(kind, { capabilities: event.target.checked ? ["text", "image"] : ["text"] })} /><span><strong>Accept image references</strong><small>Enable only if the configured LLM supports multimodal input.</small></span></label>}
              <footer><EndpointResult result={result} /><button className="button-secondary compact" onClick={() => void testManualEndpoint(kind)} disabled={!endpoint.enabled || !endpoint.baseUrl.trim() || !endpoint.model.trim() || result === "testing"}>{result === "testing" ? <><LoaderCircle size={15} className="animate-spin" />Testing…</> : "Test connection"}</button></footer>
            </section>;
          })}</div>

          <label className="onboarding-monitor-field">Optional system monitor URL<input className="input" value={draft.systemStatus.baseUrl} placeholder="http://dgx-spark.local:8330" onChange={(event) => setDraft((current) => ({ ...current, systemStatus: { baseUrl: event.target.value } }))} /><small>Leave empty to hide the GPU and memory status block.</small></label>
          {error && <p className="onboarding-error" role="alert">{error}</p>}
          <div className="onboarding-actions"><span>{manualConfiguredCount ? `${manualConfiguredCount} service${manualConfiguredCount === 1 ? "" : "s"} ready to save` : "Configure at least one enabled service to continue"}</span>{canCancel && <button className="button-secondary" onClick={onCancel}>Cancel</button>}<button className="button-primary" onClick={() => void saveManualSetup()} disabled={saving || manualConfiguredCount === 0}>{saving ? <><LoaderCircle size={18} className="animate-spin" />Saving…</> : "Save and continue"}</button></div>
        </div>}
      </section>
    </div>
  </main>;
}

function ReferenceChecks({ checks }: { checks: Partial<Record<EndpointKind, EndpointHealth | "testing">> }) {
  if (!Object.keys(checks).length) return null;
  return <div className="onboarding-reference-checks">{ENDPOINT_KINDS.map((kind) => {
    const result = checks[kind];
    return <div className={cn(result !== "testing" && result?.ok ? "online" : result === "testing" ? "checking" : "offline")} key={kind}><span>{result === "testing" ? <LoaderCircle size={16} className="animate-spin" /> : result?.ok ? <Check size={16} /> : <i />}</span><strong>{serviceLabels[kind]}</strong><small>{result === "testing" ? "Checking…" : result?.ok ? `${result.latencyMs} ms` : result?.error || "Unavailable"}</small></div>;
  })}</div>;
}

function EndpointResult({ result }: { result?: EndpointHealth | "testing" }) {
  if (!result) return <span className="onboarding-endpoint-result">Not tested</span>;
  if (result === "testing") return <span className="onboarding-endpoint-result">Checking endpoint…</span>;
  return <span className={cn("onboarding-endpoint-result", result.ok ? "online" : "offline")}>{result.ok ? <><Check size={14} />Connected · {result.latencyMs} ms</> : <><CircleAlert size={14} />{result.error || "Connection failed"}</>}</span>;
}

function isConfigured(endpoint: EndpointConfig) {
  return endpoint.enabled && Boolean(endpoint.baseUrl.trim() && endpoint.model.trim());
}

function guessReferenceHost(settings: Settings) {
  const baseUrl = settings.endpoints.llm.baseUrl;
  if (!baseUrl) return "";
  try {
    const host = new URL(baseUrl).hostname;
    return host === "host.docker.internal" ? "" : host;
  } catch {
    return "";
  }
}

function failedHealth(kind: EndpointKind, endpoint: EndpointConfig, value: unknown): EndpointHealth {
  return { kind, ok: false, enabled: endpoint.enabled, latencyMs: 0, model: endpoint.model, availableModels: [], error: value instanceof Error ? value.message : String(value) };
}
