import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "./contracts.js";
import { createStarterWorkflow, validateWorkflowDefinition, workflowAcceptsArtifact, workflowInputKinds } from "./workflows.js";

describe("workflow definition validation", () => {
  it("accepts the typed starter workflow", () => {
    const workflow = createStarterWorkflow();
    expect(validateWorkflowDefinition(workflow).valid).toBe(true);
    expect(workflowInputKinds(workflow)).toEqual(["source-image", "source-pdf"]);
    expect(workflowAcceptsArtifact(workflow, "source-pdf")).toBe(true);
    expect(workflowAcceptsArtifact(workflow, "transcript")).toBe(false);
  });

  it("rejects incompatible connections and cycles", () => {
    const workflow = createStarterWorkflow();
    workflow.edges[0].artifactKinds = ["source-audio"];
    workflow.edges.push({ id: "cycle", from: { nodeId: "ocr", portId: "output" }, to: { nodeId: "ocr", portId: "input" }, artifactKinds: ["document"] });
    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("artifact-kinds");
    expect(result.issues.map((issue) => issue.code)).toContain("cycle");
  });

  it("requires every branch to be explicit", () => {
    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      id: "branch-test",
      revision: 1,
      name: "Branch test",
      description: "",
      enabled: false,
      createdAt: now,
      updatedAt: now,
      ui: { viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        { id: "input", type: "input", position: { x: 0, y: 0 }, config: { accepts: ["text"] } },
        { id: "condition", type: "if", position: { x: 100, y: 0 }, config: { predicate: { fact: "artifact.kind", operator: "equal", value: "text" } } },
        { id: "end", type: "end", position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [
        { id: "one", from: { nodeId: "input", portId: "files" }, to: { nodeId: "condition", portId: "input" }, artifactKinds: ["text"] },
        { id: "two", from: { nodeId: "condition", portId: "true" }, to: { nodeId: "end", portId: "input" }, artifactKinds: ["text"] },
      ],
    };
    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "branch-output", nodeId: "condition" }));
  });
});
