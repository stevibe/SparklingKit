import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { ArrowLeftRight, ArrowRight, AudioLines, CloudUpload, ExternalLink, FileText, FolderOpen, Image as ImageIcon, Languages, MessageCircle, ScanSearch, ScanText, Search, X } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, uploadGroundingJob, uploadJob } from "../api";
import { cn, JobIcon, StatusBadge, timeAgo } from "../components/ui";
import { moduleWorkflowForArtifact } from "../../shared/module-router";
import { savedTranslationPreferences, translationLanguages, translationPreferenceKey } from "../translation";
import type { Job, JobKind, ModuleDescriptor, ModuleId } from "../types";
import { useGlobalSearch } from "../components/GlobalSearch";

export { translationLanguages } from "../translation";

const icons = {
  "scan-text": ScanText,
  "audio-lines": AudioLines,
  languages: Languages,
  "scan-search": ScanSearch,
  image: ImageIcon,
  "message-circle": MessageCircle,
};

const moduleHistoryTitles: Record<ModuleId, string> = {
  ocr: "OCR documents",
  transcription: "Transcriptions",
  translation: "Translations",
  grounding: "Located images",
  "text-to-image": "Generated images",
  chat: "Conversations",
};

const translationDebounceMs = 600;

function useModules() {
  const [modules, setModules] = useState<ModuleDescriptor[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { api.modules().then(setModules).catch((value) => setError(value instanceof Error ? value.message : String(value))); }, []);
  return { modules, error };
}

export function ModulesPage() {
  const { modules, error } = useModules();
  return <div className="page-wrap content-page modules-page">
    <header className="workspace-heading"><div><h1>Tools for daily work</h1><p>Start with a file, then carry its results into the next task without uploading it again.</p></div></header>
    {error && <div className="error-card">{error}</div>}
    {!modules.length && !error ? <div className="module-grid">{Array.from({ length: 5 }, (_, index) => <div className="skeleton module-card-skeleton" key={index} />)}</div> : <div className="module-grid">
      {modules.map((module) => {
        const Icon = icons[module.icon];
        return <Link className="module-card" to={module.route} key={module.id}>
          <span className={`module-card-icon module-card-icon-${module.id}`}><Icon size={24} /></span>
          <span className="module-card-copy"><span className="module-card-title"><strong>{module.title}</strong>{module.implementation === "planned" && <small>Planned</small>}</span><span>{module.description}</span></span>
          <ArrowRight size={19} />
        </Link>;
      })}
    </div>}
  </div>;
}

export function ModulePage() {
  const { moduleId = "" } = useParams();
  const { modules, error: loadError } = useModules();
  const module = modules.find((candidate) => candidate.id === moduleId);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState("");
  const [translationMode, setTranslationMode] = useState<"document" | "text">("text");
  const [sourceLanguage, setSourceLanguage] = useState(() => savedTranslationPreferences().source);
  const [targetLanguage, setTargetLanguage] = useState(() => savedTranslationPreferences().target);
  const [recentLanguages, setRecentLanguages] = useState(() => savedTranslationPreferences().recent);
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [translationJobId, setTranslationJobId] = useState("");
  const [translationPending, setTranslationPending] = useState(false);
  const [translatingPreview, setTranslatingPreview] = useState(false);
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [translationError, setTranslationError] = useState("");
  const [groundingQueries, setGroundingQueries] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageSize, setImageSize] = useState("1024x1024");
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const translationPreviewController = useRef<AbortController | undefined>(undefined);
  const importedPromptRef = useRef("");
  const onDrop = useCallback((accepted: File[]) => { setFiles(accepted); setSelectedArtifact(""); setError(""); }, []);
  const accepts = useMemo<Record<string, string[]>>(() => Object.fromEntries(moduleId === "ocr"
    ? [["image/*", []], ["application/pdf", [".pdf"]]]
    : moduleId === "grounding"
      ? [["image/png", [".png"]], ["image/jpeg", [".jpg", ".jpeg"]], ["image/webp", [".webp"]]]
      : [["audio/*", []], ["video/*", []]]), [moduleId]);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: accepts, maxFiles: moduleId === "grounding" ? 1 : 100, disabled: uploading || !module || module.implementation !== "ready" });
  useEffect(() => {
    if (moduleId === "chat") return;
    let active = true;
    const refresh = () => api.jobs().then((result) => active && setJobs(result.jobs)).catch((value) => active && setError(value instanceof Error ? value.message : String(value)));
    void refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [moduleId]);
  useEffect(() => {
    if (moduleId !== "translation") return;
    localStorage.setItem(translationPreferenceKey, JSON.stringify({ source: sourceLanguage, target: targetLanguage, recent: recentLanguages }));
  }, [moduleId, recentLanguages, sourceLanguage, targetLanguage]);
  useEffect(() => {
    translationPreviewController.current?.abort();
    if (moduleId !== "translation" || translationMode !== "text") {
      setTranslationPending(false);
      setTranslatingPreview(false);
      return;
    }
    const text = sourceText.trim();
    if (!text || !module?.configured) {
      setTranslationPending(false);
      setTranslatingPreview(false);
      if (!text) setTranslatedText("");
      return;
    }
    setTranslationJobId("");
    setTranslationPending(true);
    setTranslationError("");
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      translationPreviewController.current = controller;
      setTranslationPending(false);
      setTranslatingPreview(true);
      api.previewTranslation(text, sourceLanguage, targetLanguage, controller.signal)
        .then(({ text: result }) => { if (!controller.signal.aborted) setTranslatedText(result); })
        .catch((value) => { if (!controller.signal.aborted) setTranslationError(value instanceof Error ? value.message : String(value)); })
        .finally(() => { if (!controller.signal.aborted) setTranslatingPreview(false); });
    }, translationDebounceMs);
    return () => {
      window.clearTimeout(timer);
      translationPreviewController.current?.abort();
    };
  }, [module?.configured, moduleId, sourceLanguage, sourceText, targetLanguage, translationMode]);
  const compatibleArtifacts = jobs.flatMap((job) => job.artifacts
    .filter((artifact) => Boolean(module?.accepts.includes(artifact.kind)))
    .map((artifact) => ({ job, artifact, value: `${job.id}|${artifact.id}` })));
  const selectedArtifactEntry = compatibleArtifacts.find((entry) => entry.value === selectedArtifact);
  useEffect(() => {
    if (selectedArtifact || !compatibleArtifacts.length) return;
    const requested = `${searchParams.get("job") || ""}|${searchParams.get("artifact") || ""}`;
    if (compatibleArtifacts.some((entry) => entry.value === requested)) {
      setSelectedArtifact(requested);
      if (moduleId === "translation") setTranslationMode("document");
    }
  }, [compatibleArtifacts, moduleId, searchParams, selectedArtifact]);
  useEffect(() => {
    if (moduleId !== "text-to-image" || !selectedArtifactEntry || importedPromptRef.current === selectedArtifactEntry.value) return;
    importedPromptRef.current = selectedArtifactEntry.value;
    fetch(artifactUrl(selectedArtifactEntry.job.id, selectedArtifactEntry.artifact))
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the selected text result");
        return response.text();
      })
      .then((content) => setImagePrompt(content.replace(/<!--[\s\S]*?-->\s*/g, "").trim().slice(0, 12_000)))
      .catch((value) => setError(value instanceof Error ? value.message : String(value)));
  }, [moduleId, selectedArtifactEntry]);

  if (moduleId === "chat") return <Navigate to="/chat" replace />;
  if (!modules.length && !loadError) return <div className="page-wrap content-page"><div className="skeleton h-64" /></div>;
  if (!module) return <Navigate to="/tools" replace />;
  const Icon = icons[module.icon];
  const canUpload = module.id === "ocr" || module.id === "transcription";

  async function submit() {
    if (!files.length || !module) return;
    setUploading(true); setError("");
    try {
      const type: JobKind = module.id === "transcription" ? "audio" : files.every((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) ? "pdf" : "image";
      const job = await uploadJob(files, type, setUploadProgress, module.id as ModuleId);
      navigate(`/jobs/${job.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setUploading(false); setUploadProgress(0);
    }
  }

  async function translate() {
    const [jobId, artifactId] = selectedArtifact.split("|");
    const workflowId = selectedArtifactEntry && moduleWorkflowForArtifact("translation", selectedArtifactEntry.artifact.kind);
    if (!jobId || !artifactId || !workflowId || !targetLanguage.trim()) return;
    setUploading(true); setError("");
    try {
      const queued = await api.startRun(jobId, {
        moduleId: "translation",
        workflowId,
        inputArtifactIds: [artifactId],
        params: { artifactId, targetLanguage: targetLanguage.trim(), sourceLanguage },
      });
      navigate(`/jobs/${queued.job.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setUploading(false);
    }
  }

  function rememberLanguages() {
    setRecentLanguages((current) => [...new Set([targetLanguage, ...(sourceLanguage === "auto-detect" ? [] : [sourceLanguage]), ...current])].slice(0, 4));
  }

  async function saveTranslation() {
    if (!sourceText.trim() || !translatedText || !targetLanguage || savingTranslation) return;
    setSavingTranslation(true); setTranslationError(""); setTranslationJobId("");
    try {
      const created = await api.createTextTranslationJob(sourceText.trim(), sourceLanguage, targetLanguage);
      setTranslationJobId(created.id);
      rememberLanguages();
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const current = await api.job(created.id);
        if (["done", "done_with_warnings"].includes(current.status)) {
          const output = current.outputFiles.find((file) => file.startsWith("translation."));
          if (!output) throw new Error("The translation completed without a text result");
          const response = await fetch(`/api/jobs/${current.id}/files/${output.split("/").map(encodeURIComponent).join("/")}`);
          if (!response.ok) throw new Error("Could not load the translated text");
          setTranslatedText((await response.text()).trim());
          setJobs((items) => [current, ...items.filter((job) => job.id !== current.id)]);
          return;
        }
        if (["failed", "cancelled"].includes(current.status)) throw new Error(current.error || `Translation ${current.status}`);
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error("Translation is still running. Open its job from History to follow it.");
    } catch (value) {
      setTranslationError(value instanceof Error ? value.message : String(value));
    } finally {
      setSavingTranslation(false);
    }
  }

  function flipTranslation() {
    if (sourceLanguage === "auto-detect") return;
    setTranslationJobId("");
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
    setSourceText(translatedText || sourceText);
    setTranslatedText(sourceText);
  }

  async function createImage() {
    if (!imagePrompt.trim()) return;
    setUploading(true); setError("");
    try {
      if (selectedArtifactEntry) {
        const workflowId = moduleWorkflowForArtifact("text-to-image", selectedArtifactEntry.artifact.kind);
        if (!workflowId) throw new Error("This result cannot be used as an image prompt");
        const queued = await api.startRun(selectedArtifactEntry.job.id, {
          moduleId: "text-to-image",
          workflowId,
          inputArtifactIds: [selectedArtifactEntry.artifact.id],
          params: { artifactId: selectedArtifactEntry.artifact.id, prompt: imagePrompt.trim(), size: imageSize },
        });
        navigate(`/jobs/${queued.job.id}`);
      } else {
        const job = await api.createImageJob(imagePrompt.trim(), imageSize);
        navigate(`/jobs/${job.id}`);
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setUploading(false);
    }
  }

  async function startGrounding() {
    const queries = [...new Set(groundingQueries.split(/\r?\n/).map((query) => query.trim()).filter(Boolean))].slice(0, 12);
    if ((!selectedArtifactEntry && files.length !== 1) || !queries.length) return;
    setUploading(true); setError("");
    try {
      if (selectedArtifactEntry) {
        const workflowId = moduleWorkflowForArtifact("grounding", selectedArtifactEntry.artifact.kind);
        if (!workflowId) throw new Error("This result cannot be used for grounding");
        const queued = await api.startRun(selectedArtifactEntry.job.id, {
          moduleId: "grounding",
          workflowId,
          inputArtifactIds: [selectedArtifactEntry.artifact.id],
          params: { artifactId: selectedArtifactEntry.artifact.id, queries },
        });
        navigate(`/jobs/${queued.job.id}`);
      } else {
        const job = await uploadGroundingJob(files[0], queries, setUploadProgress);
        navigate(`/jobs/${job.id}`);
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setUploading(false); setUploadProgress(0);
    }
  }

  async function startImportedOcr() {
    if (!selectedArtifactEntry) return;
    const workflowId = moduleWorkflowForArtifact("ocr", selectedArtifactEntry.artifact.kind);
    if (!workflowId) return;
    setUploading(true); setError("");
    try {
      const queued = await api.startRun(selectedArtifactEntry.job.id, {
        moduleId: "ocr",
        workflowId,
        inputArtifactIds: [selectedArtifactEntry.artifact.id],
        params: { artifactId: selectedArtifactEntry.artifact.id },
      });
      navigate(`/jobs/${queued.job.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setUploading(false);
    }
  }

  return <div className="page-wrap content-page module-page">
    <div className="module-workspace-layout"><section className="module-workspace-column">
    <div className="module-content">
    <header className="module-heading"><span className={`module-heading-icon module-card-icon-${module.id}`}><Icon size={28} /></span><h1>{module.title}</h1></header>
    {(error || loadError) && <div className="error-card">{error || loadError}</div>}
    <main className="module-workspace-main">{module.id === "grounding" ? <section className="module-form-card grounding-form">
      <div className="module-form-heading"><h2>Find things in an image</h2><p>Add one image and describe each object, text region, or visual element you want to locate. Every line becomes a separate search.</p></div>
      {!module.configured && <div className="module-setup-note"><span>The Grounding service is not configured yet.</span><Link to="/settings" state={{ backgroundLocation: location }}>Configure service</Link></div>}
      {selectedArtifactEntry ? <ImportedArtifactCard job={selectedArtifactEntry.job} artifact={selectedArtifactEntry.artifact} onRemove={() => setSelectedArtifact("")} /> : <div {...getRootProps()} className={cn("grounding-dropzone", isDragActive && "active", files.length && "has-file")}>
        <input {...getInputProps()} />
        <span className="grounding-dropzone-icon"><ImageIcon size={24} /></span>
        <span className="grounding-dropzone-copy"><strong>{files[0]?.name || (isDragActive ? "Drop the image here" : "Choose an image")}</strong><small>{files[0] ? `${Math.max(1, Math.round(files[0].size / 1024))} KB · ready to search` : "PNG, JPEG, or WebP"}</small></span>
        <button type="button" className="button-secondary">{files[0] ? "Replace" : "Browse"}</button>
      </div>}
      <label className="field-label">What should SparklingKit find?<textarea className="input mt-2 grounding-query-input" value={groundingQueries} onChange={(event) => setGroundingQueries(event.target.value)} placeholder={"SparklingKit logo\nSettings button\nPerson wearing glasses"} maxLength={6000} /><small className="grounding-query-help">One query per line · up to 12 queries</small></label>
      <div className="module-form-actions"><button className="button-primary" onClick={() => void startGrounding()} disabled={uploading || !module.configured || (!selectedArtifactEntry && files.length !== 1) || !groundingQueries.trim()}>{uploading ? selectedArtifactEntry ? "Starting…" : `Uploading ${uploadProgress}%` : <><ScanSearch size={18} />Find locations</>}</button></div>
    </section> : canUpload && module.id === "ocr" && selectedArtifactEntry ? <section className="module-form-card imported-workflow-form">
      <div className="module-form-heading"><h2>Read text from this image</h2><p>The extracted document will stay with the image as its next result.</p></div>
      {!module.configured && <div className="module-setup-note"><span>The OCR service is not configured yet.</span><Link to="/settings" state={{ backgroundLocation: location }}>Configure service</Link></div>}
      <ImportedArtifactCard job={selectedArtifactEntry.job} artifact={selectedArtifactEntry.artifact} onRemove={() => setSelectedArtifact("")} />
      <div className="module-form-actions"><button className="button-primary" onClick={() => void startImportedOcr()} disabled={uploading || !module.configured}>{uploading ? "Starting…" : <><ScanText size={18} />Read text</>}</button></div>
    </section> : canUpload ? <section className={cn("upload-card", isDragActive && "upload-card-active")}>
      <div {...getRootProps()} className="upload-dropzone module-dropzone">
        <input {...getInputProps()} />
        <span className="upload-icon"><CloudUpload size={30} /></span>
        <div><h2>{files.length ? files.length === 1 ? files[0].name : `${files.length} files selected` : isDragActive ? "Drop files here" : module.id === "ocr" ? "Add images or PDF documents" : "Add an audio or video recording"}</h2><p>{files.length ? "Ready to process as one piece of work" : "Internal pages and segments will be combined automatically."}</p></div>
        {!files.length && <button className="button-secondary mt-6" type="button"><FolderOpen size={18} />Browse files</button>}
      </div>
      {files.length > 0 && <div className="module-start-bar"><button className="button-secondary" onClick={() => setFiles([])} disabled={uploading}>Choose different files</button><button className="button-primary" onClick={(event) => { event.stopPropagation(); void submit(); }} disabled={uploading}>{uploading ? `Uploading ${uploadProgress}%` : <>Start {module.shortTitle.toLowerCase()}<ArrowRight size={18} /></>}</button></div>}
    </section> : module.id === "translation" ? <section className="module-form-card translation-form">
      <div className="module-form-heading translation-form-heading"><div><h2>{translationMode === "document" ? "Translate an existing result" : "Translate text"}</h2><p>{translationMode === "document" ? "Choose a document or transcript. The translated file stays beside its source." : "Paste or type text and see the translated result without leaving this page."}</p></div><div className="module-mode-tabs" role="tablist"><button className={translationMode === "text" ? "active" : ""} onClick={() => setTranslationMode("text")}>Text</button><button className={translationMode === "document" ? "active" : ""} onClick={() => setTranslationMode("document")}>Document</button></div></div>
      {!module.configured && <div className="module-setup-note"><span>The Translation service is not configured yet.</span><Link to="/settings" state={{ backgroundLocation: location }}>Configure service</Link></div>}
      {translationMode === "document" ? <>
        <label className="field-label">Source result<span className="select-wrap"><select value={selectedArtifact} onChange={(event) => setSelectedArtifact(event.target.value)}><option value="">Choose a document or transcript</option>{compatibleArtifacts.map(({ job, artifact, value }) => <option value={value} key={value}>{job.title} — {artifact.name}</option>)}</select></span></label>
        {!compatibleArtifacts.length && <p className="module-form-empty">Complete an OCR or transcription job first. Its primary result will appear here automatically.</p>}
        <div className="translation-document-languages"><LanguageSelect label="From" value={sourceLanguage} allowAuto onChange={setSourceLanguage} /><LanguageSelect label="To" value={targetLanguage} onChange={setTargetLanguage} /></div>
        <div className="module-form-actions"><button className="button-primary" onClick={() => { rememberLanguages(); void translate(); }} disabled={uploading || !module.configured || !selectedArtifact || !targetLanguage.trim()}>{uploading ? "Starting…" : <>Start translation<ArrowRight size={18} /></>}</button></div>
      </> : <>
        <div className="quick-translation-grid">
          <div className="translation-pane"><LanguageSelect label="From" value={sourceLanguage} allowAuto recent={recentLanguages} onChange={(value) => { setTranslationJobId(""); setSourceLanguage(value); }} /><textarea value={sourceText} onChange={(event) => { setTranslationJobId(""); setSourceText(event.target.value); }} placeholder="Enter text" maxLength={50000} /><small>{sourceText.length.toLocaleString()} characters</small></div>
          <button className="translation-flip" onClick={flipTranslation} disabled={sourceLanguage === "auto-detect"} title={sourceLanguage === "auto-detect" ? "Choose a source language before swapping" : "Swap languages and text"} aria-label="Swap languages and text"><ArrowLeftRight size={19} /></button>
          <div className="translation-pane output"><LanguageSelect label="To" value={targetLanguage} recent={recentLanguages} onChange={(value) => { setTranslationJobId(""); setTargetLanguage(value); }} /><textarea className={cn((translationPending || translatingPreview) && "updating")} value={translatedText} readOnly aria-busy={translationPending || translatingPreview} placeholder={translationPending ? "Waiting…" : translatingPreview ? "Translating…" : "Translation"} />{translationJobId ? <Link to={`/jobs/${translationJobId}`}><ExternalLink size={14} />Open job</Link> : <small>{translationPending ? "Waiting for you to pause…" : translatingPreview ? "Updating translation…" : "Live preview"}</small>}</div>
        </div>
        {translationError && <p className="form-error mt-4">{translationError}</p>}
        <div className="module-form-actions"><button className="button-primary" onClick={() => void saveTranslation()} disabled={savingTranslation || translationPending || translatingPreview || !module.configured || !sourceText.trim() || !translatedText || !targetLanguage}>{savingTranslation ? "Saving…" : <><Languages size={18} />Save translation</>}</button></div>
      </>}
    </section> : module.id === "text-to-image" ? <section className="module-form-card image-generation-form">
      <div className="module-form-heading"><h2>Describe the image</h2><p>Write what you want to see. SparklingKit will keep the prompt and generated image together as one piece of work.</p></div>
      {!module.configured && <div className="module-setup-note"><span>The Image generation service is not configured yet.</span><Link to="/settings" state={{ backgroundLocation: location }}>Configure service</Link></div>}
      {selectedArtifactEntry && <ImportedArtifactCard job={selectedArtifactEntry.job} artifact={selectedArtifactEntry.artifact} onRemove={() => { setSelectedArtifact(""); importedPromptRef.current = ""; setImagePrompt(""); }} compact />}
      <label className="field-label">Prompt<textarea className="input mt-2 image-prompt-input" value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="A quiet reading room at night, warm table lamps, rain on tall windows, editorial photography" maxLength={12000} /></label>
      <label className="field-label">Canvas<span className="select-wrap"><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}><option value="1024x1024">Square · 1024 × 1024</option><option value="1536x1024">Landscape · 1536 × 1024</option><option value="1024x1536">Portrait · 1024 × 1536</option></select></span></label>
      <div className="module-form-actions"><button className="button-primary" onClick={() => void createImage()} disabled={uploading || !module.configured || !imagePrompt.trim()}>{uploading ? "Starting…" : <><ImageIcon size={18} />Generate image</>}</button></div>
    </section> : <section className="module-coming-card">
      <span className={`module-card-icon module-card-icon-${module.id}`}><Icon size={28} /></span>
      <div><h2>The workspace is ready for this module</h2><p>The provider can already be configured in Settings. Execution will be enabled when this module&apos;s workflow contract is connected.</p></div>
      <Link to="/settings" state={{ backgroundLocation: location }} className="button-secondary">Open settings</Link>
    </section>}</main></div></section><ModuleHistory module={module} jobs={jobs.filter((job) => job.moduleId === module.id || job.runs.some((run) => run.moduleId === module.id))} /></div>
  </div>;
}

function ModuleHistory({ module, jobs }: { module: ModuleDescriptor; jobs: Job[] }) {
  const { openSearch } = useGlobalSearch();
  return <aside className="module-history">
    <header><h2>{moduleHistoryTitles[module.id]}</h2><div className="module-history-actions"><small>{jobs.length}</small><button className="list-search-button" onClick={() => openSearch({ scope: module.id === "chat" ? "chats" : "work", moduleId: module.id, title: `Search ${moduleHistoryTitles[module.id].toLocaleLowerCase()}` })} aria-label={`Search ${moduleHistoryTitles[module.id]}`} title={`Search ${moduleHistoryTitles[module.id]}`}><Search size={17} /></button></div></header>
    <div className="module-history-list">{jobs.slice(0, 12).map((job) => {
      const image = job.outputFiles.find((file) => /\.(?:png|jpe?g|webp|gif|avif|svg)$/i.test(file));
      return <Link to={`/jobs/${job.id}`} className="module-history-item" key={job.id}>
        {image ? <span className="module-history-thumbnail"><img src={`/api/jobs/${job.id}/files/${image.split("/").map(encodeURIComponent).join("/")}`} alt="" loading="lazy" /></span> : <JobIcon type={job.type} />}
        <span className="module-history-copy"><strong>{job.title}</strong><span><StatusBadge status={job.status} /><small>{timeAgo(job.createdAt)}</small></span></span>
        <ArrowRight size={16} />
      </Link>;
    })}{!jobs.length && <div className="module-history-empty"><FolderOpen size={22} /><strong>No history yet</strong><p>Completed and active jobs from this module will appear here.</p></div>}</div>
  </aside>;
}

function ImportedArtifactCard({ job, artifact, onRemove, compact = false }: { job: Job; artifact: Job["artifacts"][number]; onRemove: () => void; compact?: boolean }) {
  const image = artifact.mimeType.startsWith("image/") || ["source-image", "generated-image", "grounded-image"].includes(artifact.kind);
  return <div className={cn("imported-artifact-card", compact && "compact")}>
    {image ? <span className="imported-artifact-preview"><img src={artifactUrl(job.id, artifact)} alt="" /></span> : <span className="imported-artifact-icon"><FileText size={21} /></span>}
    <span className="imported-artifact-copy"><small>From {job.title}</small><strong>{artifact.name}</strong><span>This result will stay linked to the next output.</span></span>
    <button className="icon-button" type="button" onClick={onRemove} aria-label="Choose a different source" title="Choose a different source"><X size={17} /></button>
  </div>;
}

function artifactUrl(jobId: string, artifact: Job["artifacts"][number]) {
  if (artifact.path.startsWith("input/")) return `/api/jobs/${jobId}/input/${encodeURIComponent(artifact.path.slice("input/".length))}`;
  const relative = artifact.path.replace(/^output\//, "");
  return `/api/jobs/${jobId}/files/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function LanguageSelect({ label, value, allowAuto = false, recent = [], onChange }: { label: string; value: string; allowAuto?: boolean; recent?: string[]; onChange: (value: string) => void }) {
  return <div className="language-control">
    <span className="language-control-label">{label}</span>
    {recent.length > 0 && <div className="language-quick-list">{allowAuto && <button className={value === "auto-detect" ? "active" : ""} onClick={() => onChange("auto-detect")}>Detect</button>}{recent.map((language) => <button className={value === language ? "active" : ""} onClick={() => onChange(language)} key={language}>{language}</button>)}</div>}
    <span className="select-wrap"><select value={value} onChange={(event) => onChange(event.target.value)}>{allowAuto && <option value="auto-detect">Auto-detect</option>}{translationLanguages.map(([language, code]) => <option value={language} key={code}>{language} · {code}</option>)}</select></span>
  </div>;
}
