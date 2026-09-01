import { useState } from "react";
import { FileStack, Play, Upload, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { startWorkflow } from "../api";
import type { ArtifactKind, WorkflowDefinition } from "../../shared/contracts";
import { workflowInputKinds } from "../../shared/workflows";

const directFileInputs: Partial<Record<ArtifactKind, string>> = {
  "source-image": "image/*",
  "source-pdf": "application/pdf,.pdf",
  "source-audio": "audio/*",
  "source-video": "video/*",
};

const inputLabels: Partial<Record<ArtifactKind, string>> = {
  "source-image": "images",
  "source-pdf": "PDFs",
  "source-audio": "audio",
  "source-video": "video",
  document: "documents",
  transcript: "transcripts",
  subtitle: "subtitles",
  translation: "translations",
  annotations: "annotations",
  "redacted-document": "redacted documents",
  "grounded-image": "grounded images",
  "generated-image": "generated images",
  "structured-data": "structured data",
  text: "text",
};

export function workflowInputSummary(definition: WorkflowDefinition) {
  return workflowInputKinds(definition).map((kind) => inputLabels[kind] || kind.replaceAll("-", " ")).join(", ");
}

export function RunWorkflowDialog({ definition, onClose }: { definition: WorkflowDefinition; onClose: () => void }) {
  const inputNode = definition.nodes.find((node) => node.type === "input")!;
  const accepts = workflowInputKinds(definition);
  const textAccepted = accepts.includes("text");
  const fileAccept = accepts.map((kind) => directFileInputs[kind]).filter((value): value is string => Boolean(value)).join(",");
  const filesAccepted = Boolean(fileAccept);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function run() {
    if (!files.length && !text.trim()) return;
    setRunning(true);
    setError("");
    try {
      const result = await startWorkflow(definition.id, files.length ? { files } : { text: text.trim() }, setProgress);
      navigate(`/jobs/${result.job.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setRunning(false);
    }
  }

  return <div className="workflow-run-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="workflow-run-dialog" role="dialog" aria-modal="true" aria-labelledby="run-workflow-title">
      <header><div><h2 id="run-workflow-title">Run {definition.name}</h2><p>Add the input this workflow should process.</p></div><button onClick={onClose} aria-label="Close"><X size={20} /></button></header>
      <div className="workflow-run-content">
        {filesAccepted && <label className="workflow-file-input"><Upload size={25} /><span><strong>{files.length ? files.length === 1 ? files[0].name : `${files.length} files selected` : "Choose files"}</strong><small>{workflowInputSummary(definition)}</small></span><input type="file" accept={fileAccept} multiple={inputNode.config.multiple !== false} onChange={(event) => { setFiles([...event.target.files || []]); if (event.target.files?.length) setText(""); }} /></label>}
        {filesAccepted && textAccepted && <div className="workflow-run-or"><span>or enter text</span></div>}
        {textAccepted && <textarea className="input" rows={7} value={text} onChange={(event) => { setText(event.target.value); if (event.target.value) setFiles([]); }} placeholder="Paste text for the workflow…" />}
        {!filesAccepted && !textAccepted && <div className="workflow-existing-input-note"><FileStack size={25} /><div><strong>Continue from existing work</strong><p>This workflow accepts {workflowInputSummary(definition)}. Open a completed job and choose this workflow under Continue with.</p></div></div>}
        {error && <div className="error-card">{error}</div>}
        {running && <div className="progress-track"><span className="progress-fill" style={{ width: `${progress}%` }} /></div>}
      </div>
      <footer><button className="button-secondary" onClick={onClose}>Cancel</button>{(filesAccepted || textAccepted) && <button className="button-primary" onClick={() => void run()} disabled={running || (!files.length && !text.trim())}>{running ? `Starting ${progress}%` : <><Play size={17} />Run workflow</>}</button>}</footer>
    </section>
  </div>;
}
