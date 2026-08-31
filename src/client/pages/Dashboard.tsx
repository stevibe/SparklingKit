import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useDropzone } from "react-dropzone";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeftRight, ArrowRight, AudioLines, CloudUpload, FileText, FolderOpen, Image as ImageIcon, Languages, MessageCircle, Save, ScanSearch, ScanText, Trash2, X } from "lucide-react";
import { api, uploadJob, uploadTranslationJob } from "../api";
import { cn, ConfirmDialog, formatBytes, JobIcon, Progress, StatusBadge, timeAgo } from "../components/ui";
import { savedTranslationPreferences, translationLanguages, translationPreferenceKey, type TranslationPreferences } from "../translation";
import type { Job, JobKind, ModuleDescriptor, ModuleId } from "../types";

const workflowCopy: Record<JobKind, { label: string; description: string }> = {
  audio: { label: "Transcription", description: "Audio or video to transcript and subtitles" },
  image: { label: "Image OCR", description: "Images to structured Markdown" },
  pdf: { label: "PDF OCR", description: "PDFs to one complete structured document" },
  text: { label: "Text to image", description: "Prompts to generated images" },
};

type FileAction = "ocr" | "transcription" | "translation";
type JobFilter = "all" | "audio" | "ocr" | "translation" | "grounding" | "generated";
type FileLike = Pick<File, "name" | "type">;

const recentTabs: Array<{ key: JobFilter; label: string; shortLabel: string; icon: ReactNode }> = [
  { key: "all", label: "All files", shortLabel: "All", icon: <FileText size={16} /> },
  { key: "audio", label: "Transcriptions", shortLabel: "Audio", icon: <AudioLines size={16} /> },
  { key: "ocr", label: "OCR documents", shortLabel: "OCR", icon: <ScanText size={16} /> },
  { key: "translation", label: "Translations", shortLabel: "Translate", icon: <Languages size={16} /> },
  { key: "grounding", label: "Located regions", shortLabel: "Find", icon: <ScanSearch size={16} /> },
  { key: "generated", label: "Generated images", shortLabel: "Images", icon: <ImageIcon size={16} /> },
];

const fileActions: Array<{ id: FileAction; label: string; hint: string; icon: ReactNode }> = [
  { id: "ocr", label: "OCR", hint: "Images and PDFs", icon: <ScanText size={18} /> },
  { id: "transcription", label: "Transcribe", hint: "Audio and video", icon: <AudioLines size={18} /> },
  { id: "translation", label: "Translate", hint: "Text, Markdown, HTML", icon: <Languages size={18} /> },
];

const textExtensions = new Set(["txt", "md", "markdown", "html", "htm"]);
const translationDebounceMs = 600;

function fileExtension(file: FileLike) {
  return file.name.toLowerCase().split(".").pop() || "";
}

function fileFamily(file: FileLike) {
  const extension = fileExtension(file);
  if (file.type.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"].includes(extension)) return "recording";
  if (file.type.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(extension)) return "recording";
  if (file.type === "application/pdf" || extension === "pdf") return "pdf";
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(extension)) return "image";
  if (textExtensions.has(extension)) return "text";
  return "unsupported";
}

export function compatibleFileActions(files: FileLike[]): FileAction[] {
  if (!files.length) return [];
  const families = files.map(fileFamily);
  if (families.every((family) => family === "recording")) return ["transcription"];
  if (families.every((family) => family === "image") || families.every((family) => family === "pdf")) return ["ocr"];
  if (files.length === 1 && families[0] === "text") return ["translation"];
  return [];
}

function rememberLanguages(preferences: TranslationPreferences) {
  return {
    ...preferences,
    recent: [...new Set([preferences.target, ...(preferences.source === "auto-detect" ? [] : [preferences.source]), ...preferences.recent])].slice(0, 4),
  };
}

async function completedTranslation(jobId: string) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const job = await api.job(jobId);
    if (["done", "done_with_warnings"].includes(job.status)) {
      const output = job.outputFiles.find((file) => file.startsWith("translation."));
      if (!output) throw new Error("The translation completed without a text result");
      const response = await fetch(`/api/jobs/${job.id}/files/${output.split("/").map(encodeURIComponent).join("/")}`);
      if (!response.ok) throw new Error("Could not load the translated text");
      return { job, text: (await response.text()).trim() };
    }
    if (["failed", "cancelled"].includes(job.status)) throw new Error(job.error || `Translation ${job.status}`);
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error("Translation is still running. Open its job to follow it.");
}

export function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [modules, setModules] = useState<ModuleDescriptor[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [fileAction, setFileAction] = useState<FileAction>("ocr");
  const [filter, setFilter] = useState<JobFilter>("all");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileError, setFileError] = useState("");
  const [translationPreferences, setTranslationPreferences] = useState(savedTranslationPreferences);
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [translating, setTranslating] = useState(false);
  const [translationPending, setTranslationPending] = useState(false);
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [translationError, setTranslationError] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageSize, setImageSize] = useState("1024x1024");
  const [generating, setGenerating] = useState(false);
  const [imageError, setImageError] = useState("");
  const [chatPrompt, setChatPrompt] = useState("");
  const [startingChat, setStartingChat] = useState(false);
  const [chatError, setChatError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Job>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const translationPreviewController = useRef<AbortController | undefined>(undefined);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const refresh = () => api.jobs().then((result) => active && setJobs(result.jobs)).catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { api.modules().then(setModules).catch(() => undefined); }, []);
  useEffect(() => { localStorage.setItem(translationPreferenceKey, JSON.stringify(translationPreferences)); }, [translationPreferences]);

  const configured = useCallback((moduleId: ModuleId) => Boolean(modules.find((module) => module.id === moduleId)?.configured), [modules]);
  const translationReady = configured("translation");
  useEffect(() => {
    translationPreviewController.current?.abort();
    const text = sourceText.trim();
    if (!text || !translationReady) {
      setTranslationPending(false);
      setTranslating(false);
      if (!text) setTranslatedText("");
      return;
    }
    setTranslationPending(true);
    setTranslationError("");
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      translationPreviewController.current = controller;
      setTranslationPending(false);
      setTranslating(true);
      api.previewTranslation(text, translationPreferences.source, translationPreferences.target, controller.signal)
        .then(({ text: result }) => { if (!controller.signal.aborted) setTranslatedText(result); })
        .catch((error) => { if (!controller.signal.aborted) setTranslationError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!controller.signal.aborted) setTranslating(false); });
    }, translationDebounceMs);
    return () => {
      window.clearTimeout(timer);
      translationPreviewController.current?.abort();
    };
  }, [sourceText, translationPreferences.source, translationPreferences.target, translationReady]);
  const availableFileActions = useMemo(() => compatibleFileActions(files), [files]);
  const selectedKind: JobKind = fileAction === "transcription" ? "audio" : fileAction === "translation" ? "text" : files.every((file) => fileFamily(file) === "pdf") ? "pdf" : "image";
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const onDrop = useCallback((accepted: File[]) => {
    if (!accepted.length) return;
    const actions = compatibleFileActions(accepted);
    setFiles(accepted);
    setFileError(actions.length ? "" : "Choose files of one supported type. Translation accepts one text, Markdown, or HTML file at a time.");
    if (actions[0]) setFileAction(actions[0]);
  }, []);
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      "audio/*": [], "video/*": [], "image/*": [], "application/pdf": [".pdf"],
      "text/plain": [".txt"], "text/markdown": [".md", ".markdown"], "text/html": [".html", ".htm"],
    },
    maxFiles: 100,
    noClick: Boolean(files.length),
    noKeyboard: Boolean(files.length),
    disabled: uploading,
  });

  const visibleJobs = jobs.filter((job) => filter === "all" || job.moduleId === ({ audio: "transcription", ocr: "ocr", translation: "translation", grounding: "grounding", generated: "text-to-image" } as const)[filter]);

  async function submitFile() {
    if (!files.length || !availableFileActions.includes(fileAction)) return;
    setUploading(true);
    setFileError("");
    try {
      const job = fileAction === "translation"
        ? await uploadTranslationJob(files[0], translationPreferences.source, translationPreferences.target, setUploadProgress)
        : await uploadJob(files, selectedKind, setUploadProgress, fileAction);
      if (fileAction === "translation") setTranslationPreferences((current) => rememberLanguages(current));
      setFiles([]);
      navigate(`/jobs/${job.id}`);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function saveTranslation() {
    if (!sourceText.trim() || !translatedText || !translationPreferences.target || savingTranslation) return;
    setSavingTranslation(true);
    setTranslationError("");
    try {
      const created = await api.createTextTranslationJob(sourceText.trim(), translationPreferences.source, translationPreferences.target);
      setTranslationPreferences((current) => rememberLanguages(current));
      const completed = await completedTranslation(created.id);
      setTranslatedText(completed.text);
      setJobs((current) => [completed.job, ...current.filter((job) => job.id !== completed.job.id)]);
    } catch (error) {
      setTranslationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingTranslation(false);
    }
  }

  function swapLanguages() {
    if (translationPreferences.source === "auto-detect") return;
    const previousSource = sourceText;
    setTranslationPreferences((current) => ({ ...current, source: current.target, target: current.source }));
    setSourceText(translatedText || previousSource);
    setTranslatedText(previousSource);
  }

  async function createImage() {
    if (!imagePrompt.trim() || generating) return;
    setGenerating(true);
    setImageError("");
    try {
      const job = await api.createImageJob(imagePrompt.trim(), imageSize);
      navigate(`/jobs/${job.id}`);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  }

  async function startChat(event: FormEvent) {
    event.preventDefault();
    const prompt = chatPrompt.trim();
    if (!prompt || startingChat) return;
    setStartingChat(true);
    setChatError("");
    try {
      const chat = await api.createChat();
      navigate(`/chat/${chat.id}`, { state: { initialPrompt: prompt } });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
      setStartingChat(false);
    }
  }

  function askToDelete(job: Job) {
    setDeleteError("");
    setDeleteTarget(job);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api.deleteJob(deleteTarget.id);
      setJobs((items) => items.filter((job) => job.id !== deleteTarget.id));
      setDeleteTarget(undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  return <div className="page-wrap content-page dashboard-page">
    <div className="dashboard-workspace">
    <section className="dashboard-shortcuts">
    <header className="dashboard-column-heading"><h1>Shortcuts</h1></header>
    <div className="workbench-grid">
      <section className="workbench-card workbench-file-card">
        <WorkbenchHeading icon={<FileText size={22} />} title="Start with a file" />
        <div {...getRootProps()} className={cn("workbench-file-drop", isDragActive && "active", files.length && "has-files")}>
          <input {...getInputProps()} />
          {!files.length ? <><span className="workbench-drop-icon"><CloudUpload size={27} /></span><div><strong>{isDragActive ? "Drop files here" : "Drop files or browse"}</strong><small>Recordings, images, PDFs, text, Markdown, or HTML</small></div><button type="button" className="button-secondary" onClick={(event) => { event.stopPropagation(); open(); }}><FolderOpen size={16} />Browse</button></> : <><JobIcon type={selectedKind} /><div className="workbench-file-summary"><strong>{files.length === 1 ? files[0].name : `${files.length} files selected`}</strong><small>{formatBytes(totalSize)} · {files.length === 1 ? fileActions.find((action) => action.id === fileAction)?.hint : "Batch processing"}</small></div><button type="button" className="icon-button" onClick={(event) => { event.stopPropagation(); setFiles([]); setFileError(""); }} disabled={uploading} aria-label="Clear files"><X size={17} /></button></>}
        </div>
        <div className="workbench-file-actions" role="radiogroup" aria-label="Process selected files as">
          {fileActions.map((action) => {
            const compatible = availableFileActions.includes(action.id);
            const serviceReady = configured(action.id);
            return <button type="button" role="radio" aria-checked={fileAction === action.id} className={cn(fileAction === action.id && "active")} onClick={() => compatible && serviceReady && setFileAction(action.id)} disabled={!files.length || !compatible || !serviceReady || uploading} key={action.id}>{action.icon}<span><strong>{action.label}</strong><small>{!serviceReady && modules.length ? "Service unavailable" : action.hint}</small></span></button>;
          })}
        </div>
        {fileAction === "translation" && availableFileActions.includes("translation") && <div className="file-translation-options"><CompactLanguageSelect label="From" value={translationPreferences.source} allowAuto onChange={(source) => setTranslationPreferences((current) => ({ ...current, source }))} /><ArrowRight size={15} /><CompactLanguageSelect label="To" value={translationPreferences.target} onChange={(target) => setTranslationPreferences((current) => ({ ...current, target }))} /></div>}
        {uploading && <Progress job={{ progress: uploadProgress, status: "processing" }} />}
        {fileError && <p className="form-error">{fileError}</p>}
        <div className="workbench-card-footer"><button className="button-primary" onClick={() => void submitFile()} disabled={uploading || !files.length || !availableFileActions.includes(fileAction) || !configured(fileAction)}>{uploading ? <><span className="spinner dark" />Uploading {uploadProgress}%</> : <>Start {fileActions.find((action) => action.id === fileAction)?.label}<ArrowRight size={17} /></>}</button></div>
      </section>

      <section className="workbench-card workbench-translation-card">
        <WorkbenchHeading icon={<Languages size={22} />} title="Translate text" />
        <div className="workbench-language-bar"><CompactLanguageSelect label="From" value={translationPreferences.source} allowAuto onChange={(source) => setTranslationPreferences((current) => ({ ...current, source }))} /><button className="translation-flip" onClick={swapLanguages} disabled={translationPreferences.source === "auto-detect"} aria-label="Swap languages"><ArrowLeftRight size={16} /></button><CompactLanguageSelect label="To" value={translationPreferences.target} onChange={(target) => setTranslationPreferences((current) => ({ ...current, target }))} /></div>
        <div className="workbench-translation-panes"><textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="Enter text" maxLength={50000} /><textarea className={cn((translationPending || translating) && "updating")} value={translatedText} readOnly aria-busy={translationPending || translating} placeholder={translationPending ? "Waiting…" : translating ? "Translating…" : "Translation"} /></div>
        {translationError && <p className="form-error">{translationError}</p>}
        <div className="workbench-card-footer workbench-translation-footer"><button className="button-primary" onClick={() => void saveTranslation()} disabled={savingTranslation || translating || translationPending || !translatedText || !translationReady}>{savingTranslation ? <><span className="spinner dark" />Saving</> : <><Save size={15} />Save</>}</button></div>
      </section>

      <section className="workbench-card workbench-image-card">
        <WorkbenchHeading icon={<ImageIcon size={22} />} title="Create an image" />
        <textarea className="workbench-prompt" value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="A quiet reading room at night, warm table lamps, rain on tall windows…" maxLength={12000} />
        <div className="image-size-options" role="radiogroup" aria-label="Image canvas">
          {[["1024x1024", "Square", "1:1"], ["1536x1024", "Landscape", "3:2"], ["1024x1536", "Portrait", "2:3"]].map(([value, label, ratio]) => <button type="button" role="radio" aria-checked={imageSize === value} className={imageSize === value ? "active" : ""} onClick={() => setImageSize(value)} key={value}><span className={`canvas-shape canvas-${ratio.replace(":", "-")}`} /><span><strong>{label}</strong><small>{value.replace("x", " × ")}</small></span></button>)}
        </div>
        {imageError && <p className="form-error">{imageError}</p>}
        <div className="workbench-card-footer"><button className="button-primary" onClick={() => void createImage()} disabled={generating || !imagePrompt.trim() || !configured("text-to-image")}>{generating ? <><span className="spinner dark" />Starting</> : <>Generate<ArrowRight size={17} /></>}</button></div>
      </section>

      <div className="workbench-side-stack">
        <section className="workbench-card workbench-chat-card">
          <WorkbenchHeading icon={<MessageCircle size={22} />} title="Ask your model" />
          <form className="workbench-chat-composer" onSubmit={startChat}><textarea value={chatPrompt} onChange={(event) => setChatPrompt(event.target.value)} placeholder="What are you working on?" rows={2} /><button className="send-button" disabled={startingChat || !chatPrompt.trim() || !configured("chat")} aria-label="Start conversation"><ArrowRight size={18} /></button></form>
          {chatError && <p className="form-error">{chatError}</p>}
        </section>
        <Link to="/tools/grounding" className="workbench-card workbench-grounding-link"><span className="workbench-card-icon grounding"><ScanSearch size={22} /></span><strong>Find something in an image</strong><ArrowRight size={19} /></Link>
      </div>
    </div>
    </section>

    <section className="recent-section dashboard-recent">
      <header className="dashboard-column-heading"><h2>Recent</h2></header>
      <div className="work-tabs" role="tablist" aria-label="Filter recent work">
        {recentTabs.map((tab) => <button key={tab.key} role="tab" aria-selected={filter === tab.key} className={filter === tab.key ? "active" : ""} onClick={() => setFilter(tab.key)} aria-label={tab.label}>{tab.icon}<span className="tab-label-desktop">{tab.label}</span><span className="tab-label-mobile">{tab.shortLabel}</span></button>)}
      </div>
      {visibleJobs.length ? <div className="jobs-list">{visibleJobs.slice(0, 10).map((job) => <JobRow compact key={job.id} job={job} onDelete={() => askToDelete(job)} />)}</div> : <div className="empty-card"><FileText size={28} /><strong>No matching jobs</strong><p>Files in this category will appear here.</p></div>}
    </section>
    </div>
    <ConfirmDialog open={Boolean(deleteTarget)} title="Delete job?" description={<>“{deleteTarget?.title}” and all of its source files, generated outputs, and processing data will be permanently deleted.{deleteTarget && ["queued", "preparing", "processing", "merging"].includes(deleteTarget.status) && <> Its current processing will also be stopped.</>}</>} busy={deleting} error={deleteError} onCancel={() => !deleting && setDeleteTarget(undefined)} onConfirm={confirmDelete} />
  </div>;
}

function WorkbenchHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return <header className="workbench-card-heading"><span className="workbench-card-icon">{icon}</span><strong>{title}</strong></header>;
}

function CompactLanguageSelect({ label, value, allowAuto = false, onChange }: { label: string; value: string; allowAuto?: boolean; onChange: (value: string) => void }) {
  return <label className="compact-language-select"><small>{label}</small><select value={value} onChange={(event) => onChange(event.target.value)}>{allowAuto && <option value="auto-detect">Auto-detect</option>}{translationLanguages.map(([language, code]) => <option value={language} key={code}>{language}</option>)}</select></label>;
}

function JobRow({ job, onDelete, compact = false }: { job: Job; onDelete: () => void; compact?: boolean }) {
  const running = ["queued", "preparing", "processing", "merging"].includes(job.status);
  const label = job.moduleId === "grounding" ? "Grounding" : job.moduleId === "translation" ? "Translation" : workflowCopy[job.type].label;
  return <div className={cn("job-row-shell", compact && "compact")}><Link to={`/jobs/${job.id}`} className="job-row group"><JobIcon type={job.type} /><div className="job-row-main"><div><p>{job.title}</p><StatusBadge status={job.status} /></div><small>{label}<i />{!compact && <>{job.stage}<i /></>}{timeAgo(job.createdAt)}</small>{running && <Progress job={job} />}</div><ArrowRight size={19} className="job-row-arrow" /></Link><button className="row-delete-button" onClick={onDelete} aria-label={`Delete ${job.title}`} title="Delete job"><Trash2 size={15} /></button></div>;
}
