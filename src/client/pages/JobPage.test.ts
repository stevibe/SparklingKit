import { describe, expect, it } from "vitest";
import { extractHtml, getFileKind, htmlDocument, linkedChatsForJob, markdownForPreview } from "./JobPage";
import type { Chat } from "../types";

describe("job output preview", () => {
  it("detects a complete HTML document inside a Markdown output", () => {
    expect(extractHtml("<!doctype html><html><body><h1>Receipt</h1></body></html>", "document.md")).toContain("<h1>Receipt</h1>");
  });

  it("unwraps fenced HTML from model output", () => {
    expect(extractHtml("```html\n<table><tr><td>Total</td></tr></table>\n```", "document.md")).toBe("<table><tr><td>Total</td></tr></table>");
  });

  it("does not misclassify ordinary Markdown", () => {
    expect(extractHtml("# Receipt\n\nTotal: 20", "document.md")).toBeNull();
  });

  it("keeps embedded HTML tables inside the Markdown rendering pipeline", () => {
    expect(extractHtml("# Receipt\n\n<table><tr><td>Total</td></tr></table>", "document.md")).toBeNull();
  });

  it("wraps HTML fragments in a renderable document", () => {
    const document = htmlDocument("<table><tr><td>Total</td></tr></table>");
    expect(document).toContain("<!doctype html>");
    expect(document).toContain("<table>");
    expect(document).toContain("sparklingkit-preview-theme");
  });

  it("adds the preview theme to complete HTML documents", () => {
    const document = htmlDocument("<!doctype html><html><head><title>Result</title></head><body>Done</body></html>");
    expect(document).toContain("<title>Result</title>");
    expect(document).toContain("sparklingkit-preview-theme");
  });

  it("hides internal page markers from rendered Markdown", () => {
    expect(markdownForPreview("# Result\n\n<!-- file 1; page 1 -->\n\nText")).toBe("# Result\n\nText");
  });

  it("recognizes previewable source file formats", () => {
    expect(getFileKind("source.pdf")).toBe("pdf");
    expect(getFileKind("source.png")).toBe("image");
    expect(getFileKind("recording.wav")).toBe("audio");
    expect(getFileKind("recording.mp4")).toBe("video");
  });
});

describe("job chat backlinks", () => {
  it("keeps only conversations linked to the current job", () => {
    const chats = [
      { id: "chat-a", linkedJobId: "job-a" },
      { id: "chat-b", linkedJobId: "job-b" },
      { id: "chat-c", linkedJobId: "job-a" },
    ] as Chat[];
    expect(linkedChatsForJob(chats, "job-a").map((chat) => chat.id)).toEqual(["chat-a", "chat-c"]);
  });
});
