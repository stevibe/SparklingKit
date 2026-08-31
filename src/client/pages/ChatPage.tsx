import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ArrowUp, Bot, ChevronLeft, MessageCircle, Pencil, Plus, Square, Trash2, UserRound } from "lucide-react";
import { api, streamChat } from "../api";
import { cn, ConfirmDialog, RenameDialog, timeAgo } from "../components/ui";
import type { Chat, ChatMessage } from "../types";

const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) => {
    const external = Boolean(href && /^(https?:)?\/\//.test(href));
    return <a href={href} {...props} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} />;
  },
  table: ({ node: _node, ...props }) => <div className="message-table-wrap"><table {...props} /></div>,
};

const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "u"],
};

export function ChatPage() {
  const { id } = useParams();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat>();
  const [settledChatId, setSettledChatId] = useState<string>();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Chat>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const messages = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const initialPromptSent = useRef("");
  const navigate = useNavigate();
  const location = useLocation();
  const initialPrompt = ((location.state as { initialPrompt?: string } | null)?.initialPrompt || "").trim();

  useEffect(() => { api.chats().then(setChats).catch(() => undefined); }, [id, streaming]);
  useEffect(() => {
    let active = true;
    setError("");
    if (!id) {
      setChat(undefined);
      setSettledChatId(undefined);
      return () => { active = false; };
    }
    api.chat(id)
      .then((value) => { if (active) setChat(value); })
      .catch((value) => { if (active) { setChat(undefined); setError(value.message); } })
      .finally(() => { if (active) setSettledChatId(id); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => {
    const container = messages.current;
    container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [chat?.messages.length, draft]);
  useEffect(() => {
    const textarea = composerInput.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
  }, [input]);

  async function newChat() {
    const created = await api.createChat();
    navigate(`/chat/${created.id}`);
  }
  function askToDelete(item: Chat) {
    if (streaming && item.id === id) return;
    setDeleteError("");
    setDeleteTarget(item);
  }
  function askToRename() {
    if (!chat) return;
    setRenameValue(chat.title);
    setRenameError("");
    setRenameOpen(true);
  }
  async function confirmRename() {
    if (!chat) return;
    setRenaming(true);
    setRenameError("");
    try {
      const renamed = await api.renameChat(chat.id, renameValue);
      setChat(renamed);
      setChats((items) => items.map((item) => item.id === renamed.id ? renamed : item));
      setRenameOpen(false);
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
      await api.deleteChat(deleteTarget.id);
      setChats((items) => items.filter((item) => item.id !== deleteTarget.id));
      if (deleteTarget.id === id) {
        setChat(undefined);
        setSettledChatId(undefined);
        navigate("/chat", { replace: true });
      }
      setDeleteTarget(undefined);
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : String(deleteFailure));
    } finally {
      setDeleting(false);
    }
  }
  async function send(contentOverride?: string, chatOverride?: Chat) {
    const content = (contentOverride ?? input).trim();
    if (!content || streaming || (!chatOverride && loadingChat)) return;
    let current = chatOverride || chat;
    if (!current) {
      current = await api.createChat();
      setChat(current);
      navigate(`/chat/${current.id}`, { replace: true });
    }
    const optimistic: ChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
    setChat({ ...current, messages: [...current.messages, optimistic] });
    setInput("");
    setDraft("");
    setError("");
    setStreaming(true);
    controller.current = new AbortController();
    let accumulated = "";
    try {
      await streamChat(current.id, content, {
        onDelta: (delta) => { accumulated += delta; setDraft(accumulated); },
        onDone: () => undefined,
        onError: setError,
      }, controller.current.signal);
      setChat(await api.chat(current.id));
      setDraft("");
    } catch (streamError) {
      if ((streamError as Error).name !== "AbortError") setError(streamError instanceof Error ? streamError.message : String(streamError));
    } finally {
      setStreaming(false);
    }
  }

  const loadingChat = Boolean(id && chat?.id !== id && settledChatId !== id);
  useEffect(() => {
    if (!id || !initialPrompt || chat?.id !== id || streaming) return;
    const key = `${id}:${initialPrompt}`;
    if (initialPromptSent.current === key) return;
    initialPromptSent.current = key;
    navigate(`/chat/${id}`, { replace: true, state: null });
    void send(initialPrompt, chat);
  }, [chat?.id, id, initialPrompt, streaming]);
  const visibleMessages = chat?.messages.filter((message) => message.role !== "system") || [];
  return (
    <div className="chat-layout">
      <aside className={cn("chat-list", id && "hidden lg:flex")}>
        <div className="flex items-center justify-between px-1"><div><p className="eyebrow">CONVERSATIONS</p><h1 className="mt-1 text-xl font-semibold">Chat</h1></div><button className="icon-button bg-white" onClick={newChat} aria-label="New chat"><Plus size={18} /></button></div>
        <div className="mt-6 space-y-1.5 overflow-y-auto">
          {chats.map((item) => <Link key={item.id} to={`/chat/${item.id}`} className={cn("chat-list-item", item.id === id && "chat-list-item-active")}><MessageCircle size={16} /><div className="min-w-0"><p className="truncate text-sm font-medium">{item.title}</p><p className="mt-0.5 text-[14px] text-muted">{timeAgo(item.updatedAt)}</p></div></Link>)}
          {!chats.length && <p className="px-3 py-8 text-center text-sm text-muted">No conversations yet.</p>}
        </div>
      </aside>
      <section className={cn("chat-pane", !id && "hidden lg:flex")}>
        <header className="chat-header">
          <Link to="/chat" className="icon-button lg:hidden"><ChevronLeft size={19} /></Link>
          {loadingChat ? <div className="chat-header-skeleton" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /></div> : <div className="min-w-0 flex-1"><p className="truncate font-semibold">{chat?.title || "New conversation"}</p><p className="mt-0.5 text-[14px] text-muted">{chat?.model || "Qwen3.6-35B-A3B"}</p></div>}
          {!loadingChat && chat && <div className="chat-header-actions"><button className="icon-button" onClick={askToRename} disabled={streaming} aria-label="Rename conversation" title="Rename conversation"><Pencil size={16} /></button><button className="icon-button destructive-icon-button" onClick={() => askToDelete(chat)} disabled={streaming} aria-label="Delete conversation" title={streaming ? "Stop the response before deleting this conversation" : "Delete conversation"}><Trash2 size={17} /></button></div>}
        </header>
        <div ref={messages} className="chat-messages" aria-busy={loadingChat}>
          {loadingChat ? <ChatLoadingSkeleton /> : <>
            {!visibleMessages.length && !draft && !error && <div className="chat-welcome"><span><Bot size={28} /></span><h2>What are you working on?</h2><p>Ask a question, develop an idea, or open a completed job in chat to explore its contents.</p><div className="mt-6 flex flex-wrap justify-center gap-2">{["Summarize a concept", "Draft a project outline", "Compare two approaches"].map((suggestion) => <button key={suggestion} onClick={() => setInput(suggestion)}>{suggestion}</button>)}</div></div>}
            <div className="chat-reading-column">
              {visibleMessages.map((message) => <Message key={message.id} message={message} />)}
              {draft && <Message message={{ id: "draft", role: "assistant", content: draft, createdAt: new Date().toISOString() }} streaming />}
              {streaming && !draft && <div className="message-row"><span className="avatar avatar-ai"><Bot size={15} /></span><span className="thinking"><i /><i /><i /></span></div>}
              {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            </div>
          </>}
        </div>
        <div className="chat-composer-wrap">
          <div className="chat-composer">
            <textarea ref={composerInput} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={loadingChat ? "Loading conversation…" : "Message your local model…"} rows={1} disabled={streaming || loadingChat} />
            {streaming ? <button className="send-button" onClick={() => controller.current?.abort()} aria-label="Stop"><Square size={14} fill="currentColor" /></button> : <button className="send-button" onClick={() => void send()} disabled={loadingChat || !input.trim()} aria-label="Send"><ArrowUp size={18} /></button>}
          </div>
          <p>Enter to send · Shift + Enter for a new line</p>
        </div>
      </section>
      <RenameDialog open={renameOpen} title="Rename conversation" label="Conversation name" value={renameValue} busy={renaming} error={renameError} onChange={setRenameValue} onCancel={() => !renaming && setRenameOpen(false)} onConfirm={confirmRename} />
      <ConfirmDialog open={Boolean(deleteTarget)} title="Delete conversation?" description={<>“{deleteTarget?.title}” and all of its messages will be permanently deleted.</>} busy={deleting} error={deleteError} onCancel={() => !deleting && setDeleteTarget(undefined)} onConfirm={confirmDelete} />
    </div>
  );
}

function ChatLoadingSkeleton() {
  return <div className="chat-loading" role="status" aria-label="Loading conversation">
    <span className="sr-only">Loading conversation…</span>
    <div className="chat-loading-row"><span className="skeleton chat-loading-avatar" /><span className="skeleton chat-loading-block" /></div>
    <div className="chat-loading-row from-user"><span className="skeleton chat-loading-avatar" /><span className="skeleton chat-loading-block" /></div>
    <div className="chat-loading-row tall"><span className="skeleton chat-loading-avatar" /><span className="skeleton chat-loading-block" /></div>
  </div>;
}

function Message({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const assistant = message.role === "assistant";
  return <div className={cn("message-row", !assistant && "message-user")}><span className={cn("avatar", assistant ? "avatar-ai" : "avatar-user")}>{assistant ? <Bot size={15} /> : <UserRound size={15} />}</span><div className={cn("message-content", !assistant && "message-bubble")}><ChatMarkdown>{message.content}</ChatMarkdown>{streaming && <span className="cursor" />}</div></div>;
}

export function ChatMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]} components={markdownComponents}>{children}</ReactMarkdown>;
}
