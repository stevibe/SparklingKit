import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown, chatReferenceNames, formatMessageTime, formatMessageTimestamp } from "./ChatPage";
import type { Chat, Job } from "../types";

describe("ChatMarkdown", () => {
  it("renders rich Markdown and safe inline HTML", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{`# Heading

**Bold**, *italic*, and <u>underlined</u>.

---

| Name | Value |
| --- | --- |
| One | Two |

[OpenAI](https://openai.com)

<script>alert("unsafe")</script>`}</ChatMarkdown>);

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<u>underlined</u>");
    expect(html).toContain("<hr/>");
    expect(html).toContain('class="markdown-table-wrap"');
    expect(html).toContain('<a href="https://openai.com" target="_blank" rel="noreferrer">');
    expect(html).not.toContain("<script");
  });
});

describe("formatMessageTimestamp", () => {
  it("uses the configured timezone for both the date and time", () => {
    const timestamp = formatMessageTimestamp("2026-09-01T00:30:00.000Z", "Asia/Macau");
    expect(timestamp).toContain("Sep 1, 2026");
    expect(timestamp).toMatch(/8:30\s*AM/);
    expect(timestamp).toMatch(/GMT\+8/);
    expect(formatMessageTime("2026-09-01T00:30:00.000Z", "Asia/Macau")).toMatch(/8:30\s*AM/);
  });
});

describe("chatReferenceNames", () => {
  it("combines source files and explicitly linked image artifacts without duplicates", () => {
    const chat = { linkedArtifactIds: ["image-1"] } as Pick<Chat, "linkedArtifactIds">;
    const job = {
      inputs: [{ name: "notes.md", storedName: "notes.md", mimeType: "text/markdown", size: 12 }],
      artifacts: [
        { id: "image-1", name: "reference.png", role: "primary" },
        { id: "other", name: "ignored.json", role: "supplementary" },
      ],
    } as Job;

    expect(chatReferenceNames(chat, job)).toEqual(["notes.md", "reference.png"]);
  });
});
