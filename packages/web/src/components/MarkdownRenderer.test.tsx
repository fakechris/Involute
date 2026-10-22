import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownRenderer } from './MarkdownRenderer';

afterEach(cleanup);

function renderMarkdown(content: string, props: { clamp?: number; size?: 'sm' | 'md' } = {}) {
  const { container } = render(<MarkdownRenderer content={content} {...props} />);
  return container.querySelector('.markdown-content') as HTMLElement;
}

const THREE_SECTIONS = [
  '### 1. 目标与架构定位',
  '让验收卡片可读。',
  '',
  '### 2. 核心功能与交付范围',
  '- MarkdownRenderer 支持块级语法',
  '- 接入 In Review',
  '',
  '### 3. 验收标准与验证方案',
  '1. `pnpm test` exit 0',
  '2. typecheck exit 0',
].join('\n');

describe('MarkdownRenderer blocks (INV-1315)', () => {
  it('renders the three-section description as headings and lists, not literal ###', () => {
    const root = renderMarkdown(THREE_SECTIONS);
    expect(root.textContent).not.toContain('###');
    const headings = within(root).getAllByRole('heading');
    expect(headings.map((heading) => heading.textContent)).toEqual(['1. 目标与架构定位', '2. 核心功能与交付范围', '3. 验收标准与验证方案']);
    expect(headings[0]!.tagName).toBe('H5');
    expect(headings[0]).toHaveClass('markdown-content__h3');
    const lists = within(root).getAllByRole('list');
    expect(lists[0]!.tagName).toBe('UL');
    expect(within(lists[0]!).getAllByRole('listitem')).toHaveLength(2);
    expect(lists[1]!.tagName).toBe('OL');
    expect(within(lists[1]!).getByText('pnpm test').tagName).toBe('CODE');
    expect(root).toMatchSnapshot();
  });

  it('maps # … #### to h3 … h6 with card-sized classes', () => {
    const root = renderMarkdown('# One\n## Two\n### Three\n#### Four\n##### Five');
    const headings = within(root).getAllByRole('heading');
    expect(headings.map((heading) => heading.tagName)).toEqual(['H3', 'H4', 'H5', 'H6', 'H6']);
    expect(headings.map((heading) => heading.className)).toEqual([
      'markdown-content__h1',
      'markdown-content__h2',
      'markdown-content__h3',
      'markdown-content__h4',
      'markdown-content__h4',
    ]);
  });

  it('renders ordered lists with their start number', () => {
    const root = renderMarkdown('3. three\n4. four');
    const list = within(root).getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(list).toHaveAttribute('start', '3');
  });

  it('nests one level and keeps continuation lines in the item', () => {
    const root = renderMarkdown('- parent\n  - child a\n  - child b\n- second\n  continued');
    const outer = root.querySelector(':scope > ul') as HTMLElement;
    const items = outer.querySelectorAll(':scope > li');
    expect(items).toHaveLength(2);
    const nested = items[0]!.querySelector('ul') as HTMLElement;
    expect(within(nested).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['child a', 'child b']);
    expect(items[1]!.querySelector('br')).not.toBeNull();
    expect(items[1]!.textContent).toBe('secondcontinued');
  });

  it('renders task lists as read-only checkboxes', () => {
    const root = renderMarkdown('- [x] done thing\n- [ ] open thing');
    const boxes = within(root).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(root.querySelectorAll('.markdown-content__task')).toHaveLength(2);
    expect(root.textContent).not.toContain('[x]');
  });

  it('renders blockquotes with block content inside', () => {
    const root = renderMarkdown('> quoted **line**\n> - item');
    const quote = root.querySelector('blockquote') as HTMLElement;
    expect(quote).not.toBeNull();
    expect(within(quote).getByText('line').tagName).toBe('STRONG');
    expect(within(quote).getByRole('list')).toBeInTheDocument();
  });

  it('renders horizontal rules', () => {
    const root = renderMarkdown('above\n\n---\n\nbelow\n\n***');
    expect(root.querySelectorAll('hr')).toHaveLength(2);
    expect(root.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders pipe tables with header, rows and alignment', () => {
    const root = renderMarkdown('| Name | Count |\n| :--- | ---: |\n| a | 1 |\n| `b` | 2 |');
    const table = within(root).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Name', 'Count']);
    const cells = within(table).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual(['a', '1', 'b', '2']);
    expect(cells[1]).toHaveAttribute('align', 'right');
    expect(within(table).getByText('b').tagName).toBe('CODE');
    expect(root).toMatchSnapshot();
  });

  it('keeps single line breaks inside a paragraph and splits paragraphs on blank lines', () => {
    const root = renderMarkdown('line one\nline two\n\nnext paragraph');
    const paragraphs = root.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.querySelectorAll('br')).toHaveLength(1);
    expect(paragraphs[1]!.textContent).toBe('next paragraph');
  });

  it('leaves fenced code untouched, including markdown inside it', () => {
    const root = renderMarkdown('```ts\n### not a heading\n- not a list\n```');
    const code = root.querySelector('pre code') as HTMLElement;
    expect(code).toHaveAttribute('data-lang', 'ts');
    expect(code.textContent).toBe('### not a heading\n- not a list');
    expect(within(root).queryByRole('heading')).toBeNull();
    expect(within(root).queryByRole('list')).toBeNull();
  });

  it('keeps inline tokens: bold, italic, code, links, images, video and @mentions', () => {
    const root = renderMarkdown('**b** *i* `c` [site](https://example.com) ![shot](https://x.test/a.png) [clip](https://x.test/v.mp4) hi @Mia, not admin@involute.local');
    expect(within(root).getByText('b').tagName).toBe('STRONG');
    expect(within(root).getByText('i').tagName).toBe('EM');
    expect(within(root).getByText('c').tagName).toBe('CODE');
    expect(within(root).getByRole('link', { name: 'site' })).toHaveAttribute('href', 'https://example.com');
    expect(within(root).getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'https://x.test/a.png');
    expect(root.querySelector('video')).toHaveAttribute('src', 'https://x.test/v.mp4');
    const mention = within(root).getByRole('link', { name: '@mia' });
    expect(mention).toHaveAttribute('href', '/agents/mia');
    expect(mention).toHaveClass('markdown-mention');
    expect(root.querySelectorAll('.markdown-mention')).toHaveLength(1);
  });

  it('a list line inside a paragraph starts a list', () => {
    const root = renderMarkdown('Intro text\n- first\n- second');
    expect(root.querySelector('p')!.textContent).toBe('Intro text');
    expect(within(root).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders nothing for empty or blank content', () => {
    const { container } = render(<MarkdownRenderer content={'  \n '} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('size="sm" adds the compact modifier', () => {
    expect(renderMarkdown('x', { size: 'sm' })).toHaveClass('markdown-content', 'markdown-content--sm');
  });
});

describe('MarkdownRenderer clamp', () => {
  const long = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');

  it('clamps long text and toggles Show more / Show less', () => {
    const root = renderMarkdown(long, { clamp: 6 });
    const body = root.querySelector('.markdown-content__body') as HTMLElement;
    expect(body).toHaveClass('markdown-content__body--clamped');
    expect(body.style.getPropertyValue('--markdown-clamp')).toBe('6');
    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(body).not.toHaveClass('markdown-content__body--clamped');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(body).toHaveClass('markdown-content__body--clamped');
  });

  it('shows no toggle when the text fits', () => {
    renderMarkdown('short\ntext', { clamp: 6 });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});
