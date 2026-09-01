import { useEffect, useId, useRef, type ReactNode } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Check, CheckCircle2, Clock3, FileImage, FileText, LoaderCircle, Mic2, Network, Pencil, Trash2, TriangleAlert, XCircle } from "lucide-react";
import type { Job, JobKind, JobStatus, ModuleId } from "../types";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

export function JobIcon({ type, moduleId, className }: { type: JobKind; moduleId?: ModuleId; className?: string }) {
  const Icon = moduleId === "mindmap" ? Network : type === "audio" ? Mic2 : type === "image" || type === "text" ? FileImage : FileText;
  return <span className={cn("job-icon", `job-icon-${moduleId === "mindmap" ? "mindmap" : type}`, className)}><Icon size={20} strokeWidth={1.8} /></span>;
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const running = ["queued", "preparing", "processing", "merging"].includes(status);
  const Icon = running ? (status === "queued" ? Clock3 : LoaderCircle) : status === "done" ? CheckCircle2 : status === "done_with_warnings" ? TriangleAlert : XCircle;
  const label = status === "done_with_warnings" ? "Done with warnings" : status.replaceAll("_", " ");
  return <span className={cn("status-badge", `status-${status}`)}><Icon size={13} className={running && status !== "queued" ? "animate-spin" : ""} />{label}</span>;
}

export function Progress({ job }: { job: Pick<Job, "progress" | "status"> }) {
  return <div className="progress-track"><span className={cn("progress-fill", job.status === "failed" && "bg-red-500")} style={{ width: `${job.progress}%` }} /></div>;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelHandler = useRef(onCancel);
  const busyState = useRef(busy);
  cancelHandler.current = onCancel;
  busyState.current = busy;

  useEffect(() => {
    if (!open) return;
    confirmButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyState.current) cancelHandler.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <span className="confirm-dialog-icon"><Trash2 size={21} /></span>
      <div className="confirm-dialog-copy"><h2 id={titleId}>{title}</h2><div id={descriptionId}>{description}</div></div>
      {error && <p className="confirm-dialog-error">{error}</p>}
      <div className="confirm-dialog-actions"><button className="button-secondary" onClick={onCancel} disabled={busy}>Cancel</button><button ref={confirmButton} className="button-danger" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Trash2 size={16} />}{busy ? "Deleting…" : confirmLabel}</button></div>
    </div>
  </div>;
}

export function RenameDialog({
  open,
  title,
  label,
  value,
  helper,
  busy = false,
  error,
  onChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  value: string;
  helper?: string;
  busy?: boolean;
  error?: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const cancelHandler = useRef(onCancel);
  const busyState = useRef(busy);
  cancelHandler.current = onCancel;
  busyState.current = busy;

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => input.current?.select(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyState.current) cancelHandler.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
    <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
      <span className="rename-dialog-icon"><Pencil size={20} /></span>
      <div className="rename-dialog-copy"><h2 id={titleId}>{title}</h2><label className="field-label">{label}<input ref={input} className="input mt-2" value={value} onChange={(event) => onChange(event.target.value)} maxLength={180} /></label>{helper && <p>{helper}</p>}</div>
      {error && <p className="confirm-dialog-error">{error}</p>}
      <div className="confirm-dialog-actions"><button type="button" className="button-secondary" onClick={onCancel} disabled={busy}>Cancel</button><button type="submit" className="button-primary" disabled={busy || !value.trim()}>{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{busy ? "Saving…" : "Save"}</button></div>
    </form>
  </div>;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

export function timeAgo(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}
