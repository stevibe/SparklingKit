import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

describe("MarkdownRenderer", () => {
  it("renders GFM and embedded HTML as one document", () => {
    const html = renderToStaticMarkup(<MarkdownRenderer>{"# Report\n\n~~Old~~ **current**\n\n<table><tr><td colspan=\"2\">Total</td></tr></table>"}</MarkdownRenderer>);
    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain("<del>Old</del>");
    expect(html).toContain("<strong>current</strong>");
    expect(html).toContain("class=\"markdown-table-wrap\"");
    expect(html).toContain("colSpan=\"2\"");
  });

  it("removes executable HTML while preserving safe formatting", () => {
    const html = renderToStaticMarkup(<MarkdownRenderer>{"<u>Useful</u><script>alert('no')</script>"}</MarkdownRenderer>);
    expect(html).toContain("<u>Useful</u>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
  });
});
