import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  SelectionMode,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  AudioLines,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleStop,
  Combine,
  FileInput,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Languages,
  Merge,
  MessageCircle,
  Play,
  Plus,
  Save,
  ScanSearch,
  ScanText,
  Split,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api, startWorkflow } from "../api";
import { cn, timeAgo } from "../components/ui";
import { SearchSelect } from "../components/SearchSelect";
import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  type FlowRun,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowServiceId,
  type WorkflowValidationResult,
} from "../../shared/contracts";
import {
  compatibleArtifactKinds,
  createStarterWorkflow,
  nodeOutputPorts,
  nodeTitle,
} from "../../shared/workflows";

type ServiceCatalogItem = { id: WorkflowServiceId; title: string; accepts: ArtifactKind[]; produces: ArtifactKind[]; terminal?: boolean; configured: boolean };
type CanvasNode = Node<{ workflowNode: WorkflowNode }, "workflow">;

const serviceIcons: Record<WorkflowServiceId, typeof ScanText> = {
  ocr: ScanText,
  transcription: AudioLines,
  translation: Languages,
  grounding: ScanSearch,
  "text-to-image": ImageIcon,
  "llm-prompt": Bot,
  chat: MessageCircle,
};
const genericNodes: Array<{ type: WorkflowNodeType; title: string; icon: typeof FileInput }> = [
  { type: "input", title: "Input", icon: FileInput },
  { type: "select", title: "Select", icon: Check },
  { type: "if", title: "If", icon: GitBranch },
  { type: "switch", title: "Switch", icon: Split },
  { type: "merge", title: "Merge", icon: Combine },
  { type: "end", title: "End", icon: CircleStop },
  { type: "fail", title: "Fail", icon: X },
];

function flowStatusClass(status: FlowRun["status"]) {
  return status === "succeeded" ? "succeeded" : status === "failed" || status === "cancelled" ? "failed" : status === "blocked" ? "blocked" : "running";
}

function workflowSlug(name: string) {
  return name.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 48) || `workflow-${Date.now().toString(36)}`;
}

export function WorkflowsPage() {
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    Promise.all([api.workflows(), api.workflowRuns()])
      .then(([items, history]) => { setDefinitions(items); setRuns(history); })
      .catch((value) => setError(value instanceof Error ? value.message : String(value)))
      .finally(() => setLoading(false));
  }, []);

  async function createWorkflow() {
    setError("");
    const now = new Date().toISOString();
    const definition = createStarterWorkflow(now);
    definition.id = `workflow-${Date.now().toString(36)}`;
    try {
      const created = await api.createWorkflow(definition);
      navigate(`/workflows/${created.definition.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  return <div className="workflow-library-page">
    <header className="workflow-library-header"><div><h1>Workflows</h1><p>Connect your services into reusable, file-based flows.</p></div><button className="button-primary" onClick={() => void createWorkflow()}><Plus size={18} />New workflow</button></header>
    {error && <div className="error-card">{error}</div>}
    {loading ? <div className="workflow-card-grid">{Array.from({ length: 3 }, (_, index) => <div className="skeleton h-48" key={index} />)}</div> : definitions.length ? <div className="workflow-card-grid">{definitions.map((definition) => {
      const latest = runs.find((run) => run.workflowId === definition.id);
      return <Link className="workflow-card" to={`/workflows/${definition.id}`} key={definition.id}>
        <span className="workflow-card-icon"><GitBranch size={23} /></span>
        <span className="workflow-card-copy"><span><strong>{definition.name}</strong>{definition.enabled && <small>Enabled</small>}</span><p>{definition.description || "A reusable SparklingKit workflow"}</p><b>{definition.nodes.length} nodes · revision {definition.revision}</b></span>
        {latest ? <span className={`flow-run-state ${flowStatusClass(latest.status)}`}><i />{latest.status}<small>{timeAgo(latest.updatedAt)}</small></span> : <ChevronRight size={19} />}
      </Link>;
    })}</div> : <div className="workflow-empty"><GitBranch size={30} /><h2>Build your first workflow</h2><p>Start with a file, connect compatible services, and keep every result together.</p><button className="button-primary" onClick={() => void createWorkflow()}><Plus size={18} />New workflow</button></div>}
    {runs.length > 0 && <section className="workflow-recent"><h2>Recent runs</h2><div>{runs.slice(0, 10).map((run) => <Link to={`/jobs/${run.jobId}`} key={run.id}><span className={`flow-run-dot ${flowStatusClass(run.status)}`} /><span><strong>{run.definition.name}</strong><small>{run.stage} · {timeAgo(run.updatedAt)}</small></span><b>{run.progress}%</b><ChevronRight size={17} /></Link>)}</div></section>}
  </div>;
}

function CanvasWorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.workflowNode;
  const serviceId = node.type === "module" ? node.config.moduleId as WorkflowServiceId : undefined;
  const generic = genericNodes.find((candidate) => candidate.type === node.type);
  const Icon = serviceId ? serviceIcons[serviceId] || Braces : generic?.icon || Braces;
  const ports = nodeOutputPorts(node);
  const detail = node.type === "module" ? serviceId === "translation" ? String((node.config.params as Record<string, unknown> | undefined)?.targetLanguage || "Choose language") : serviceId === "grounding" ? `${Array.isArray((node.config.params as Record<string, unknown> | undefined)?.queries) ? ((node.config.params as Record<string, unknown>).queries as unknown[]).length : 0} queries` : serviceId === "llm-prompt" ? "Custom instruction" : "Service" : node.type === "input" ? `${Array.isArray(node.config.accepts) ? node.config.accepts.length : 0} input types` : node.type === "select" ? `${Array.isArray(node.config.kinds) ? node.config.kinds.length : 0} result types` : node.type === "merge" ? String(node.config.mode || "all") : node.type === "if" ? "true / false" : node.type;
  return <div className={cn("workflow-node", `workflow-node-${node.type}`, serviceId && `workflow-node-${serviceId}`, selected && "selected")}>
    {node.type !== "input" && <Handle type="target" position={Position.Left} id="input" className="workflow-handle" />}
    <span className="workflow-node-icon"><Icon size={20} /></span><span><strong>{nodeTitle(node)}</strong><small>{detail}</small></span>
    {ports.map((port, index) => <Handle key={port} type="source" position={Position.Right} id={port} className="workflow-handle" style={ports.length > 1 ? { top: `${((index + 1) / (ports.length + 1)) * 100}%` } : undefined} />)}
    {ports.length > 1 && <span className="workflow-port-labels">{ports.map((port) => <i key={port}>{port}</i>)}</span>}
  </div>;
}

const nodeTypes = { workflow: CanvasWorkflowNode };

export function WorkflowEditorPage() {
  const { workflowId = "" } = useParams();
  const [definition, setDefinition] = useState<WorkflowDefinition>();
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [validation, setValidation] = useState<WorkflowValidationResult>();
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [instance, setInstance] = useState<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [runOpen, setRunOpen] = useState(false);
  const [mobilePalette, setMobilePalette] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setSelectedNodeIds([]);
    Promise.all([api.workflow(workflowId), api.workflowNodes()])
      .then(([item, catalog]) => { setDefinition(item); setServices(catalog.services as ServiceCatalogItem[]); return api.validateWorkflow(item); })
      .then(setValidation)
      .catch((value) => setError(value instanceof Error ? value.message : String(value)));
  }, [workflowId]);
  useEffect(() => {
    if (!definition) return;
    const timer = window.setTimeout(() => { api.validateWorkflow(definition).then(setValidation).catch(() => undefined); }, 450);
    return () => window.clearTimeout(timer);
  }, [definition]);

  const modelInputs = useMemo(() => services.find((service) => service.id === "llm-prompt")?.accepts.some((kind) => ["source-image", "generated-image", "grounded-image"].includes(kind)) ? ["text", "image"] as const : ["text"] as const, [services]);
  const canvasNodes = useMemo<CanvasNode[]>(() => {
    const selected = new Set(selectedNodeIds);
    return (definition?.nodes || []).map((node) => ({ id: node.id, type: "workflow", position: node.position, measured: { width: 200, height: 72 }, data: { workflowNode: node }, selected: selected.has(node.id) }));
  }, [definition, selectedNodeIds]);
  const canvasEdges = useMemo<Edge[]>(() => (definition?.edges || []).map((edge) => ({ id: edge.id, source: edge.from.nodeId, sourceHandle: edge.from.portId, target: edge.to.nodeId, targetHandle: edge.to.portId, label: edge.artifactKinds.length > 2 ? `${edge.artifactKinds.length} types` : edge.artifactKinds.map((kind) => kind.replace(/^source-/, "")).join(", "), type: "smoothstep" })), [definition]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    if (changes.some((change) => change.type === "select" || change.type === "remove")) {
      setSelectedNodeIds((current) => {
        const selected = new Set(current);
        for (const change of changes) {
          if (change.type === "select") change.selected ? selected.add(change.id) : selected.delete(change.id);
          if (change.type === "remove") selected.delete(change.id);
        }
        return [...selected];
      });
    }
    setDefinition((current) => {
      if (!current) return current;
      let nodes = current.nodes;
      let edges = current.edges;
      for (const change of changes) {
        if (change.type === "position" && change.position) nodes = nodes.map((node) => node.id === change.id ? { ...node, position: change.position! } : node);
        if (change.type === "remove") { nodes = nodes.filter((node) => node.id !== change.id); edges = edges.filter((edge) => edge.from.nodeId !== change.id && edge.to.nodeId !== change.id); }
      }
      return { ...current, nodes, edges };
    });
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => setDefinition((current) => current ? { ...current, edges: current.edges.filter((edge) => !changes.some((change) => change.type === "remove" && change.id === edge.id)) } : current), []);
  const isValidConnection = useCallback((connection: Edge | Connection) => {
    if (!definition || !connection.source || !connection.target || connection.source === connection.target) return false;
    const source = definition.nodes.find((node) => node.id === connection.source);
    const target = definition.nodes.find((node) => node.id === connection.target);
    return Boolean(source && target && compatibleArtifactKinds(source, target, definition, modelInputs).length);
  }, [definition, modelInputs]);
  const onConnect = useCallback((connection: Connection) => {
    setDefinition((current) => {
      if (!current || !connection.source || !connection.target) return current;
      const source = current.nodes.find((node) => node.id === connection.source);
      const target = current.nodes.find((node) => node.id === connection.target);
      if (!source || !target) return current;
      const kinds = compatibleArtifactKinds(source, target, current, modelInputs);
      if (!kinds.length) return current;
      const edge = { id: `edge-${Date.now().toString(36)}`, from: { nodeId: source.id, portId: connection.sourceHandle || "output" }, to: { nodeId: target.id, portId: connection.targetHandle || "input" }, artifactKinds: kinds };
      return { ...current, edges: [...current.edges.filter((candidate) => !(candidate.from.nodeId === source.id && candidate.from.portId === edge.from.portId && candidate.to.nodeId === target.id)), edge] };
    });
  }, [modelInputs]);

  function defaultConfig(type: WorkflowNodeType, serviceId?: WorkflowServiceId): Record<string, unknown> {
    if (type === "input") return { accepts: ["source-image", "source-pdf", "source-audio", "source-video", "text"], multiple: true, maximumFiles: 20 };
    if (type === "module") {
      const params = serviceId === "translation" ? { sourceLanguage: "auto-detect", targetLanguage: "Traditional Chinese" }
        : serviceId === "grounding" ? { queries: ["object to find"] }
          : serviceId === "text-to-image" ? { prompt: "", size: "1024x1024" }
            : serviceId === "llm-prompt" ? { prompt: "Summarize the supplied material into clear Markdown.", temperature: 0.2, maxTokens: 8192 }
              : {};
      return { moduleId: serviceId, workflowId: serviceId === "llm-prompt" ? "llm.prompt" : "auto", params };
    }
    if (type === "select") return { kinds: ["document", "transcript", "translation", "generated-image", "grounded-image"] };
    if (type === "if") return { predicate: { fact: "artifact.kind", operator: "equal", value: "document" } };
    if (type === "switch") return { cases: [{ id: "documents", label: "Documents", predicate: { fact: "artifact.kind", operator: "equal", value: "document" } }] };
    if (type === "merge") return { mode: "all" };
    if (type === "end") return { result: "incoming-artifacts" };
    if (type === "fail") return { message: "Workflow stopped because this condition was not met." };
    return {};
  }

  function addNode(type: WorkflowNodeType, serviceId?: WorkflowServiceId, position?: { x: number; y: number }) {
    setDefinition((current) => {
      if (!current || (type === "input" && current.nodes.some((node) => node.type === "input"))) return current;
      const id = `${serviceId || type}-${Date.now().toString(36)}`;
      const node: WorkflowNode = { id, type, position: position || { x: 140 + current.nodes.length * 32, y: 160 + current.nodes.length * 22 }, config: defaultConfig(type, serviceId) };
      setSelectedNodeIds([id]);
      return { ...current, nodes: [...current.nodes, node] };
    });
    setMobilePalette(false);
  }

  function onPaletteDrag(event: DragEvent, type: WorkflowNodeType, serviceId?: WorkflowServiceId) {
    event.dataTransfer.setData("application/sparklingkit-node", JSON.stringify({ type, serviceId }));
    event.dataTransfer.effectAllowed = "move";
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/sparklingkit-node");
    if (!raw || !instance) return;
    const item = JSON.parse(raw) as { type: WorkflowNodeType; serviceId?: WorkflowServiceId };
    addNode(item.type, item.serviceId, instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  async function save() {
    if (!definition || saving) return;
    setSaving(true); setError("");
    try {
      const result = await api.saveWorkflow(definition);
      setDefinition(result.definition); setValidation(result.validation);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      try { setValidation(await api.validateWorkflow(definition)); } catch { /* Keep the original save error. */ }
    } finally { setSaving(false); }
  }
  async function removeWorkflow() {
    if (!definition || !window.confirm(`Delete “${definition.name}”? Existing run snapshots will remain with their jobs.`)) return;
    await api.deleteWorkflow(definition.id);
    navigate("/workflows");
  }

  function arrangeSelected(mode: "align-left" | "align-top" | "row" | "column") {
    setDefinition((current) => {
      if (!current || selectedNodeIds.length < 2) return current;
      const selected = current.nodes.filter((node) => selectedNodeIds.includes(node.id));
      const left = Math.min(...selected.map((node) => node.position.x));
      const top = Math.min(...selected.map((node) => node.position.y));
      const ordered = [...selected].sort((a, b) => mode === "column"
        ? a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id)
        : a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id));
      const positions = new Map(ordered.map((node, index) => [node.id, mode === "row"
        ? { x: left + index * 264, y: top }
        : mode === "column" ? { x: left, y: top + index * 120 }
          : mode === "align-left" ? { x: left, y: node.position.y }
            : { x: node.position.x, y: top }]));
      return { ...current, nodes: current.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node) };
    });
  }

  function deleteSelectedNodes() {
    if (!definition || selectedNodeIds.length < 2) return;
    const selected = new Set(selectedNodeIds);
    setDefinition({ ...definition, nodes: definition.nodes.filter((node) => !selected.has(node.id)), edges: definition.edges.filter((edge) => !selected.has(edge.from.nodeId) && !selected.has(edge.to.nodeId)) });
    setSelectedNodeIds([]);
  }

  if (!definition && !error) return <div className="workflow-editor-loading"><div className="skeleton h-full" /></div>;
  if (!definition) return <Navigate to="/workflows" replace />;
  const selectedNodes = definition.nodes.filter((node) => selectedNodeIds.includes(node.id));
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  return <div className="workflow-editor-page">
    <header className="workflow-editor-header"><div className="workflow-name-fields"><input value={definition.name} onChange={(event) => setDefinition({ ...definition, name: event.target.value })} aria-label="Workflow name" /><input value={definition.description} onChange={(event) => setDefinition({ ...definition, description: event.target.value })} placeholder="Optional description" aria-label="Workflow description" /></div><div className="workflow-editor-actions"><label className="workflow-enable"><input type="checkbox" checked={definition.enabled} onChange={(event) => setDefinition({ ...definition, enabled: event.target.checked })} /><span />Enabled</label><button className="button-secondary workflow-mobile-add" onClick={() => setMobilePalette((value) => !value)}><Plus size={17} />Node</button><button className="button-secondary" onClick={() => void save()} disabled={saving}><Save size={17} />{saving ? "Saving…" : "Save"}</button><button className="button-primary" onClick={() => setRunOpen(true)} disabled={!validation?.valid}><Play size={17} />Run</button></div></header>
    {error && <div className="workflow-editor-error">{error}</div>}
    {validation && !validation.valid && <div className="workflow-validation-bar"><strong>{validation.issues.filter((issue) => issue.level === "error").length} things to fix</strong><span>{validation.issues.find((issue) => issue.level === "error")?.message}</span></div>}
    <div className="workflow-editor-body">
      <NodePalette definition={definition} services={services} open={mobilePalette} onClose={() => setMobilePalette(false)} onAdd={addNode} onDrag={onPaletteDrag} />
      <main className="workflow-canvas" onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}>
        <ReactFlow<CanvasNode, Edge> nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes} onInit={setInstance} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection} onPaneClick={() => setSelectedNodeIds([])} defaultViewport={definition.ui.viewport} onMoveEnd={(_event, viewport) => setDefinition((current) => current ? { ...current, ui: { viewport } } : current)} minZoom={0.25} maxZoom={1.8} deleteKeyCode={["Backspace", "Delete"]} selectionOnDrag selectionMode={SelectionMode.Partial} panOnDrag={false} panActivationKeyCode="Space" multiSelectionKeyCode={["Meta", "Control", "Shift"]} colorMode="dark">
          <Background color="#343a43" gap={22} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="#7b838e" maskColor="rgba(6,7,9,.72)" />
        </ReactFlow>
        <div className="workflow-canvas-hint"><span>Drag to select</span><i /><kbd>Space</kbd><span>+ drag to pan</span></div>
        <div className="workflow-mobile-outline">{definition.nodes.map((node, index) => <button key={node.id} onClick={() => setSelectedNodeIds([node.id])} className={selectedNodeIds.includes(node.id) ? "active" : ""}><i>{index + 1}</i><span><strong>{nodeTitle(node)}</strong><small>{node.type}</small></span><ChevronRight size={17} /></button>)}</div>
      </main>
      {selectedNodes.length > 1
        ? <MultiNodeInspector count={selectedNodes.length} onArrange={arrangeSelected} onDelete={deleteSelectedNodes} />
        : <NodeInspector node={selectedNode} definition={definition} onChange={(node) => setDefinition({ ...definition, nodes: definition.nodes.map((candidate) => candidate.id === node.id ? node : candidate) })} onDelete={(node) => { setDefinition({ ...definition, nodes: definition.nodes.filter((candidate) => candidate.id !== node.id), edges: definition.edges.filter((edge) => edge.from.nodeId !== node.id && edge.to.nodeId !== node.id) }); setSelectedNodeIds([]); }} onDeleteWorkflow={() => void removeWorkflow()} />}
    </div>
    {runOpen && <RunWorkflowDialog definition={definition} onClose={() => setRunOpen(false)} />}
  </div>;
}

function MultiNodeInspector({ count, onArrange, onDelete }: { count: number; onArrange: (mode: "align-left" | "align-top" | "row" | "column") => void; onDelete: () => void }) {
  return <aside className="workflow-inspector workflow-multi-inspector"><header><span>{count} nodes selected</span><small>Drag any selected node to move the group</small></header><div className="workflow-inspector-scroll"><InspectorSection title="Arrange"><div className="workflow-arrange-grid"><button onClick={() => onArrange("align-left")}>Align left</button><button onClick={() => onArrange("align-top")}>Align top</button><button onClick={() => onArrange("row")}>Tidy row</button><button onClick={() => onArrange("column")}>Tidy column</button></div></InspectorSection><p className="workflow-inspector-note">Hold Shift, Command, or Control while clicking to add or remove individual nodes from this selection.</p></div><button className="workflow-delete-link" onClick={onDelete}><Trash2 size={16} />Delete {count} nodes</button></aside>;
}

function NodePalette({ definition, services, open, onClose, onAdd, onDrag }: { definition: WorkflowDefinition; services: ServiceCatalogItem[]; open: boolean; onClose: () => void; onAdd: (type: WorkflowNodeType, serviceId?: WorkflowServiceId) => void; onDrag: (event: DragEvent, type: WorkflowNodeType, serviceId?: WorkflowServiceId) => void }) {
  return <aside className={cn("workflow-palette", open && "open")}><header><strong>Nodes</strong><button onClick={onClose} aria-label="Close node palette"><X size={18} /></button></header><section><h2>Services</h2>{services.map((service) => { const Icon = serviceIcons[service.id]; return <button draggable onDragStart={(event) => onDrag(event, "module", service.id)} onClick={() => onAdd("module", service.id)} key={service.id}><Icon size={18} /><span><strong>{service.title}</strong><small>{service.configured ? "Ready" : "Not configured"}</small></span><i className={service.configured ? "online" : ""} /></button>; })}</section><section><h2>Logic</h2>{genericNodes.map((item) => <button draggable={item.type !== "input" || !definition.nodes.some((node) => node.type === "input")} disabled={item.type === "input" && definition.nodes.some((node) => node.type === "input")} onDragStart={(event) => onDrag(event, item.type)} onClick={() => onAdd(item.type)} key={item.type}><item.icon size={18} /><span><strong>{item.title}</strong><small>{item.type === "input" ? "One per workflow" : item.type === "end" || item.type === "fail" ? "Terminal" : "Routing"}</small></span></button>)}</section></aside>;
}

function NodeInspector({ node, definition, onChange, onDelete, onDeleteWorkflow }: { node?: WorkflowNode; definition: WorkflowDefinition; onChange: (node: WorkflowNode) => void; onDelete: (node: WorkflowNode) => void; onDeleteWorkflow: () => void }) {
  if (!node) return <aside className="workflow-inspector workflow-inspector-empty"><GitBranch size={25} /><strong>Workflow settings</strong><p>Select a node to configure it, or drag a handle to connect compatible types.</p><div><span>JSON file</span><code>{definition.id}.json</code></div><button className="workflow-delete-link" onClick={onDeleteWorkflow}><Trash2 size={16} />Delete workflow</button></aside>;
  const config = node.config;
  const params = config.params && typeof config.params === "object" ? config.params as Record<string, unknown> : {};
  const updateConfig = (patch: Record<string, unknown>) => onChange({ ...node, config: { ...config, ...patch } });
  const updateParams = (patch: Record<string, unknown>) => updateConfig({ params: { ...params, ...patch } });
  const predicate = config.predicate && typeof config.predicate === "object" ? config.predicate as Record<string, unknown> : { fact: "artifact.kind", operator: "equal", value: "document" };
  const serviceId = node.type === "module" ? config.moduleId as WorkflowServiceId : undefined;
  return <aside className="workflow-inspector"><header><span>{nodeTitle(node)}</span><small>{node.id}</small></header><div className="workflow-inspector-scroll">
    {node.type === "input" && <><InspectorSection title="Accepted inputs"><ArtifactChecks selected={Array.isArray(config.accepts) ? config.accepts as ArtifactKind[] : []} onChange={(accepts) => updateConfig({ accepts })} /></InspectorSection><InspectorSection title="Selection"><label>Maximum files<input className="input" type="number" min={1} max={100} value={Number(config.maximumFiles || 20)} onChange={(event) => updateConfig({ maximumFiles: Number(event.target.value) })} /></label><label className="workflow-check-row"><input type="checkbox" checked={config.multiple !== false} onChange={(event) => updateConfig({ multiple: event.target.checked })} />Allow multiple files</label></InspectorSection></>}
    {node.type === "select" && <InspectorSection title="Keep these results"><ArtifactChecks selected={Array.isArray(config.kinds) ? config.kinds as ArtifactKind[] : []} onChange={(kinds) => updateConfig({ kinds })} /></InspectorSection>}
    {node.type === "module" && <InspectorSection title="Service settings">
      {serviceId === "translation" && <><label>Source language<input className="input" value={String(params.sourceLanguage || "auto-detect")} onChange={(event) => updateParams({ sourceLanguage: event.target.value })} /></label><label>Target language<input className="input" value={String(params.targetLanguage || "")} onChange={(event) => updateParams({ targetLanguage: event.target.value })} /></label></>}
      {serviceId === "grounding" && <label>Queries<textarea className="input" rows={6} value={Array.isArray(params.queries) ? params.queries.join("\n") : ""} onChange={(event) => updateParams({ queries: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, 12) })} placeholder="One thing per line" /></label>}
      {serviceId === "text-to-image" && <><label>Prompt<textarea className="input" rows={5} value={String(params.prompt || "")} onChange={(event) => updateParams({ prompt: event.target.value })} placeholder="Leave blank to use incoming text" /></label><label>Canvas<SearchSelect className="workflow-inspector-select" value={String(params.size || "1024x1024")} onChange={(size) => updateParams({ size })} options={[{ value: "1024x1024", label: "Square" }, { value: "1536x1024", label: "Landscape" }, { value: "1024x1536", label: "Portrait" }]} searchPlaceholder="Search canvas sizes" ariaLabel="Canvas size" /></label></>}
      {serviceId === "llm-prompt" && <><label>Instruction<textarea className="input" rows={6} value={String(params.prompt || "")} onChange={(event) => updateParams({ prompt: event.target.value })} /></label><label>System instruction<textarea className="input" rows={4} value={String(params.systemPrompt || "")} onChange={(event) => updateParams({ systemPrompt: event.target.value })} placeholder="Optional" /></label><label>Temperature<input className="input" type="number" min={0} max={2} step={0.1} value={Number(params.temperature ?? 0.2)} onChange={(event) => updateParams({ temperature: Number(event.target.value) })} /></label></>}
      {!["translation", "grounding", "text-to-image", "llm-prompt"].includes(serviceId || "") && <p className="workflow-inspector-note">This node uses the service defaults from Settings.</p>}
    </InspectorSection>}
    {node.type === "if" && <InspectorSection title="Condition"><PredicateEditor value={predicate} onChange={(value) => updateConfig({ predicate: value })} /></InspectorSection>}
    {node.type === "switch" && <InspectorSection title="Cases"><SwitchEditor cases={Array.isArray(config.cases) ? config.cases as Array<Record<string, unknown>> : []} onChange={(cases) => updateConfig({ cases })} /></InspectorSection>}
    {node.type === "merge" && <InspectorSection title="Wait policy"><label>Continue when<SearchSelect className="workflow-inspector-select" value={String(config.mode || "all")} onChange={(mode) => updateConfig({ mode })} options={[{ value: "all", label: "All active branches finish" }, { value: "any", label: "Any branch finishes" }]} searchPlaceholder="Search wait policies" ariaLabel="Merge wait policy" /></label></InspectorSection>}
    {node.type === "fail" && <InspectorSection title="Failure"><label>Message<textarea className="input" rows={4} value={String(config.message || "")} onChange={(event) => updateConfig({ message: event.target.value })} /></label></InspectorSection>}
    {node.type === "end" && <div className="workflow-inspector-note">Every incoming artifact becomes a final workflow result.</div>}
  </div>{node.type !== "input" && <button className="workflow-delete-link" onClick={() => onDelete(node)}><Trash2 size={16} />Delete node</button>}</aside>;
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="workflow-inspector-section"><h3>{title}</h3>{children}</section>;
}

function ArtifactChecks({ selected, onChange }: { selected: ArtifactKind[]; onChange: (values: ArtifactKind[]) => void }) {
  return <div className="artifact-checks">{ARTIFACT_KINDS.map((kind) => <label key={kind}><input type="checkbox" checked={selected.includes(kind)} onChange={(event) => onChange(event.target.checked ? [...selected, kind] : selected.filter((item) => item !== kind))} /><span>{kind.replaceAll("-", " ")}</span></label>)}</div>;
}

function PredicateEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  return <div className="predicate-editor"><label>Fact<SearchSelect className="workflow-inspector-select" value={String(value.fact || "artifact.kind")} onChange={(fact) => onChange({ ...value, fact })} options={[{ value: "artifact.kind", label: "Artifact type" }, { value: "artifact.mimeType", label: "MIME type" }, { value: "artifact.role", label: "Artifact role" }, { value: "input.fileCount", label: "File count" }]} searchPlaceholder="Search facts" ariaLabel="Condition fact" /></label><label>Operator<SearchSelect className="workflow-inspector-select" value={String(value.operator || "equal")} onChange={(operator) => onChange({ ...value, operator })} options={[{ value: "equal", label: "Equals" }, { value: "notEqual", label: "Does not equal" }, { value: "contains", label: "Contains" }, { value: "exists", label: "Exists" }, { value: "greaterThan", label: "Greater than" }, { value: "lessThan", label: "Less than" }]} searchPlaceholder="Search operators" ariaLabel="Condition operator" /></label><label>Value<input className="input" value={String(value.value ?? "")} onChange={(event) => onChange({ ...value, value: value.fact === "input.fileCount" ? Number(event.target.value) : event.target.value })} /></label></div>;
}

function SwitchEditor({ cases, onChange }: { cases: Array<Record<string, unknown>>; onChange: (cases: Array<Record<string, unknown>>) => void }) {
  return <div className="switch-editor">{cases.map((item, index) => { const predicate = item.predicate as Record<string, unknown> | undefined; return <div key={String(item.id)}><SearchSelect className="workflow-inspector-select" value={String(predicate?.value || "document")} onChange={(kind) => onChange(cases.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, id: kind, label: kind, predicate: { fact: "artifact.kind", operator: "equal", value: kind } } : candidate))} options={ARTIFACT_KINDS.map((kind) => ({ value: kind, label: kind.replaceAll("-", " ") }))} searchPlaceholder="Search artifact types" ariaLabel="Switch artifact type" /><button onClick={() => onChange(cases.filter((_, candidateIndex) => candidateIndex !== index))} aria-label="Remove case"><X size={15} /></button></div>; })}<button className="button-secondary" onClick={() => { const kind = ARTIFACT_KINDS.find((candidate) => !cases.some((item) => (item.predicate as Record<string, unknown>)?.value === candidate)) || "text"; onChange([...cases, { id: kind, label: kind, predicate: { fact: "artifact.kind", operator: "equal", value: kind } }]); }}><Plus size={15} />Add case</button><small>An unmatched artifact follows the default port.</small></div>;
}

function RunWorkflowDialog({ definition, onClose }: { definition: WorkflowDefinition; onClose: () => void }) {
  const inputNode = definition.nodes.find((node) => node.type === "input")!;
  const accepts = Array.isArray(inputNode.config.accepts) ? inputNode.config.accepts as ArtifactKind[] : [];
  const textAccepted = accepts.includes("text");
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const fileAccept = [accepts.includes("source-image") && "image/*", accepts.includes("source-pdf") && "application/pdf", accepts.some((kind) => kind === "source-audio" || kind === "source-video") && "audio/*,video/*", textAccepted && ".txt,.md,.markdown,.html,.htm"].filter(Boolean).join(",");
  async function run() {
    if (!files.length && !text.trim()) return;
    setRunning(true); setError("");
    try {
      const result = await startWorkflow(definition.id, files.length ? { files } : { text: text.trim() }, setProgress);
      navigate(`/jobs/${result.job.id}`);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); setRunning(false); }
  }
  return <div className="workflow-run-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="workflow-run-dialog" role="dialog" aria-modal="true" aria-labelledby="run-workflow-title"><header><div><h2 id="run-workflow-title">Run {definition.name}</h2><p>Add the input this workflow should process.</p></div><button onClick={onClose} aria-label="Close"><X size={20} /></button></header><div className="workflow-run-content"><label className="workflow-file-input"><Upload size={25} /><span><strong>{files.length ? files.length === 1 ? files[0].name : `${files.length} files selected` : "Choose files"}</strong><small>{accepts.map((kind) => kind.replace("source-", "")).join(", ")}</small></span><input type="file" accept={fileAccept} multiple={inputNode.config.multiple !== false} onChange={(event) => { setFiles([...event.target.files || []]); if (event.target.files?.length) setText(""); }} /></label>{textAccepted && <><div className="workflow-run-or"><span>or enter text</span></div><textarea className="input" rows={7} value={text} onChange={(event) => { setText(event.target.value); if (event.target.value) setFiles([]); }} placeholder="Paste text for the workflow…" /></>}{error && <div className="error-card">{error}</div>}{running && <div className="progress-track"><span className="progress-fill" style={{ width: `${progress}%` }} /></div>}</div><footer><button className="button-secondary" onClick={onClose}>Cancel</button><button className="button-primary" onClick={() => void run()} disabled={running || (!files.length && !text.trim())}>{running ? `Starting ${progress}%` : <><Play size={17} />Run workflow</>}</button></footer></section></div>;
}
