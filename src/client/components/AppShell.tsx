import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { AudioLines, BrainCircuit, Image as ImageIcon, LayoutGrid, Languages, MessageCircle, PanelLeftClose, PanelLeftOpen, ScanSearch, ScanText, Settings } from "lucide-react";
import { api } from "../api";
import type { Health, ModuleDescriptor } from "../types";

const moduleIcons = { "scan-text": ScanText, "audio-lines": AudioLines, languages: Languages, "scan-search": ScanSearch, image: ImageIcon, "message-circle": MessageCircle };
const mobileNav = [
  { to: "/", label: "Home", icon: LayoutGrid, exact: true },
  { to: "/tools", label: "Tools", icon: ScanSearch, exact: false },
  { to: "/chat", label: "Chat", icon: MessageCircle, exact: false },
  { to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

const services = [
  { kind: "stt" as const, label: "STT", fallback: "Speech recognition", icon: AudioLines },
  { kind: "ocr" as const, label: "OCR", fallback: "Document recognition", icon: ScanText },
  { kind: "llm" as const, label: "LLM", fallback: "Language model", icon: BrainCircuit },
  { kind: "translation" as const, label: "Translation", fallback: "Not configured", icon: Languages },
  { kind: "grounding" as const, label: "Grounding", fallback: "Not configured", icon: ScanSearch },
  { kind: "image-generation" as const, label: "Image", fallback: "Not configured", icon: ImageIcon },
];
const sidebarPreferenceKey = "sparklingkit:sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health>();
  const [modules, setModules] = useState<ModuleDescriptor[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem(sidebarPreferenceKey) === "true"; } catch { return false; }
  });
  const location = useLocation();

  useEffect(() => {
    let active = true;
    const refresh = () => api.health().then((value) => active && setHealth(value)).catch(() => active && setHealth(undefined));
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { api.modules().then(setModules).catch(() => setModules([])); }, []);
  const enabled = health ? Object.values(health.endpoints).filter((item) => item.enabled) : [];
  const healthy = enabled.filter((item) => item.ok).length;
  const serviceSummary = health ? `${healthy}/${enabled.length} online` : "Checking";
  const activeChat = location.pathname.startsWith("/chat/");
  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try { window.localStorage.setItem(sidebarPreferenceKey, String(next)); } catch { /* Storage can be unavailable in private contexts. */ }
  };
  return (
    <div className={`app-shell min-h-screen bg-canvas text-ink ${activeChat ? "active-chat-shell" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <header className="mobile-header">
        <Link to="/" className="brand-wordmark" aria-label="SparklingKit home">SparklingKit</Link>
        <Link to="/settings" state={{ backgroundLocation: location }} className="mobile-service-chip" aria-label={`Open settings, ${serviceSummary}`}><i className={enabled.length > 0 && healthy === enabled.length ? "online" : ""} />{serviceSummary}</Link>
      </header>
      <aside className="sidebar" id="app-sidebar">
        <div className="sidebar-brand-row">
          <Link to="/" className="brand-wordmark" aria-label="SparklingKit home">SparklingKit</Link>
          <button type="button" className="sidebar-collapse-button" onClick={toggleSidebar} aria-controls="app-sidebar" aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button>
        </div>
        <p className="nav-label">Workspace</p>
        <nav>
          <NavLink to="/" end title="Workbench" aria-label="Workbench" className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}><LayoutGrid size={19} strokeWidth={1.8} /><span>Workbench</span></NavLink>
          <p className="nav-label nav-label-tools">Tools</p>
          <div className="module-nav-list">{modules.map((module) => {
            const Icon = moduleIcons[module.icon];
            return <NavLink key={module.id} to={module.route} title={module.title} aria-label={module.title} className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}><Icon size={19} strokeWidth={1.8} /><span>{module.title}</span>{module.implementation === "planned" && <small>Planned</small>}</NavLink>;
          })}</div>
          <NavLink to="/settings" state={{ backgroundLocation: location }} title="Settings" aria-label="Settings" className={({ isActive }) => `nav-link settings-nav-link ${isActive ? "nav-link-active" : ""}`}><Settings size={19} strokeWidth={1.8} /><span>Settings</span></NavLink>
        </nav>
        <div className="mt-auto">
          <div className="service-monitor">
            <div className="status-card-heading">
              <strong>AI services</strong>
            </div>
            <div className="service-list">
              {services.map(({ kind, label, fallback, icon: Icon }) => {
                const endpoint = health?.endpoints[kind];
                const state = endpoint?.ok ? "Online" : endpoint && !endpoint.enabled ? "Disabled" : health ? "Offline" : "Checking";
                return <div className="service-row" key={kind}>
                  <span className={`service-icon service-icon-${kind}`}><Icon size={16} strokeWidth={1.9} /></span>
                  <span className="service-copy"><strong>{label}</strong><small title={endpoint?.model || fallback}>{endpoint?.model || fallback}</small></span>
                  <span className={`service-state ${endpoint?.ok ? "online" : endpoint && !endpoint.enabled ? "disabled" : health ? "offline" : "checking"}`} role="img" aria-label={`${label}: ${state}`} title={state}><i /></span>
                </div>;
              })}
            </div>
          </div>
        </div>
      </aside>
      <main className="main-content">{children}</main>
      <nav className="mobile-tabbar" aria-label="Primary navigation">
        {mobileNav.map(({ to, label, icon: Icon, exact }) => <NavLink key={to} to={to} state={to === "/settings" ? { backgroundLocation: location } : undefined} end={exact} className={({ isActive }) => isActive ? "active" : ""}><Icon size={20} strokeWidth={1.9} /><span>{label}</span></NavLink>)}
      </nav>
    </div>
  );
}
