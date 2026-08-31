import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatPage";

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
    expect(html).toContain('class="message-table-wrap"');
    expect(html).toContain('<a href="https://openai.com" target="_blank" rel="noreferrer">');
    expect(html).not.toContain("<script");
  });
});
