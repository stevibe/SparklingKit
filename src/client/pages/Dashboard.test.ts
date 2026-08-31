import { describe, expect, it } from "vitest";
import { compatibleFileActions } from "./Dashboard";

const file = (name: string, type = "") => ({ name, type });

describe("workbench file actions", () => {
  it("enables only workflows compatible with the complete selection", () => {
    expect(compatibleFileActions([file("meeting.m4a", "audio/mp4")])).toEqual(["transcription"]);
    expect(compatibleFileActions([file("scan-1.png", "image/png"), file("scan-2.jpg", "image/jpeg")])).toEqual(["ocr"]);
    expect(compatibleFileActions([file("report.pdf", "application/pdf")])).toEqual(["ocr"]);
    expect(compatibleFileActions([file("notes.md", "text/markdown")])).toEqual(["translation"]);
    expect(compatibleFileActions([file("page.html", "text/html")])).toEqual(["translation"]);
    expect(compatibleFileActions([file("scan.pdf", "application/pdf"), file("scan.png", "image/png")])).toEqual([]);
    expect(compatibleFileActions([file("notes.md"), file("more.md")])).toEqual([]);
    expect(compatibleFileActions([file("archive.zip", "application/zip")])).toEqual([]);
  });
});
