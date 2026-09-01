import { describe, expect, it } from "vitest";
import { compatibleModuleContracts, getModuleContract, moduleHandoffUrl, moduleWorkflowForArtifact, nextModuleActions } from "./module-router.js";

describe("module artifact router", () => {
  it("routes generated images into every compatible image workflow", () => {
    expect(compatibleModuleContracts("generated-image", "text-to-image").map((contract) => contract.id)).toEqual(["ocr", "grounding"]);
    expect(compatibleModuleContracts("generated-image", "text-to-image", ["text", "image"]).map((contract) => contract.id)).toEqual(["ocr", "grounding", "mindmap", "chat"]);
    expect(moduleWorkflowForArtifact("ocr", "generated-image")).toBe("ocr.images");
    expect(moduleWorkflowForArtifact("grounding", "generated-image")).toBe("grounding.image");
  });

  it("routes text results into translation, image generation, mind maps, and chat", () => {
    expect(compatibleModuleContracts("document", "ocr").map((contract) => contract.id)).toEqual(["translation", "text-to-image", "mindmap", "chat"]);
    expect(moduleWorkflowForArtifact("translation", "document")).toBe("translation.default");
    expect(moduleWorkflowForArtifact("text-to-image", "document")).toBe("text-to-image.default");
    expect(moduleWorkflowForArtifact("mindmap", "document")).toBe("mindmap.default");
  });

  it("derives outgoing actions and handoff URLs from the same contract", () => {
    const ocr = getModuleContract("ocr")!;
    expect(nextModuleActions(ocr).map((action) => action.id)).toEqual(["translation", "text-to-image", "mindmap", "chat"]);
    const imageGenerator = getModuleContract("text-to-image")!;
    expect(nextModuleActions(imageGenerator, ["text", "image"]).map((action) => action.id)).toEqual(["ocr", "grounding", "mindmap", "chat"]);
    expect(moduleHandoffUrl("grounding", "job 1", "artifact/1")).toBe("/tools/grounding?job=job+1&artifact=artifact%2F1");
  });
});
