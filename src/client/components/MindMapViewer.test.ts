import { describe, expect, it, vi } from "vitest";
import { layoutMindMap, mindMapColumnX, parseMindMap, type MindMapDocument } from "./MindMapViewer";

const document: MindMapDocument = {
  version: 1,
  title: "Launch plan",
  root: {
    id: "root",
    label: "Launch plan",
    children: [
      { id: "product", label: "Product", children: [{ id: "scope", label: "Scope", children: [] }] },
      { id: "market", label: "Market", children: [] },
    ],
  },
};

describe("interactive mind map", () => {
  it("parses the durable schema and lays out every visible branch", () => {
    expect(parseMindMap(JSON.stringify(document))?.title).toBe("Launch plan");
    const graph = layoutMindMap(document, new Set(), vi.fn());
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["market", "product", "root", "scope"]);
    expect(graph.edges).toHaveLength(3);
  });

  it("removes collapsed descendants from the interactive graph", () => {
    const graph = layoutMindMap(document, new Set(["product"]), vi.fn());
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["market", "product", "root"]);
    expect(graph.edges).toHaveLength(2);
    expect(parseMindMap("not json")).toBeUndefined();
  });

  it("leaves a routing gutter between each node column", () => {
    expect(mindMapColumnX(0)).toBe(0);
    expect(mindMapColumnX(1) - 270).toBeGreaterThanOrEqual(90);
    expect(mindMapColumnX(2) - mindMapColumnX(1) - 250).toBeGreaterThanOrEqual(90);
  });
});
