import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { AudioLines, BrainCircuit, GitBranch, Image as ImageIcon, LayoutGrid, Languages, MessageCircle, PanelLeftClose, PanelLeftOpen, ScanSearch, ScanText, Search, Settings } from "lucide-react";
import { api } from "../api";
import type { Health, ModuleDescriptor, SparkStatus } from "../types";
import { useGlobalSearch } from "./GlobalSearch";

const moduleIcons = { "scan-text": ScanText, "audio-lines": AudioLines, languages: Languages, "scan-search": ScanSearch, image: ImageIcon, "message-circle": MessageCircle };
const mobileNav = [
  { to: "/", label: "Home", icon: LayoutGrid, exact: true },
  { to: "/workflows", label: "Flows", icon: GitBranch, exact: false },
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

function gibibytes(bytes: number) {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health>();
  const [sparkStatus, setSparkStatus] = useState<SparkStatus>();
  const [modules, setModules] = useState<ModuleDescriptor[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem(sidebarPreferenceKey) === "true"; } catch { return false; }
  });
  const location = useLocation();
  const { openSearch } = useGlobalSearch();

  useEffect(() => {
    let active = true;
    const refresh = () => api.health().then((value) => active && setHealth(value)).catch(() => active && setHealth(undefined));
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => api.systemStatus().then((value) => active && setSparkStatus(value)).catch(() => active && setSparkStatus(undefined));
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { api.modules().then(setModules).catch(() => setModules([])); }, []);
  const enabled = health ? Object.values(health.endpoints).filter((item) => item.enabled) : [];
  const healthy = enabled.filter((item) => item.ok).length;
  const serviceSummary = health ? `${healthy}/${enabled.length} online` : "Checking";
  const activeChat = location.pathname.startsWith("/chat/");
  const gpu = sparkStatus?.gpu.devices[0];
  const memory = sparkStatus?.host.memory;
  const onlineModels = sparkStatus?.services.filter((service) => service.ok).length || 0;
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
        <button type="button" className="sidebar-search-button" onClick={() => openSearch()} title="Search SparklingKit (⌘K)" aria-label="Search SparklingKit"><Search size={18} /><span>Search</span><kbd>⌘K</kbd></button>
        <p className="nav-label">Workspace</p>
        <nav>
          <NavLink to="/" end title="Workbench" aria-label="Workbench" className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}><LayoutGrid size={19} strokeWidth={1.8} /><span>Workbench</span></NavLink>
          <NavLink to="/workflows" title="Workflows" aria-label="Workflows" className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}><GitBranch size={19} strokeWidth={1.8} /><span>Workflows</span></NavLink>
          <p className="nav-label nav-label-tools">Tools</p>
          <div className="module-nav-list">{modules.map((module) => {
            const Icon = moduleIcons[module.icon];
            return <NavLink key={module.id} to={module.route} title={module.title} aria-label={module.title} className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}><Icon size={19} strokeWidth={1.8} /><span>{module.title}</span>{module.implementation === "planned" && <small>Planned</small>}</NavLink>;
          })}</div>
          <NavLink to="/settings" state={{ backgroundLocation: location }} title="Settings" aria-label="Settings" className={({ isActive }) => `nav-link settings-nav-link ${isActive ? "nav-link-active" : ""}`}><Settings size={19} strokeWidth={1.8} /><span>Settings</span></NavLink>
        </nav>
        <div className="mt-auto">
          <div className="spark-monitor">
            <div className="spark-monitor-heading"><strong>DGX Spark</strong><span className={sparkStatus ? "online" : ""}><i />{sparkStatus ? "Live" : "Unavailable"}</span></div>
            {memory ? <>
              <div className="spark-monitor-metric"><span>VRAM</span><strong>{gibibytes(memory.usedBytes)} / {gibibytes(memory.totalBytes)}</strong></div>
              <div className="spark-memory-track"><i style={{ width: `${Math.min(100, memory.usedPercent)}%` }} /></div>
              <div className="spark-monitor-metric spark-monitor-cuda"><span>CUDA allocations</span><strong>{gibibytes(sparkStatus.gpu.allocatedProcessMemoryBytes)}</strong></div>
              <div className="spark-monitor-foot"><span>GPU {gpu?.utilizationPercent ?? 0}%{gpu?.temperatureC != null ? ` · ${gpu.temperatureC}°C` : ""}</span><span>{onlineModels}/6 models</span></div>
            </> : <small>Status reporter on port 8330</small>}
          </div>
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
        {mobileNav.slice(0, 2).map(({ to, label, icon: Icon, exact }) => <NavLink key={to} to={to} end={exact} className={({ isActive }) => isActive ? "active" : ""}><Icon size={20} strokeWidth={1.9} /><span>{label}</span></NavLink>)}
        <button type="button" onClick={() => openSearch()} aria-label="Search"><Search size={20} strokeWidth={1.9} /><span>Search</span></button>
        {mobileNav.slice(2).map(({ to, label, icon: Icon, exact }) => <NavLink key={to} to={to} state={to === "/settings" ? { backgroundLocation: location } : undefined} end={exact} className={({ isActive }) => isActive ? "active" : ""}><Icon size={20} strokeWidth={1.9} /><span>{label}</span></NavLink>)}
      </nav>
    </div>
  );
}
