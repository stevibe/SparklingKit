import { describe, expect, it } from "vitest";
import { userFacingOutputFiles } from "./store.js";

describe("user-facing job outputs", () => {
  it("keeps final deliverables and hides processing artifacts", () => {
    expect(userFacingOutputFiles([
      "document.md",
      "pages/001.md",
      "pages/002.md",
      "chunks/0001.json",
      "summary.executive-summary.md",
    ])).toEqual(["document.md", "summary.executive-summary.md"]);
  });
});
