import { useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight, Maximize2, Network } from "lucide-react";
import { cn } from "./ui";

export interface MindMapTreeNode {
  id: string;
  label: string;
  note?: string;
  children: MindMapTreeNode[];
}

export interface MindMapDocument {
  version: 1;
  title: string;
  generatedAt?: string;
  root: MindMapTreeNode;
}

type MindMapCanvasNode = Node<{
  item: MindMapTreeNode;
  depth: number;
  collapsed: boolean;
  hasChildren: boolean;
  onToggle: (id: string) => void;
}, "mindmap">;

function isTreeNode(value: unknown): value is MindMapTreeNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return typeof node.id === "string" && typeof node.label === "string" && Array.isArray(node.children) && node.children.every(isTreeNode);
}

export function parseMindMap(content: string): MindMapDocument | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value.version !== 1 || typeof value.title !== "string" || !isTreeNode(value.root)) return undefined;
    return value as unknown as MindMapDocument;
  } catch {
    return undefined;
  }
}

function branchIds(root: MindMapTreeNode) {
  const ids: string[] = [];
  const visit = (node: MindMapTreeNode) => {
    if (node.children.length) ids.push(node.id);
    node.children.forEach(visit);
  };
  visit(root);
  return ids;
}

export function layoutMindMap(document: MindMapDocument, collapsed: ReadonlySet<string>, onToggle: (id: string) => void) {
  const nodes: MindMapCanvasNode[] = [];
  const edges: Edge[] = [];
  let row = 0;
  const visit = (item: MindMapTreeNode, depth: number): number => {
    const visibleChildren = collapsed.has(item.id) ? [] : item.children;
    const childPositions = visibleChildren.map((child) => {
      const y = visit(child, depth + 1);
      edges.push({
        id: `${item.id}-${child.id}`,
        source: item.id,
        target: child.id,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#56616c" },
        style: { stroke: depth === 0 ? "#77c8b4" : "#56616c", strokeWidth: depth === 0 ? 2.2 : 1.7 },
      });
      return y;
    });
    const y = childPositions.length ? childPositions.reduce((sum, value) => sum + value, 0) / childPositions.length : row++ * 132;
    nodes.push({
      id: item.id,
      type: "mindmap",
      position: { x: depth * 310, y },
      data: { item, depth, collapsed: collapsed.has(item.id), hasChildren: item.children.length > 0, onToggle },
      draggable: false,
      selectable: true,
    });
    return y;
  };
  visit(document.root, 0);
  return { nodes, edges };
}

function MindMapNode({ data }: NodeProps<MindMapCanvasNode>) {
  const { item, depth, collapsed, hasChildren, onToggle } = data;
  return <article className={cn("mindmap-node", depth === 0 && "root")}>
    {depth > 0 && <Handle type="target" position={Position.Left} isConnectable={false} />}
    <span className="mindmap-node-icon"><Network size={18} /></span>
    <span className="mindmap-node-copy"><strong>{item.label}</strong>{item.note && <small>{item.note}</small>}</span>
    {hasChildren && <button type="button" className="nodrag nopan" onClick={() => onToggle(item.id)} aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.label}`} title={collapsed ? `Show ${item.children.length} branches` : "Collapse branches"}>{collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}<i>{item.children.length}</i></button>}
    {hasChildren && !collapsed && <Handle type="source" position={Position.Right} isConnectable={false} />}
  </article>;
}

const nodeTypes = { mindmap: MindMapNode };

export function MindMapViewer({ document }: { document: MindMapDocument }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(branchIds(document.root).filter((id) => id !== document.root.id)));
  const branches = useMemo(() => branchIds(document.root), [document]);
  const onToggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const graph = useMemo(() => layoutMindMap(document, collapsed, onToggle), [document, collapsed]);
  const hasCollapsedBranches = collapsed.size > 0;
  return <section className="mindmap-viewer">
    <header><div><span className="mindmap-viewer-icon"><Network size={20} /></span><span><strong>{document.title}</strong><small>{graph.nodes.length} visible nodes · click a branch to expand or collapse it</small></span></div><button type="button" onClick={() => setCollapsed(hasCollapsedBranches ? new Set() : new Set(branches))}><Maximize2 size={16} />{hasCollapsedBranches ? "Expand all" : "Collapse all"}</button></header>
    <div className="mindmap-canvas">
      <ReactFlow<MindMapCanvasNode, Edge> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.22, minZoom: 0.35, maxZoom: 1 }} minZoom={0.15} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} colorMode="dark">
        <Background color="#303640" gap={24} size={1} /><Controls showInteractive={false} />
      </ReactFlow>
      <span className="mindmap-canvas-hint">Drag to explore · Pinch or scroll to zoom</span>
    </div>
  </section>;
}
