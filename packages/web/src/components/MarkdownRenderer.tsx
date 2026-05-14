import { type ReactNode } from 'react';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface ParsedToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'link' | 'image' | 'br';
  content?: string;
  children?: ParsedToken[];
  href?: string;
  alt?: string;
  lang?: string;
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
    const nextSpecial = remaining.slice(1).search(/[`*!\[]/);
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
        return <span key={key}>{token.content}</span>;
      case 'bold':
        return <strong key={key}>{renderTokens(token.children ?? [], key)}</strong>;
      case 'italic':
        return <em key={key}>{renderTokens(token.children ?? [], key)}</em>;
      case 'code':
        return <code key={key}>{token.content}</code>;
      case 'link':
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

function parseMarkdown(source: string): ReactNode[] {
  const lines = source.split('\n');
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      elements.push(
        <pre key={`block-${elements.length}`}>
          <code data-lang={lang || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Empty line -> line break
    if (line.trim() === '') {
      elements.push(<br key={`br-${elements.length}`} />);
      i++;
      continue;
    }

    // Inline content
    const tokens = tokenizeInline(line);
    elements.push(
      <span key={`line-${elements.length}`} style={{ display: 'block' }}>
        {renderTokens(tokens, `l${elements.length}`)}
      </span>,
    );
    i++;
  }

  return elements;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  if (!content) {
    return null;
  }

  const rendered = parseMarkdown(content);

  return <div className={`markdown-content${className ? ` ${className}` : ''}`}>{rendered}</div>;
}
