import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, type Location } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { GlobalSearchProvider } from "./components/GlobalSearch";
import { SettingsPage } from "./pages/SettingsPage";

const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const JobPage = lazy(() => import("./pages/JobPage").then((module) => ({ default: module.JobPage })));
const ChatPage = lazy(() => import("./pages/ChatPage").then((module) => ({ default: module.ChatPage })));
const ModulesPage = lazy(() => import("./pages/ModulesPage").then((module) => ({ default: module.ModulesPage })));
const ModulePage = lazy(() => import("./pages/ModulesPage").then((module) => ({ default: module.ModulePage })));

export function App() {
  const location = useLocation();
  const routeState = location.state as { backgroundLocation?: Location } | null;
  const settingsOpen = location.pathname === "/settings";
  const backgroundLocation = settingsOpen
    ? routeState?.backgroundLocation ?? { ...location, pathname: "/", search: "", hash: "", state: null }
    : location;

  return (
    <GlobalSearchProvider><AppShell>
      <Suspense fallback={<div className="page-wrap"><div className="skeleton h-64" /></div>}>
        <Routes location={backgroundLocation}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/jobs/:id" element={<JobPage />} />
          <Route path="/tools" element={<ModulesPage />} />
          <Route path="/tools/:moduleId" element={<ModulePage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {settingsOpen && <SettingsPage />}
    </AppShell></GlobalSearchProvider>
  );
}
