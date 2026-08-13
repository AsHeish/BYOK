import { memo, type ReactNode } from "react";

interface MarkdownProps {
  text: string;
}

// Log messages include raw model output, so markdown is parsed into React nodes
// instead of HTML. Nothing here ever reaches dangerouslySetInnerHTML.
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return <div className="markdown">{renderBlocks(text)}</div>;
});

const FENCE = /^\s{0,3}```/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

const INLINE_PATTERN =
  /(`+)([\s\S]*?)\1|\[([^\]\n]+)\]\(([^()\s]+)\)|\*\*([\s\S]+?)\*\*|(?<![A-Za-z0-9])__([\s\S]+?)__(?![A-Za-z0-9])|~~([\s\S]+?)~~|\*([^*\n]+?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])|(https?:\/\/[^\s<>()[\]]+)/;

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={key++}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      blocks.push(<hr key={key++} />);
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push(
        <p key={key++} className={`markdown-heading level-${heading[1].length}`}>
          {renderInline(heading[2])}
        </p>
      );
      index += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const quote = BLOCKQUOTE.exec(lines[index]);
        if (!quote) {
          break;
        }
        quoted.push(quote[1]);
        index += 1;
      }
      blocks.push(<blockquote key={key++}>{renderBlocks(quoted.join("\n"))}</blockquote>);
      continue;
    }

    if (BULLET_ITEM.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = BULLET_ITEM.exec(lines[index]);
        if (!item) {
          break;
        }
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    const firstOrderedItem = ORDERED_ITEM.exec(line);
    if (firstOrderedItem) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = ORDERED_ITEM.exec(lines[index]);
        if (!item) {
          break;
        }
        items.push(item[2]);
        index += 1;
      }
      blocks.push(
        <ol key={key++} start={Number(firstOrderedItem[1])}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join("\n"))}</p>);
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    THEMATIC_BREAK.test(line) ||
    HEADING.test(line) ||
    BLOCKQUOTE.test(line) ||
    BULLET_ITEM.test(line) ||
    ORDERED_ITEM.test(line)
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE_PATTERN.source, "g");
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2] !== undefined) {
      nodes.push(<code key={key++}>{match[2].trim()}</code>);
    } else if (match[3] !== undefined && match[4] !== undefined) {
      nodes.push(renderLink(match[3], match[4], key++));
    } else if (match[5] !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(match[5])}</strong>);
    } else if (match[6] !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(match[6])}</strong>);
    } else if (match[7] !== undefined) {
      nodes.push(<del key={key++}>{renderInline(match[7])}</del>);
    } else if (match[8] !== undefined) {
      nodes.push(<em key={key++}>{renderInline(match[8])}</em>);
    } else if (match[9] !== undefined) {
      nodes.push(<em key={key++}>{renderInline(match[9])}</em>);
    } else if (match[10] !== undefined) {
      nodes.push(renderLink(match[10], match[10], key++));
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderLink(label: string, href: string, key: number): ReactNode {
  const safeHref = getSafeHref(href);
  if (!safeHref) {
    return <span key={key}>{label}</span>;
  }

  return (
    <a key={key} href={safeHref} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

function getSafeHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
