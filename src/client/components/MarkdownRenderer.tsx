import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) => {
    const external = Boolean(href && /^(https?:)?\/\//.test(href));
    return <a href={href} {...props} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} />;
  },
  table: ({ node: _node, ...props }) => <div className="markdown-table-wrap"><table {...props} /></div>,
};

const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "u"],
};

export function MarkdownRenderer({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]} components={markdownComponents}>{children}</ReactMarkdown>;
}
