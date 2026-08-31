import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, File, FolderKanban, Image as ImageIcon, MessageCircle, Search, Shapes, X } from "lucide-react";
import { api } from "../api";
import type { ModuleId, SearchResponse, SearchResult, SearchScope } from "../types";
import { cn, timeAgo } from "./ui";

export interface SearchOpenOptions {
  scope?: SearchScope;
  moduleId?: ModuleId;
  title?: string;
}

interface SearchContextValue {
  openSearch: (options?: SearchOpenOptions) => void;
}

const SearchContext = createContext<SearchContextValue | undefined>(undefined);

export function useGlobalSearch() {
  const value = useContext(SearchContext);
  if (!value) throw new Error("useGlobalSearch must be used inside GlobalSearchProvider");
  return value;
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(0);
  const [request, setRequest] = useState<SearchOpenOptions>();
  const openSearch = useCallback((options: SearchOpenOptions = {}) => {
    setRequest({ scope: "all", ...options });
    setSession((value) => value + 1);
  }, []);
  const closeSearch = useCallback(() => setRequest(undefined), []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      } else if (event.key === "Escape" && request) {
        event.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSearch, openSearch, request]);

  return <SearchContext.Provider value={{ openSearch }}>
    {children}
    {request && <GlobalSearchDialog key={session} request={request} onClose={closeSearch} />}
  </SearchContext.Provider>;
}

function GlobalSearchDialog({ request, onClose }: { request: SearchOpenOptions; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const resultsElement = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const scope = request.scope || "all";

  useEffect(() => {
    input.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousBodyOverflow; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api.search(query, scope, request.moduleId, controller.signal)
        .then((value) => { setResponse(value); setActiveIndex(0); })
        .catch((value) => { if ((value as Error).name !== "AbortError") setError(value instanceof Error ? value.message : String(value)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 160 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, request.moduleId, scope]);

  useEffect(() => {
    resultsElement.current?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const results = response?.results || [];
  const grouped = useMemo(() => [
    { id: "work" as const, label: query ? "Work" : "Recent work", items: results.filter((result) => result.group === "work") },
    { id: "conversations" as const, label: "Conversations", items: results.filter((result) => result.group === "conversations") },
    { id: "tools" as const, label: "Tools", items: results.filter((result) => result.group === "tools") },
  ].filter((group) => group.items.length), [query, results]);
  const resultIndex = new Map(results.map((result, index) => [result.id, index]));

  function choose(result: SearchResult) {
    onClose();
    navigate(result.url);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((value) => (value + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((value) => (value - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (results[activeIndex]) choose(results[activeIndex]);
    }
  }

  const title = request.title || (scope === "work" ? "Search work" : scope === "chats" ? "Search conversations" : scope === "tools" ? "Search tools" : "Search SparklingKit");
  return <div className="global-search-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="global-search-dialog" role="dialog" aria-modal="true" aria-labelledby="global-search-title">
      <header className="global-search-header">
        <Search size={21} />
        <div><h2 id="global-search-title">{title}</h2><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleInputKeyDown} placeholder="Search jobs, files, conversations, and tools" aria-label={title} aria-controls="global-search-results" aria-activedescendant={results[activeIndex] ? `search-result-${activeIndex}` : undefined} /></div>
        {loading && <span className="spinner dark global-search-spinner" aria-label="Searching" />}
        <button className="global-search-close" onClick={onClose} aria-label="Close search"><X size={20} /></button>
      </header>
      <div className="global-search-results" id="global-search-results" ref={resultsElement} role="listbox">
        {error ? <div className="global-search-empty"><strong>Search unavailable</strong><p>{error}</p></div> : !loading && !results.length ? <div className="global-search-empty"><Search size={28} /><strong>No results</strong><p>Try a file name, job title, conversation, or tool.</p></div> : grouped.map((group) => <section className="global-search-group" key={group.id}><h3>{group.label}</h3>{group.items.map((result) => {
          const index = resultIndex.get(result.id) || 0;
          return <button id={`search-result-${index}`} data-result-index={index} role="option" aria-selected={activeIndex === index} className={cn("global-search-result", activeIndex === index && "active")} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(result)} key={result.id}>
            <span className={cn("global-search-result-icon", `type-${result.type}`)}><ResultIcon result={result} /></span>
            <span className="global-search-result-copy"><strong>{result.title}</strong><small>{result.subtitle}</small></span>
            {result.updatedAt && <time>{timeAgo(result.updatedAt)}</time>}
            <ArrowRight size={17} />
          </button>;
        })}</section>)}
      </div>
      <footer className="global-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span>{response && response.total > response.results.length && <small>{response.results.length} of {response.total} results</small>}</footer>
    </section>
  </div>;
}

function ResultIcon({ result }: { result: SearchResult }) {
  if (result.type === "conversation") return <MessageCircle size={19} />;
  if (result.type === "module") return <Shapes size={19} />;
  if (result.type === "job") return <FolderKanban size={19} />;
  if (result.artifactKind && ["source-image", "generated-image", "grounded-image"].includes(result.artifactKind)) return <ImageIcon size={19} />;
  return <File size={19} />;
}
