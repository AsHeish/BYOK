import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { FullPageDocument } from "../shared/types";

const MAX_DOCUMENT_MARKDOWN_CHARS = 60_000;
const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

turndown.remove([
  "script",
  "style",
  "noscript",
  "template",
  "input",
  "textarea",
  "select",
  "button",
  "canvas",
  "video",
  "audio",
  "source",
]);

turndown.addRule("stripMedia", {
  filter: (node) => ["svg", "picture", "img"].includes(node.nodeName.toLowerCase()),
  replacement: () => "",
});

export function readFullPageDocument(): FullPageDocument {
  const documentClone = document.cloneNode(true) as Document;
  const article = new Readability(documentClone, {
    charThreshold: 80,
  }).parse();
  const rawMarkdown = article?.content
    ? turndown.turndown(article.content).trim()
    : fallbackDocumentText(documentClone);
  const sourceCharacters = rawMarkdown.length;

  return {
    url: location.href,
    title: article?.title?.trim() || document.title,
    byline: optionalText(article?.byline),
    excerpt: optionalText(article?.excerpt),
    markdown: rawMarkdown.slice(0, MAX_DOCUMENT_MARKDOWN_CHARS),
    sourceCharacters,
    truncated: sourceCharacters > MAX_DOCUMENT_MARKDOWN_CHARS,
  };
}

function fallbackDocumentText(source: Document): string {
  const body = source.body;
  if (!body) {
    return "";
  }

  for (const element of Array.from(body.querySelectorAll("script,style,noscript,template,input,textarea,select,button,svg,canvas,video,audio,source"))) {
    element.remove();
  }
  return (body.textContent || "").replace(/\s+/g, " ").trim();
}

function optionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}
