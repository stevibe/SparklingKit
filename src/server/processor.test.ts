import { describe, expect, it } from "vitest";
import { isPathologicalTranscript } from "./processor.js";

describe("ASR output guard", () => {
  it("accepts a normal transcript", () => {
    expect(isPathologicalTranscript("Welcome to the meeting. Today we will review the project plan and next steps.", 60)).toBe(false);
  });

  it("rejects output that is implausibly long for the audio window", () => {
    expect(isPathologicalTranscript("word ".repeat(500), 30)).toBe(true);
  });

  it("rejects strongly repetitive output", () => {
    expect(isPathologicalTranscript("repeated-block!".repeat(24), 120)).toBe(true);
  });
});
