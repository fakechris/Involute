import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Btn } from './Primitives';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * List contexts: show at most this many lines, with a Show more / Show less
   * toggle when the text is longer (docs/design-system.md §3 rule 8).
   */
  clamp?: number | undefined;
  /** `sm` (13px) inside cards and panels; `md` (15px, default) on the issue page. */
  size?: 'sm' | 'md' | undefined;
}

interface ParsedToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'link' | 'image' | 'br' | 'mention';
  content?: string;
  children?: ParsedToken[];
  href?: string;
  alt?: string;
  lang?: string;
}

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];

function isVideoUrl(href: string): boolean {
  const path = href.split(/[?#]/)[0]?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** The character before `@` must not make it part of another token. */
function isMentionBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text[index - 1] ?? '';
  return !/[A-Za-z0-9_@.\-/]/.test(previous);
}

function tokenizeInline(text: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Image: ![alt](url)
    const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      tokens.push({ type: 'image', alt: imgMatch[1] ?? '', href: imgMatch[2] ?? '' });
      remaining = remaining.slice(imgMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      tokens.push({ type: 'link', content: linkMatch[1] ?? '', href: linkMatch[2] ?? '' });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Mention: @handle. Only at a token boundary — `admin@involute.local` is
    // an email, not a mention, and the server would not have resolved it
    // either (INV-558).
    const mentionMatch = remaining.match(/^@([a-z0-9][a-z0-9_-]{0,31})(?![a-z0-9_-])/i);
    if (mentionMatch && isMentionBoundary(text, text.length - remaining.length)) {
      tokens.push({ type: 'mention', content: (mentionMatch[1] ?? '').toLowerCase() });
      remaining = remaining.slice(mentionMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      tokens.push({ type: 'code', content: codeMatch[1] ?? '' });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold: **text**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      tokens.push({ type: 'bold', children: tokenizeInline(boldMatch[1] ?? '') });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* (but not **)
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      tokens.push({ type: 'italic', children: tokenizeInline(italicMatch[1] ?? '') });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text: consume until next special character
    const nextSpecial = remaining.slice(1).search(/[`*!\[@]/);
    if (nextSpecial === -1) {
      tokens.push({ type: 'text', content: remaining });
      break;
    }
    tokens.push({ type: 'text', content: remaining.slice(0, nextSpecial + 1) });
    remaining = remaining.slice(nextSpecial + 1);
  }

  return tokens;
}

function renderTokens(tokens: ParsedToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'text':
        return token.content ?? '';
      case 'bold':
        return <strong key={key}>{renderTokens(token.children ?? [], key)}</strong>;
      case 'italic':
        return <em key={key}>{renderTokens(token.children ?? [], key)}</em>;
      case 'code':
        return <code key={key}>{token.content}</code>;
      case 'mention':
        // Routed client-side so the agent's page is one click from the place
        // it was mentioned.
        return (
          <a key={key} className="markdown-mention" href={`/agents/${token.content}`}>
            @{token.content}
          </a>
        );
      case 'link':
        if (isVideoUrl(token.href ?? '')) {
          return (
            <video key={key} src={token.href} controls preload="metadata">
              <a href={token.href} target="_blank" rel="noopener noreferrer">
                {token.content}
              </a>
            </video>
          );
        }
        return (
          <a key={key} href={token.href} target="_blank" rel="noopener noreferrer">
            {token.content}
          </a>
        );
      case 'image':
        return <img key={key} src={token.href} alt={token.alt ?? ''} />;
      case 'br':
        return <br key={key} />;
      default:
        return null;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Block parsing (INV-1315): headings, lists, task lists, blockquotes,  */
/* rules, pipe tables, paragraphs, fenced code. Hand-written on purpose */
/* — no markdown library.                                               */
/* ------------------------------------------------------------------ */

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && next.includes('-') && TABLE_DIVIDER.test(next);
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(line, next)
  );
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

type Align = 'left' | 'center' | 'right' | undefined;

function cellAlign(divider: string): Align {
  const cell = divider.trim();
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
  if (cell.endsWith(':')) return 'right';
  if (cell.startsWith(':')) return 'left';
  return undefined;
}

function inline(text: string, key: string): ReactNode[] {
  return renderTokens(tokenizeInline(text), key);
}

/** Inline content of several source lines, joined by <br>. */
function inlineLines(lines: string[], key: string): ReactNode[] {
  return lines.flatMap((text, index) =>
    index === 0 ? inline(text, `${key}-${index}`) : [<br key={`${key}-br-${index}`} />, ...inline(text, `${key}-${index}`)],
  );
}

interface ListItem {
  text: string[];
  checked: boolean | null;
  children: ListBlock | null;
}

interface ListBlock {
  ordered: boolean;
  start: number;
  items: ListItem[];
}

function indentWidth(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length;
}

function isOrderedMarker(marker: string | undefined): boolean {
  return /\d/.test(marker ?? '');
}

/** Collects a list starting at `lines[start]`; items may nest one level. Returns the next index. */
function collectList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = lines[start]!.match(LIST_ITEM)!;
  const baseIndent = indentWidth(lines[start]!);
  const ordered = isOrderedMarker(first[2]);
  const block: ListBlock = { ordered, start: ordered ? Number.parseInt(first[2] ?? '1', 10) : 1, items: [] };
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      // A blank line ends the list unless the next line is another item of it.
      const nextLine = lines[index + 1];
      const nextMatch = nextLine?.match(LIST_ITEM);
      if (nextLine !== undefined && nextMatch && indentWidth(nextLine) >= baseIndent && isOrderedMarker(nextMatch[2]) === ordered) {
        index += 1;
        continue;
      }
      break;
    }
    const match = line.match(LIST_ITEM);
    const current = block.items[block.items.length - 1];
    if (match) {
      const indent = indentWidth(line);
      if (indent >= baseIndent + 2 && current) {
        const nested = collectList(lines, index);
        if (current.children && current.children.ordered === nested.block.ordered) {
          current.children.items.push(...nested.block.items);
        } else {
          current.children = nested.block;
        }
        index = nested.next;
        continue;
      }
      if (indent < baseIndent || isOrderedMarker(match[2]) !== ordered) break;
      const task = (match[3] ?? '').match(/^\[([ xX])\]\s+(.*)$/);
      block.items.push({
        text: [task ? task[2] ?? '' : match[3] ?? ''],
        checked: task ? task[1] !== ' ' : null,
        children: null,
      });
      index += 1;
      continue;
    }
    // A line that starts another block ends the list; any other line continues the item.
    if (!current || (indentWidth(line) <= baseIndent && startsBlock(line, lines[index + 1]))) break;
    current.text.push(line.trim());
    index += 1;
  }
  return { block, next: index };
}

function renderList(block: ListBlock, key: string): ReactNode {
  const items = block.items.map((item, index) => {
    const itemKey = `${key}-${index}`;
    return (
      <li key={itemKey} className={item.checked === null ? undefined : 'markdown-content__task'}>
        {item.checked === null ? null : (
          <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? 'Done' : 'Not done'} />
        )}
        {inlineLines(item.text, itemKey)}
        {item.children ? renderList(item.children, `${itemKey}-sub`) : null}
      </li>
    );
  });
  if (block.ordered) {
    return (
      <ol key={key} start={block.start === 1 ? undefined : block.start}>
        {items}
      </ol>
    );
  }
  return <ul key={key}>{items}</ul>;
}

/**
 * `#` renders as h3 … `####` (and deeper) as h6: the page's own title and
 * sections come first in the outline. Visual sizes are card-sized
 * (`.markdown-content__h1` … `__h4` in styles/content.css).
 */
const HEADING_TAGS = ['h3', 'h4', 'h5', 'h6'] as const;
const HEADING_CLASSES = ['markdown-content__h1', 'markdown-content__h2', 'markdown-content__h3', 'markdown-content__h4'] as const;

function parseMarkdown(source: string, keyPrefix = 'b'): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const elements: ReactNode[] = [];
  let i = 0;
  const nextKey = () => `${keyPrefix}${elements.length}`;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ```
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      elements.push(
        <pre key={nextKey()}>
          <code data-lang={lang || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(heading[1]!.length, 4);
      const Tag = HEADING_TAGS[level - 1]!;
      const key = nextKey();
      elements.push(
        <Tag key={key} className={HEADING_CLASSES[level - 1]}>
          {inline(heading[2] ?? '', key)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      elements.push(<hr key={nextKey()} />);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(QUOTE, ''));
        i++;
      }
      const key = nextKey();
      elements.push(<blockquote key={key}>{parseMarkdown(quoted.join('\n'), `${key}q`)}</blockquote>);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = collectList(lines, i);
      elements.push(renderList(block, nextKey()));
      i = next;
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map(cellAlign);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const key = nextKey();
      elements.push(
        <div key={key} className="markdown-content__table">
          <table>
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index} align={aligns[index]}>{inline(cell, `${key}-h${index}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {header.map((_, index) => (
                    <td key={index} align={aligns[index]}>{inline(row[index] ?? '', `${key}-${rowIndex}-${index}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Paragraph: consecutive plain lines; single line breaks are kept.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && (paragraph.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) {
      paragraph.push(lines[i]!);
      i++;
    }
    const key = nextKey();
    elements.push(<p key={key}>{inlineLines(paragraph, key)}</p>);
  }

  return elements;
}

/** Rough line count used when layout is unavailable (jsdom, hidden panels). */
function estimatedLines(source: string): number {
  return source.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 90)), 0);
}

export function MarkdownRenderer({ content, className, clamp, size = 'md' }: MarkdownRendererProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!clamp || !body || expanded) return;
    const measured = body.clientHeight > 0;
    setOverflows(measured ? body.scrollHeight > body.clientHeight + 1 : estimatedLines(content) > clamp);
  }, [clamp, content, expanded]);

  if (!content || !content.trim()) {
    return null;
  }

  const rendered = parseMarkdown(content);
  const classes = ['markdown-content', size === 'sm' ? 'markdown-content--sm' : null, className].filter(Boolean).join(' ');

  if (!clamp) {
    return <div className={classes}>{rendered}</div>;
  }

  return (
    <div className={classes}>
      <div
        ref={bodyRef}
        className={expanded ? 'markdown-content__body' : 'markdown-content__body markdown-content__body--clamped'}
        style={{ '--markdown-clamp': clamp } as CSSProperties}
      >
        {rendered}
      </div>
      {overflows || expanded ? (
        <Btn variant="ghost" className="markdown-content__toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show more'}
        </Btn>
      ) : null}
    </div>
  );
}
