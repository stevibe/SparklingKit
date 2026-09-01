import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "./ui";

export type ToastTone = "success" | "error" | "info";

export type ToastOptions = {
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number;
};

type ToastItem = Required<Pick<ToastOptions, "title" | "tone" | "duration">> & {
  id: string;
  description?: string;
};

type ToastContextValue = {
  show: (options: ToastOptions | string) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
};

const DEFAULT_DURATION = 2_000;
const ToastContext = createContext<ToastContextValue | undefined>(undefined);
let toastSequence = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((options: ToastOptions | string) => {
    const normalized = typeof options === "string" ? { title: options } : options;
    const id = `toast-${Date.now().toString(36)}-${(++toastSequence).toString(36)}`;
    const toast: ToastItem = {
      id,
      title: normalized.title,
      description: normalized.description,
      tone: normalized.tone || "info",
      duration: normalized.duration ?? DEFAULT_DURATION,
    };
    setToasts((current) => [...current.slice(-3), toast]);
    timers.current.set(id, window.setTimeout(() => dismiss(id), toast.duration));
    return id;
  }, [dismiss]);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  const value = useMemo<ToastContextValue>(() => ({
    show,
    success: (title, description) => show({ title, description, tone: "success" }),
    error: (title, description) => show({ title, description, tone: "error" }),
    info: (title, description) => show({ title, description, tone: "info" }),
    dismiss,
  }), [dismiss, show]);

  return <ToastContext.Provider value={value}>
    {children}
    <section className="toast-viewport" aria-label="Notifications" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => <ToastCard toast={toast} onDismiss={() => dismiss(toast.id)} key={toast.id} />)}
    </section>
  </ToastContext.Provider>;
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? CircleAlert : Info;
  return <article className={cn("toast-card", `toast-${toast.tone}`)} role={toast.tone === "error" ? "alert" : "status"}>
    <span className="toast-icon" aria-hidden="true"><Icon size={19} /></span>
    <span className="toast-copy"><strong>{toast.title}</strong>{toast.description && <small>{toast.description}</small>}</span>
    <button type="button" className="toast-dismiss" onClick={onDismiss} aria-label={`Dismiss ${toast.title}`}><X size={16} /></button>
    <i className="toast-lifetime" aria-hidden="true" style={{ animationDuration: `${toast.duration}ms` }} />
  </article>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
