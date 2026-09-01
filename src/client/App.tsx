import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, type Location } from "react-router-dom";
import { api } from "./api";
import { AppShell } from "./components/AppShell";
import { GlobalSearchProvider } from "./components/GlobalSearch";
import { ToastProvider } from "./components/ToastProvider";
import { announceSettingsUpdated } from "./settings-events";
import type { Settings } from "./types";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SettingsPage } from "./pages/SettingsPage";

const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const JobPage = lazy(() => import("./pages/JobPage").then((module) => ({ default: module.JobPage })));
const ChatPage = lazy(() => import("./pages/ChatPage").then((module) => ({ default: module.ChatPage })));
const ModulesPage = lazy(() => import("./pages/ModulesPage").then((module) => ({ default: module.ModulesPage })));
const ModulePage = lazy(() => import("./pages/ModulesPage").then((module) => ({ default: module.ModulePage })));
const WorkflowsPage = lazy(() => import("./pages/WorkflowsPage").then((module) => ({ default: module.WorkflowsPage })));
const WorkflowEditorPage = lazy(() => import("./pages/WorkflowsPage").then((module) => ({ default: module.WorkflowEditorPage })));

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings>();
  const [settingsError, setSettingsError] = useState("");
  const routeState = location.state as { backgroundLocation?: Location } | null;
  const settingsOpen = location.pathname === "/settings";
  const backgroundLocation = settingsOpen
    ? routeState?.backgroundLocation ?? { ...location, pathname: "/", search: "", hash: "", state: null }
    : location;
  const hasConfiguredService = settings ? Object.values(settings.endpoints).some((endpoint) => endpoint.enabled && Boolean(endpoint.baseUrl.trim() && endpoint.model.trim())) : false;

  useEffect(() => {
    let active = true;
    api.settings().then((value) => active && setSettings(value)).catch((value) => active && setSettingsError(value instanceof Error ? value.message : String(value)));
    return () => { active = false; };
  }, []);

  function completeOnboarding(nextSettings: Settings, openServiceSettings = false) {
    setSettings(nextSettings);
    announceSettingsUpdated(nextSettings);
    navigate(openServiceSettings ? "/settings" : "/", { replace: true });
  }

  return (
    <ToastProvider>{!settings ? <div className="onboarding-loading"><div className="brand-wordmark">SparklingKit</div>{settingsError ? <><p>{settingsError}</p><button className="button-secondary" onClick={() => window.location.reload()}>Try again</button></> : <Loader />}</div> : (!settings.setup.completed || !hasConfiguredService || location.pathname === "/setup") ? <OnboardingPage settings={settings} canCancel={settings.setup.completed && hasConfiguredService} onComplete={completeOnboarding} onCancel={() => navigate("/", { replace: true })} /> : <GlobalSearchProvider><AppShell>
      <Suspense fallback={<div className="page-wrap"><div className="skeleton h-64" /></div>}>
        <Routes location={backgroundLocation}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/jobs/:id" element={<JobPage />} />
          <Route path="/tools" element={<ModulesPage />} />
          <Route path="/tools/:moduleId" element={<ModulePage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/:workflowId" element={<WorkflowEditorPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {settingsOpen && <SettingsPage />}
    </AppShell></GlobalSearchProvider>}</ToastProvider>
  );
}

function Loader() {
  return <div className="onboarding-loader" aria-label="Loading"><i /><i /><i /></div>;
}
