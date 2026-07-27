import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownText({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => Promise<void> }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void onOpenUrl(href); }}>{children}</a>,
  }}>{text}</ReactMarkdown>;
}
