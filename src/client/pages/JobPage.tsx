import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ArrowLeft, ArrowRight, AudioLines, Bot, Braces, Check, ChevronDown, CircleStop, Code2, Combine, Copy, Download, ExternalLink, File, FileAudio, FileInput, FileJson, FileText, FileVideo, FolderOpen, GitBranch, Image as ImageIcon, Languages, LoaderCircle, MessageCircle, Network, PanelLeft, Pencil, Save, ScanSearch, ScanText, Split, Square, Subtitles, Trash2, TriangleAlert } from "lucide-react";
import { api, startWorkflow } from "../api";
import { writeClipboardText } from "../clipboard";
import { ConfirmDialog, JobIcon, Progress, RenameDialog, StatusBadge, cn, formatBytes, timeAgo } from "../components/ui";
import { SearchSelect } from "../components/SearchSelect";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { MindMapViewer, parseMindMap } from "../components/MindMapViewer";
import { useToast } from "../components/ToastProvider";
import { compatibleModuleContracts, moduleHandoffUrl } from "../../shared/module-router";
import { nodeTitle, workflowAcceptsArtifact } from "../../shared/workflows";
import type { FlowNodeRun, FlowRun, WorkflowNode, WorkflowServiceId } from "../../shared/contracts";
import type { Chat, Job, ModuleDescriptor, ModuleId, PromptPreset, WorkflowDefinition } from "../types";

type PreviewMode = "rendered" | "source";
type DeleteTarget =
  | { kind: "job"; label: string }
  | { kind: "output"; file: string; label: string }
  | { kind: "input"; file: string; label: string };
type RenameTarget =
  | { kind: "job"; value: string }
  | { kind: "output"; file: string; value: string }
  | { kind: "input"; file: string; value: string };

export function JobPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<Job>();
  const [prompts, setPrompts] = useState<PromptPreset[]>([]);
  const [modules, setModules] = useState<ModuleDescriptor[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [preview, setPreview] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [selectedScope, setSelectedScope] = useState<"output" | "input">("output");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("rendered");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [copiedFile, setCopiedFile] = useState("");
  const copyResetTimer = useRef<number | undefined>(undefined);
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [startingWorkflowId, setStartingWorkflowId] = useState("");
  const [linkedChats, setLinkedChats] = useState<Chat[]>([]);
  const [flowRun, setFlowRun] = useState<FlowRun>();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedArtifactId = searchParams.get("artifact") || "";
  const workflowViewSelected = searchParams.get("view") === "workflow" && !requestedArtifactId;

  useEffect(() => {
    setLinkedChats([]);
    setFlowRun(undefined);
    api.job(id).then(setJob).catch((value) => setError(value.message));
    api.prompts().then(setPrompts).catch(() => undefined);
    api.modules().then(setModules).catch(() => undefined);
    api.workflows().then(setWorkflows).catch(() => undefined);
    api.chats().then((chats) => setLinkedChats(linkedChatsForJob(chats, id))).catch(() => undefined);
    const events = new EventSource(`/api/jobs/${id}/events`);
    events.onmessage = (event) => setJob(JSON.parse(event.data) as Job);
    return () => events.close();
  }, [id]);

  useEffect(() => {
    let active = true;
    api.jobWorkflowRuns(id).then((runs) => { if (active) setFlowRun(runs[0]); }).catch(() => undefined);
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!flowRun || ["succeeded", "failed", "cancelled"].includes(flowRun.status)) return;
    const events = new EventSource(`/api/jobs/${id}/flows/${flowRun.id}/events`);
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as FlowRun;
      setFlowRun(next);
      if (["succeeded", "failed", "cancelled"].includes(next.status)) events.close();
    };
    return () => events.close();
  }, [id, flowRun?.id]);

  const outputFiles = useMemo(() => job?.outputFiles || [], [job?.outputFiles]);
  useEffect(() => {
    if (!job) return;
    const requestedArtifact = requestedArtifactId ? job.artifacts.find((artifact) => artifact.id === requestedArtifactId) : undefined;
    if (requestedArtifact?.path.startsWith("output/")) {
      setSelectedScope("output");
      setSelectedFile(requestedArtifact.path.slice("output/".length));
      return;
    }
    if (requestedArtifact?.path.startsWith("input/")) {
      setSelectedScope("input");
      setSelectedFile(requestedArtifact.path.slice("input/".length));
      return;
    }
    const selectionExists = selectedScope === "output" ? outputFiles.includes(selectedFile) : job.inputs.some((input) => input.storedName === selectedFile);
    if (selectionExists) return;
    if (outputFiles.length) { setSelectedScope("output"); setSelectedFile(outputFiles[0]); }
    else if (job.inputs.length) { setSelectedScope("input"); setSelectedFile(job.inputs[0].storedName); }
    else setSelectedFile("");
  }, [job?.inputs.map((input) => input.storedName).join("|"), outputFiles.join("|"), requestedArtifactId]);
  useEffect(() => {
    if (!selectedFile) return;
    let active = true;
    setLoadingPreview(true);
    setPreview("");
    setPreviewMode("rendered");
    if (["image", "pdf", "audio", "video"].includes(getFileKind(selectedFile))) {
      setLoadingPreview(false);
      return () => { active = false; };
    }
    const selectedUrl = selectedScope === "input" ? inputFileUrl(id, selectedFile) : fileUrl(id, selectedFile);
    fetch(selectedUrl).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load ${selectedFile}`);
      return response.text();
    }).then((value) => { if (active) setPreview(value); }).catch((value) => { if (active) setError(value.message); }).finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [id, selectedFile, selectedScope, job?.updatedAt]);
  useEffect(() => () => window.clearTimeout(copyResetTimer.current), []);

  if (error && !job) return <div className="page-wrap"><div className="error-card">{error}</div></div>;
  if (!job) return <div className="page-wrap job-page"><div className="skeleton h-[70vh]" /></div>;
  const running = ["queued", "preparing", "processing", "merging"].includes(job.status);
  const complete = ["done", "done_with_warnings"].includes(job.status);
  const forceWorkflowRun = Boolean(flowRun && (running || !outputFiles.length || ["failed", "blocked", "cancelled"].includes(flowRun.status)));
  const showWorkflowRun = Boolean(flowRun && (forceWorkflowRun || workflowViewSelected));
  const selectedKind = getFileKind(selectedFile);
  const selectedInput = selectedScope === "input" ? job.inputs.find((input) => input.storedName === selectedFile) : undefined;
  const selectedArtifact = selectedScope === "output"
    ? job.artifacts.find((artifact) => artifact.path === `output/${selectedFile}`)
    : job.artifacts.find((artifact) => artifact.path === `input/${selectedFile}`);
  const producingModule = selectedArtifact?.role === "source" ? job.moduleId : job.runs.find((run) => run.id === selectedArtifact?.createdByRunId)?.moduleId;
  const sourceModuleId = modules.some((module) => module.id === producingModule) ? producingModule as ModuleId : undefined;
  const nextActions = selectedArtifact
    ? compatibleModuleContracts(selectedArtifact.kind, sourceModuleId).filter((contract) => contract.id !== "chat")
    : [];
  const compatibleWorkflows = selectedArtifact ? workflows.filter((workflow) => workflow.enabled && workflowAcceptsArtifact(workflow, selectedArtifact.kind)) : [];
  const workflowLabel = flowRun?.definition.name || modules.find((module) => module.id === job.moduleId)?.title || (job.type === "audio" ? "Transcription" : "OCR");
  const html = extractHtml(preview, selectedFile);
  const canRender = selectedKind === "markdown" || Boolean(html) || selectedFile === "mindmap.json" || selectedFile.endsWith(".mindmap.json");
  const selectedMindMap = selectedScope === "output" && selectedKind === "json" && (selectedFile === "mindmap.json" || selectedFile.endsWith(".mindmap.json"));
  const canCopy = ["markdown", "json", "subtitle", "html", "text"].includes(selectedKind);
  const selectedUrl = selectedScope === "input" ? inputFileUrl(job.id, selectedFile) : fileUrl(job.id, selectedFile);
  const selectedDisplayName = selectedScope === "input" ? selectedInput?.name || selectedFile : displayOutputName(selectedFile);

  async function openChat() {
    setOpeningChat(true);
    setError("");
    try {
      const chat = await api.createChat(job!.id);
      navigate(`/chat/${chat.id}`);
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : String(chatError));
      setOpeningChat(false);
    }
  }
  async function runPreset(slug: string) {
    if (slug) setJob(await api.runPreset(job!.id, slug));
  }
  async function runCompatibleWorkflow(definition: WorkflowDefinition) {
    if (!selectedArtifact || startingWorkflowId) return;
    setStartingWorkflowId(definition.id);
    setError("");
    try {
      const result = await startWorkflow(definition.id, { jobId: job!.id, inputArtifactIds: [selectedArtifact.id] }, () => undefined);
      setJob(result.job);
      setFlowRun(result.flow);
      toast.success("Workflow started", definition.name);
    } catch (workflowError) {
      setError(workflowError instanceof Error ? workflowError.message : String(workflowError));
    } finally {
      setStartingWorkflowId("");
    }
  }
  async function stopJob() {
    setStopping(true);
    setError("");
    try {
      setJob(await api.cancelJob(job!.id));
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setStopping(false);
    }
  }
  async function copyPreview() {
    try {
      await writeClipboardText(preview);
      setCopiedFile(selectedFile);
      window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopiedFile(""), 1800);
    } catch {
      setError("Could not copy this file. Please use the source view and copy it manually.");
    }
  }
  function askToDelete(target: DeleteTarget) {
    setDeleteError("");
    setDeleteTarget(target);
  }
  function selectWorkspaceFile(scope: "output" | "input", file: string) {
    setSelectedScope(scope);
    setSelectedFile(file);
    if (requestedArtifactId || workflowViewSelected) {
      const next = new URLSearchParams(searchParams);
      next.delete("artifact");
      next.delete("view");
      setSearchParams(next, { replace: true });
    }
  }
  function selectWorkflowRun() {
    const next = new URLSearchParams(searchParams);
    next.delete("artifact");
    next.set("view", "workflow");
    setSearchParams(next, { replace: true });
  }
  function askToRename(target: RenameTarget) {
    setRenameError("");
    setRenameTarget(target);
    setRenameValue(target.value);
  }
  async function confirmRename() {
    if (!renameTarget) return;
    setRenaming(true);
    setRenameError("");
    try {
      if (renameTarget.kind === "job") {
        setJob(await api.renameJob(job!.id, renameValue));
      } else if (renameTarget.kind === "output") {
        const result = await api.renameOutputFile(job!.id, renameTarget.file, renameValue);
        setJob(result.job);
        if (selectedScope === "output" && selectedFile === renameTarget.file) setSelectedFile(result.file);
      } else {
        setJob(await api.renameInputFile(job!.id, renameTarget.file, renameValue));
      }
      setRenameTarget(undefined);
      toast.success(renameTarget.kind === "job" ? "Job renamed" : renameTarget.kind === "input" ? "Source file renamed" : "Generated file renamed", renameValue.trim());
    } catch (renameFailure) {
      setRenameError(renameFailure instanceof Error ? renameFailure.message : String(renameFailure));
    } finally {
      setRenaming(false);
    }
  }
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      if (deleteTarget.kind === "job") {
        await api.deleteJob(job!.id);
        toast.success("Job deleted", deleteTarget.label);
        navigate("/", { replace: true });
        return;
      }
      if (deleteTarget.kind === "output") {
        const next = await api.deleteOutputFile(job!.id, deleteTarget.file);
        if (selectedScope === "output" && selectedFile === deleteTarget.file) { setSelectedFile(""); setPreview(""); }
        setJob(next);
      } else {
        const next = await api.deleteInputFile(job!.id, deleteTarget.file);
        if (selectedScope === "input" && selectedFile === deleteTarget.file) { setSelectedFile(""); setPreview(""); }
        setJob(next);
      }
      toast.success(deleteTarget.kind === "input" ? "Source file deleted" : "Generated file deleted", deleteTarget.label);
      setDeleteTarget(undefined);
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : String(deleteFailure));
    } finally {
      setDeleting(false);
    }
  }

  const deleteTitle = deleteTarget?.kind === "job" ? "Delete job?" : deleteTarget?.kind === "input" ? "Delete source file?" : "Delete output file?";
  const deleteDescription = deleteTarget?.kind === "job"
    ? <>“{deleteTarget.label}” and all of its source files, generated outputs, and processing data will be permanently deleted.{running && <> Its current processing will also be stopped.</>}</>
    : <>“{deleteTarget?.label}” will be permanently deleted from this job.</>;
  const renameDialogTitle = renameTarget?.kind === "job" ? "Rename job" : renameTarget?.kind === "input" ? "Rename source file" : "Rename output file";
  const renamedExtension = renameTarget && renameTarget.kind !== "job" ? renameTarget.value.match(/\.[^.]+$/)?.[0] : undefined;
  const sourceFileRows = job.inputs.map((input) => <div className="source-file-row" key={input.storedName}><button className={cn("source-file", !workflowViewSelected && selectedScope === "input" && selectedFile === input.storedName && "active")} onClick={() => selectWorkspaceFile("input", input.storedName)}><FileTypeIcon file={input.name} /><span><strong>{input.name}</strong><small>{formatBytes(input.size)} · Source</small></span></button><span className="file-row-actions"><button className="row-rename-button" onClick={() => askToRename({ kind: "input", file: input.storedName, value: input.name })} disabled={running} aria-label={"Rename " + input.name} title={running ? "Files cannot be renamed while processing" : "Rename source file"}><Pencil size={13} /></button><button className="row-delete-button" onClick={() => askToDelete({ kind: "input", file: input.storedName, label: input.name })} disabled={running} aria-label={"Delete " + input.name} title={running ? "Files cannot be deleted while processing" : "Delete source file"}><Trash2 size={14} /></button></span></div>);

  return <div className="job-page">
    <header className="job-titlebar">
      <div className="job-title-left"><Link to="/" className="icon-button" aria-label="Back to workbench"><ArrowLeft size={19} /></Link><JobIcon type={job.type} moduleId={job.moduleId} className="job-title-icon h-11 w-11" /><div className="min-w-0 flex-1"><div className="job-title-line"><h1>{job.title}</h1><button className="inline-rename-button" onClick={() => askToRename({ kind: "job", value: job.title })} aria-label="Rename job" title="Rename job"><Pencil size={14} /></button></div><div className="job-meta"><StatusBadge status={job.status} /><span>{formatBytes(job.inputs.reduce((sum, input) => sum + input.size, 0))}</span><i /><span>{timeAgo(job.createdAt)}</span></div></div><button className="icon-button destructive-icon-button job-delete-mobile" onClick={() => askToDelete({ kind: "job", label: job.title })} aria-label="Delete job" title="Delete job"><Trash2 size={17} /></button></div>
      <div className="job-actions">{running ? <button className="button-secondary stop-job-button" onClick={stopJob} disabled={stopping}>{stopping ? <LoaderCircle size={15} className="animate-spin" /> : <Square size={15} fill="currentColor" />}{stopping ? "Stopping…" : "Stop job"}</button> : complete ? <><SearchSelect className="preset-search-select" value="" options={prompts.map((prompt) => ({ value: prompt.slug, label: prompt.name }))} onChange={(slug) => void runPreset(slug)} placeholder="Run a preset" searchPlaceholder="Search presets" emptyMessage="No presets found" ariaLabel="Run a preset" leadingIcon={<Braces size={17} />} disabled={!prompts.length} /><button className="button-secondary" onClick={openChat} disabled={openingChat}>{openingChat ? <LoaderCircle size={17} className="animate-spin" /> : <MessageCircle size={17} />}{openingChat ? "Opening…" : "Ask in chat"}</button></> : null}<button className="icon-button destructive-icon-button job-delete-desktop" onClick={() => askToDelete({ kind: "job", label: job.title })} aria-label="Delete job" title="Delete job"><Trash2 size={17} /></button></div>
    </header>

    {error && <div className="error-card job-alert"><TriangleAlert size={19} /><div><strong>Action failed</strong><p>{error}</p></div></div>}
    {job.error && <div className="error-card job-alert"><TriangleAlert size={19} /><div><strong>Processing failed</strong><p>{job.error}</p></div></div>}
    {!!job.warnings.length && <div className="warning-card job-alert"><TriangleAlert size={19} /><div><strong>Completed with warnings</strong>{job.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}

    <section className={cn("file-workspace", forceWorkflowRun && "workflow-run-workspace")}>
      <aside className="file-sidebar">
        <div className="file-sidebar-title"><span><PanelLeft size={18} />Files</span><small>{outputFiles.length + job.inputs.length}</small></div>
        <div className="file-tree">
          <p className="file-group-label">Generated output</p>
          <div className="output-files-list">{outputFiles.map((file) => <div className={cn("file-tree-row", file.includes("/") && "nested")} key={file}><button className={cn("file-tree-item", !workflowViewSelected && selectedScope === "output" && selectedFile === file && "active")} onClick={() => selectWorkspaceFile("output", file)}><FileTypeIcon file={file} /><span><strong>{displayOutputName(file)}</strong><small>{describeOutput(file)}</small></span></button><button className="row-delete-button" onClick={() => askToDelete({ kind: "output", file, label: displayOutputName(file) })} disabled={running} aria-label={"Delete " + displayOutputName(file)} title={running ? "Files cannot be deleted while processing" : "Delete output file"}><Trash2 size={14} /></button></div>)}</div>
          {!outputFiles.length && <div className="file-tree-empty"><FolderOpen size={22} /><span>Outputs will appear here</span></div>}
          {!!linkedChats.length && <div className="job-chat-section"><div className="file-tree-divider" /><p className="file-group-label">Chat</p>{linkedChats.map((linkedChat) => <Link className="job-chat-link" to={`/chat/${encodeURIComponent(linkedChat.id)}`} key={linkedChat.id}><span className="job-chat-icon"><MessageCircle size={17} /></span><span><strong>{linkedChat.title}</strong><small>Conversation · {timeAgo(linkedChat.updatedAt)}</small></span><ArrowRight size={15} /></Link>)}</div>}
          {flowRun && <WorkflowRunRecord flowRun={flowRun} active={workflowViewSelected} onSelect={selectWorkflowRun} />}
          <div className="source-files-desktop"><div className="file-tree-divider" /><p className="file-group-label">Source files</p>{sourceFileRows}</div>
          <details className="mobile-source-files"><summary><span><File size={16} />Source files</span><small>{job.inputs.length}</small><ChevronDown size={16} /></summary><div>{sourceFileRows}</div></details>
        </div>
        <div className="file-sidebar-footer"><span>Workflow</span><strong>{workflowLabel}</strong><span>Status</span><strong>{job.stage}</strong></div>
      </aside>

      <div className="preview-pane">
        {showWorkflowRun ? <ProcessingView job={job} flowRun={flowRun} /> : running ? <ProcessingView job={job} /> : selectedFile ? <>
          <div className="preview-sticky-stack">
            <div className="preview-toolbar">
              <div className="preview-file-name"><FileTypeIcon file={selectedInput?.name || selectedFile} /><span><strong>{selectedDisplayName}</strong><small>{selectedScope === "input" ? "Source file" : selectedFile.split("/").at(-1)} · {formatLabel(selectedKind, Boolean(html))}</small></span></div>
              <div className="preview-tools">{canRender && <div className="view-switch"><button className={previewMode === "rendered" ? "active" : ""} onClick={() => setPreviewMode("rendered")}>Preview</button><button className={previewMode === "source" ? "active" : ""} onClick={() => setPreviewMode("source")}>Source</button></div>}<span className="preview-action-buttons"><button className="icon-button rename-file-button" onClick={() => askToRename(selectedScope === "input" ? { kind: "input", file: selectedFile, value: selectedInput?.name || selectedFile } : { kind: "output", file: selectedFile, value: selectedFile.split("/").at(-1) || selectedFile })} disabled={running} aria-label="Rename file" title={running ? "Files cannot be renamed while processing" : "Rename file"}><Pencil size={16} /></button>{canCopy && <button className={cn("icon-button copy-file-button", copiedFile === selectedFile && "copied")} onClick={copyPreview} disabled={loadingPreview} aria-label={copiedFile === selectedFile ? "Copied file contents" : "Copy file contents"} title={copiedFile === selectedFile ? "Copied" : "Copy file contents"}>{copiedFile === selectedFile ? <Check size={17} /> : <Copy size={17} />}</button>}<button className="icon-button destructive-icon-button" onClick={() => askToDelete({ kind: selectedScope, file: selectedFile, label: selectedDisplayName })} disabled={running} aria-label="Delete file" title={running ? "Files cannot be deleted while processing" : "Delete file"}><Trash2 size={17} /></button><a className="icon-button open-file-button" href={selectedUrl} target="_blank" rel="noreferrer" aria-label="Open file"><ExternalLink size={17} /></a><a className="button-primary compact" href={selectedUrl} download><Download size={16} /><span>Download</span></a></span></div>
            </div>
            {selectedArtifact && (nextActions.length > 0 || compatibleWorkflows.length > 0) && <div className="artifact-flow-bar"><span>Continue with</span><div>{nextActions.map((action) => <Link className="artifact-flow-action" to={moduleHandoffUrl(action.id, job.id, selectedArtifact.id)} title={action.actionDescription} key={action.id}><FlowActionIcon moduleId={action.id} /><span>{action.actionLabel}</span><ArrowRight size={15} /></Link>)}{compatibleWorkflows.map((workflow) => <button type="button" className="artifact-flow-action workflow-flow-action" onClick={() => void runCompatibleWorkflow(workflow)} disabled={Boolean(startingWorkflowId)} title={workflow.description || `Run ${workflow.name}`} key={`workflow-${workflow.id}`}><GitBranch size={17} /><span>{workflow.name}</span>{startingWorkflowId === workflow.id ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowRight size={15} />}</button>)}</div></div>}
          </div>
          {selectedScope === "output" && job.type === "audio" && job.inputs[0] && selectedFile === outputFiles[0] && <div className="workspace-player">{job.inputs[0].mimeType.startsWith("video/") ? <video controls preload="metadata" src={`/api/jobs/${job.id}/input/${encodeURIComponent(job.inputs[0].storedName)}`} /> : <audio controls preload="metadata" src={`/api/jobs/${job.id}/input/${encodeURIComponent(job.inputs[0].storedName)}`} />}</div>}
          <div className={cn("preview-content", selectedMindMap && previewMode === "rendered" && "mindmap-preview-content")}>{loadingPreview ? <div className="preview-loading"><span className="spinner dark" />Loading preview…</div> : <OutputPreview content={preview} kind={selectedKind} html={html} mode={previewMode} title={selectedDisplayName} src={selectedUrl} />}</div>
        </> : <div className="workspace-empty"><FolderOpen size={36} /><h2>No output yet</h2><p>This job did not create any files.</p></div>}
      </div>
    </section>
    <RenameDialog open={Boolean(renameTarget)} title={renameDialogTitle} label={renameTarget?.kind === "job" ? "Job name" : "File name"} value={renameValue} helper={renamedExtension ? `The ${renamedExtension} extension will be preserved.` : undefined} busy={renaming} error={renameError} onChange={setRenameValue} onCancel={() => !renaming && setRenameTarget(undefined)} onConfirm={confirmRename} />
    <ConfirmDialog open={Boolean(deleteTarget)} title={deleteTitle} description={deleteDescription} busy={deleting} error={deleteError} onCancel={() => !deleting && setDeleteTarget(undefined)} onConfirm={confirmDelete} />
  </div>;
}

export function linkedChatsForJob(chats: Chat[], jobId: string) {
  return chats.filter((chat) => chat.linkedJobId === jobId);
}

function FlowActionIcon({ moduleId }: { moduleId: ModuleId }) {
  const Icon = moduleId === "translation" ? Languages : moduleId === "grounding" ? ScanSearch : moduleId === "ocr" ? ScanText : moduleId === "text-to-image" ? ImageIcon : moduleId === "mindmap" ? Network : MessageCircle;
  return <Icon size={17} />;
}

type WorkflowStatusCanvasNode = Node<{ node: WorkflowNode; run?: FlowNodeRun }, "workflow-status">;

const workflowServiceIcons: Record<WorkflowServiceId, typeof ScanText> = {
  ocr: ScanText,
  transcription: AudioLines,
  translation: Languages,
  grounding: ScanSearch,
  "text-to-image": ImageIcon,
  mindmap: Network,
  "llm-prompt": Bot,
  chat: MessageCircle,
};

function workflowNodeIcon(node: WorkflowNode) {
  const serviceId = node.type === "module" ? node.config.moduleId as WorkflowServiceId : undefined;
  return serviceId ? workflowServiceIcons[serviceId] || Braces
    : node.type === "input" ? FileInput
      : node.type === "select" ? Check
        : node.type === "if" ? GitBranch
          : node.type === "switch" ? Split
              : node.type === "merge" ? Combine
                : node.type === "save" ? Save
              : node.type === "end" ? CircleStop
                : node.type === "fail" ? TriangleAlert : Braces;
}

function WorkflowNodeStateIcon({ status, size = 17 }: { status: FlowNodeRun["status"]; size?: number }) {
  return status === "running" ? <LoaderCircle size={size} className="animate-spin" />
    : status === "succeeded" ? <Check size={size} />
      : status === "failed" || status === "blocked" ? <TriangleAlert size={size - 1} />
        : status === "cancelled" ? <Square size={size - 4} /> : <i />;
}

export function flowNodeHistoryLabel(run?: FlowNodeRun, now = Date.now()) {
  if (!run) return "Pending";
  const label = run.status === "succeeded" ? "Completed" : run.status === "running" ? "Running" : run.status === "ready" ? "Ready" : run.status === "skipped" ? "Skipped" : run.status.charAt(0).toUpperCase() + run.status.slice(1);
  if (!run.startedAt) return label;
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return label;
  const elapsed = end - start;
  const duration = elapsed < 1000 ? "<1s" : elapsed < 60_000 ? `${elapsed < 10_000 ? (elapsed / 1000).toFixed(1) : Math.round(elapsed / 1000)}s` : `${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1000)}s`;
  return `${label} · ${duration}`;
}

function WorkflowRunRecord({ flowRun, active, onSelect }: { flowRun: FlowRun; active: boolean; onSelect: () => void }) {
  const status = flowRun.status === "succeeded" ? "Completed" : flowRun.status === "running" ? "Running" : flowRun.status.charAt(0).toUpperCase() + flowRun.status.slice(1);
  return <section className="job-workflow-history">
    <div className="file-tree-divider" />
    <p className="file-group-label">Workflow run</p>
    <button type="button" className={cn("job-workflow-record", active && "active")} onClick={onSelect} aria-pressed={active}>
      <span className="job-workflow-icon"><GitBranch size={17} /></span>
      <span><strong>{flowRun.definition.name}</strong><small>{status} · {flowRun.definition.nodes.length} nodes · revision {flowRun.workflowRevision}</small></span>
      <ArrowRight size={15} />
    </button>
  </section>;
}

function WorkflowStatusNode({ data }: NodeProps<WorkflowStatusCanvasNode>) {
  const { node, run } = data;
  const status = run?.status || "pending";
  const Icon = workflowNodeIcon(node);
  const detail = run?.error || run?.detail || (status === "running" ? "Processing now" : status === "pending" ? "Waiting for input" : status === "ready" ? "Ready to run" : status === "succeeded" ? "Completed" : status === "skipped" ? "Branch not selected" : status);
  return <div className={cn("workflow-status-node", `status-${status}`)} aria-label={`${nodeTitle(node)}: ${status}`}>
    {node.type !== "input" && <Handle type="target" position={Position.Left} isConnectable={false} className="workflow-status-handle" />}
    <span className="workflow-status-node-icon"><Icon size={20} /></span>
    <span className="workflow-status-node-copy"><strong>{nodeTitle(node)}</strong><small>{detail}</small></span>
    <span className="workflow-status-node-state" title={status} aria-hidden="true"><WorkflowNodeStateIcon status={status} /></span>
    {node.type !== "end" && node.type !== "fail" && <Handle type="source" position={Position.Right} isConnectable={false} className="workflow-status-handle" />}
  </div>;
}

const workflowStatusNodeTypes = { "workflow-status": WorkflowStatusNode };

function WorkflowRunGraph({ flowRun }: { flowRun: FlowRun }) {
  const nodes = useMemo<WorkflowStatusCanvasNode[]>(() => flowRun.definition.nodes.map((node) => ({
    id: node.id,
    type: "workflow-status",
    position: node.position,
    data: { node, run: flowRun.nodes[node.id] },
    draggable: false,
    selectable: false,
  })), [flowRun]);
  const edges = useMemo<Edge[]>(() => flowRun.definition.edges.map((edge) => {
    const sourceRun = flowRun.nodes[edge.from.nodeId];
    const sourceStatus = sourceRun?.status || "pending";
    const targetStatus = flowRun.nodes[edge.to.nodeId]?.status || "pending";
    const selected = sourceRun?.selectedPortIds.includes(edge.from.portId) ?? false;
    const running = selected && targetStatus === "running";
    const completed = selected && sourceStatus === "succeeded" && ["running", "succeeded"].includes(targetStatus);
    const inactive = sourceStatus === "skipped" || (sourceStatus === "succeeded" && Boolean(sourceRun?.selectedPortIds.length) && !selected);
    const color = running ? "#f1f3f4" : completed ? "#72d9a4" : "#555d67";
    const label = ["output", "files", "input"].includes(edge.from.portId) ? undefined : edge.from.portId;
    return { id: edge.id, source: edge.from.nodeId, target: edge.to.nodeId, type: "smoothstep", animated: running, label, style: { stroke: color, strokeWidth: running ? 2.5 : 2, opacity: inactive ? 0.25 : 1 }, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color } };
  }), [flowRun]);
  return <div className="workflow-status-graph" aria-label={`Live node status for ${flowRun.definition.name}`}>
    <ReactFlow<WorkflowStatusCanvasNode, Edge> nodes={nodes} edges={edges} nodeTypes={workflowStatusNodeTypes} fitView fitViewOptions={{ padding: 0.2, minZoom: 0.55, maxZoom: 1 }} minZoom={0.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} colorMode="dark">
      <Background color="#343a43" gap={22} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
    <div className="workflow-status-gesture">Drag to explore · Pinch to zoom</div>
  </div>;
}

function ProcessingView({ job, flowRun }: { job: Job; flowRun?: FlowRun }) {
  if (!flowRun) return <div className="processing-view"><span className="processing-icon"><JobIcon type={job.type} moduleId={job.moduleId} /></span><p className="eyebrow">PROCESSING JOB</p><h2>{job.stage}</h2><p>{job.detail || "Work continues in the background. You can safely leave this page."}</p><div className="processing-progress"><Progress job={job} /><span>{job.progress}%</span></div><div className="processing-steps"><span className="done">Uploaded</span><span className={job.progress > 8 ? "done" : "active"}>Prepared</span><span className={job.progress > 90 ? "done" : "active"}>Processed</span><span className={job.progress === 100 ? "done" : ""}>Complete</span></div></div>;
  const totals = Object.values(flowRun.nodes).reduce<Record<string, number>>((counts, node) => ({ ...counts, [node.status]: (counts[node.status] || 0) + 1 }), {});
  return <div className="workflow-processing-view">
    <header><div><p className="eyebrow">WORKFLOW RUN</p><h2>{flowRun.definition.name}</h2><p><strong>{flowRun.stage}</strong>{job.detail && <span> · {job.detail}</span>}</p></div><span className="workflow-processing-percent">{flowRun.progress}%</span></header>
    <WorkflowRunGraph flowRun={flowRun} />
    <footer><div className="workflow-status-summary">{Object.entries(totals).map(([status, count]) => <span className={`status-${status}`} key={status}><i />{count} {status}</span>)}</div><div className="workflow-progress-track" aria-label={`${flowRun.progress}% complete`}><span style={{ width: `${flowRun.progress}%` }} /></div></footer>
  </div>;
}

function OutputPreview({ content, kind, html, mode, title, src }: { content: string; kind: ReturnType<typeof getFileKind>; html: string | null; mode: PreviewMode; title: string; src: string }) {
  if (kind === "image") return <div className="generated-image-preview"><img src={src} alt={title} /></div>;
  if (kind === "pdf") return <iframe className="source-document-preview" src={src} title={title} />;
  if (kind === "audio") return <div className="source-media-preview"><audio controls preload="metadata" src={src} /></div>;
  if (kind === "video") return <div className="source-media-preview"><video controls preload="metadata" src={src} /></div>;
  if (mode === "source") return <pre className="source-preview"><code>{content}</code></pre>;
  const mindMap = kind === "json" ? parseMindMap(content) : undefined;
  if (mindMap) return <MindMapViewer document={mindMap} />;
  if (html) return <AutoHeightHtmlPreview content={html} title={title} />;
  if (kind === "markdown") return <article className="prose-output"><MarkdownRenderer>{markdownForPreview(content)}</MarkdownRenderer></article>;
  if (kind === "json") { let formatted = content; try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch { /* show original */ } return <pre className="source-preview json"><code>{formatted}</code></pre>; }
  return <pre className="source-preview plain"><code>{content}</code></pre>;
}

function AutoHeightHtmlPreview({ content, title }: { content: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(580);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let observer: ResizeObserver | undefined;
    let animationFrame = 0;
    let removeImageListeners: () => void = () => undefined;

    const attach = () => {
      observer?.disconnect();
      removeImageListeners();
      const document = iframe.contentDocument;
      if (!document?.body) return;
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      const measure = () => {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = window.requestAnimationFrame(() => {
          const nextHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 580);
          setHeight(Math.ceil(nextHeight));
        });
      };
      const images = Array.from(document.images);
      images.forEach((image) => image.addEventListener("load", measure));
      removeImageListeners = () => images.forEach((image) => image.removeEventListener("load", measure));
      observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
      observer.observe(document.body);
      measure();
    };

    setHeight(580);
    iframe.addEventListener("load", attach);
    if (iframe.contentDocument?.readyState === "complete") attach();
    return () => {
      iframe.removeEventListener("load", attach);
      observer?.disconnect();
      removeImageListeners();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [content]);

  return <iframe ref={frame} className="html-preview" style={{ height }} title={`Rendered ${title}`} srcDoc={htmlDocument(content)} sandbox="allow-same-origin" referrerPolicy="no-referrer" scrolling="no" />;
}

function FileTypeIcon({ file }: { file: string }) {
  const kind = getFileKind(file);
  const mindmap = file === "mindmap.json" || file.endsWith(".mindmap.json");
  const Icon = mindmap ? Network : kind === "json" ? FileJson : kind === "subtitle" ? Subtitles : kind === "html" ? Code2 : kind === "image" ? ImageIcon : kind === "audio" ? FileAudio : kind === "video" ? FileVideo : kind === "pdf" ? File : FileText;
  return <span className={cn("file-type-icon", `file-type-${mindmap ? "mindmap" : kind}`)}><Icon size={17} /></span>;
}

export function getFileKind(file: string) {
  const extension = file.split(".").at(-1)?.toLowerCase();
  if (extension === "json") return "json" as const;
  if (extension === "srt" || extension === "vtt") return "subtitle" as const;
  if (extension === "html" || extension === "htm") return "html" as const;
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"].includes(extension || "")) return "image" as const;
  if (extension === "pdf") return "pdf" as const;
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"].includes(extension || "")) return "audio" as const;
  if (["mp4", "mov", "mkv", "webm", "avi"].includes(extension || "")) return "video" as const;
  if (extension === "md" || extension === "markdown") return "markdown" as const;
  return "text" as const;
}

export function extractHtml(content: string, file: string) {
  if (!content.trim()) return null;
  const fenced = content.trim().match(/^```html\s*\n([\s\S]*?)\n```$/i);
  const candidate = fenced?.[1] || content;
  if (fenced || getFileKind(file) === "html" || /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(candidate)) return candidate;
  return null;
}

export function htmlDocument(content: string) {
  const theme = `<style id="sparklingkit-preview-theme">:root{color-scheme:dark}html,body{background:#15181d;color:#e8eaed}body{font-family:Inter,Arial,sans-serif;margin:0;padding:32px;line-height:1.6}a{color:#f1f3f4;text-decoration-color:#7f8792}table{border-collapse:collapse;width:100%}th,td{border:1px solid #3c424b;padding:10px;text-align:left}th{background:#20242a}code{background:#252a31;border-radius:4px;padding:2px 5px}img{max-width:100%}</style>`;
  if (/<!doctype\s+html|<html[\s>]/i.test(content)) {
    if (/<\/head>/i.test(content)) return content.replace(/<\/head>/i, `${theme}</head>`);
    return content.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${theme}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${theme}</head><body>${content}</body></html>`;
}

export function markdownForPreview(content: string) {
  return content.replace(/<!--[^]*?-->\s*/g, "");
}

function describeOutput(file: string) {
  if (file === "document.md") return "Combined OCR document";
  if (file === "transcript.md") return "Complete readable transcript";
  if (file === "transcript.json") return "Structured transcript data";
  if (file.startsWith("generated-image.")) return "Generated image";
  if (file === "grounding-preview.svg") return "Image with located regions";
  if (file === "grounding.annotations.json") return "Locations and query data";
  if (file === "mindmap.json" || file.endsWith(".mindmap.json")) return "Interactive mind map";
  if (file === "mindmap-outline.md" || file.startsWith("mindmap-outline-")) return "Mind map outline";
  if (file.startsWith("summary.")) return "Prompt preset result";
  if (file.endsWith(".json")) return "Structured data";
  if (file.endsWith(".srt")) return "SRT subtitle track";
  if (file.endsWith(".vtt")) return "WebVTT subtitle track";
  return "Generated file";
}

function displayOutputName(file: string) {
  if (file === "document.md") return "Final document";
  if (file === "transcript.md") return "Transcript";
  if (file === "transcript.json") return "Transcript data";
  if (file === "transcript.srt") return "SRT subtitles";
  if (file === "transcript.vtt") return "WebVTT subtitles";
  if (file.startsWith("generated-image.")) return "Generated image";
  if (file === "grounding-preview.svg") return "Located regions";
  if (file === "grounding.annotations.json") return "Grounding data";
  if (file === "mindmap.json" || file.endsWith(".mindmap.json")) return "Mind map";
  if (file === "mindmap-outline.md" || file.startsWith("mindmap-outline-")) return "Mind map outline";
  if (file.startsWith("summary.") && file.endsWith(".md")) {
    const slug = file.slice("summary.".length, -".md".length);
    return slug.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }
  return file.split("/").at(-1) || file;
}

function formatLabel(kind: ReturnType<typeof getFileKind>, renderedHtml: boolean) {
  if (renderedHtml) return "HTML document";
  return { markdown: "Markdown document", json: "JSON data", subtitle: "Subtitle track", html: "HTML document", image: "Image", pdf: "PDF document", audio: "Audio", video: "Video", text: "Text file" }[kind];
}

function fileUrl(jobId: string, file: string) {
  return `/api/jobs/${jobId}/files/${file.split("/").map(encodeURIComponent).join("/")}`;
}

function inputFileUrl(jobId: string, file: string) {
  return `/api/jobs/${jobId}/input/${encodeURIComponent(file)}`;
}
