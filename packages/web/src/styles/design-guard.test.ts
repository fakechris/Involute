// @vitest-environment node
/**
 * Design guard (INV-1312, docs/design-system.md §3 rule 10).
 *
 * Catches three kinds of drift before they reach the screen:
 *   (a) a class used in TSX that no stylesheet defines (it renders unstyled);
 *   (b) a `var(--x)` whose token is not defined in a token block (it silently
 *       falls back to a hard-coded value, often unreadable in dark mode);
 *   (c) a hex / rgb() colour literal in TSX (colours come from tokens).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

const STYLESHEETS = ['styles/app.css', 'styles/controls.css', 'styles/layout.css', 'styles/in-review.css', 'styles/content.css', 'components/delivery.css'];

/**
 * Class tokens that may appear in TSX without a stylesheet rule.
 * Keep this short; every entry says why it is not a bug.
 */
const ALLOWED_UNDEFINED_CLASSES = new Set<string>([
  // State / scope hooks: they name an element for tests, devtools or a future
  // rule, and are deliberately unstyled.
  'app-shell--nav-open', // the sidebar carries the open styles (.app-shell__sidebar--open)
  'board-page--state', // loading / error <main>; looks like the page it replaces
  'kanban-card', // wrapper around IssueCard in the kanban view
  'rich-text-submit', // editor submit button, styled inline until the Btn stage (INV-1311)
  'contract-amendment', // region around the amendment panel
  'ops', // Ops page content scope
  'attention-page', // Needs you page scope
  'work-structure', // wrapper of the structure editor's field-stack labels
]);

/**
 * Class families whose members are chosen at runtime. A token in one of these
 * families passes when the stylesheet defines at least one member. (Tokens
 * glued to `${…}` in a template literal are skipped by the extractor itself.)
 */
const DYNAMIC_CLASS_PREFIXES = [
  'proj-color-', // project palette, .proj-color-0 … .proj-color-9
];

/**
 * Custom properties set by a component-scoped rule (not a token block) and
 * read by its children. Each is defined right next to its readers.
 */
const LOCAL_CUSTOM_PROPERTIES = new Set<string>([
  // Set per palette entry by .proj-color-N and read by the project chips.
  '--proj-fg',
  '--proj-bg',
  '--proj-border',
  // Set per severity modifier on the severity chip and read by its base rule.
  '--severity-tone',
  // Set inline by DataTable from its column widths and read by .data-table.
  '--data-table-columns',
  // Set inline by MarkdownRenderer from its clamp prop and read by .markdown-content__body--clamped.
  '--markdown-clamp',
]);

/**
 * TSX files allowed to contain colour literals.
 */
const COLOR_LITERAL_ALLOWLIST = new Set<string>([
  'components/Icons.tsx', // Google logo: brand colours are fixed by Google
  'components/StatusIcon.tsx', // the one place status colours are defined (§3 rule 9)
  'components/graph/graph-colors.ts', // graph palette, mirrors StatusIcon
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

const sourceFiles = walk(SRC)
  .filter((file) => /\.(tsx|ts)$/.test(file))
  .filter((file) => !/\.test\.(tsx|ts)$/.test(file))
  .filter((file) => !relative(SRC, file).startsWith('test/'));
const tsxFiles = sourceFiles.filter((file) => file.endsWith('.tsx'));

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const cssByFile = new Map(
  STYLESHEETS.map((file) => [file, stripCssComments(readFileSync(join(SRC, file), 'utf8'))]),
);

function definedClasses(): Set<string> {
  const classes = new Set<string>();
  for (const css of cssByFile.values()) {
    // A selector prelude is the text before `{` that follows `{`, `}` or the start.
    for (const match of css.matchAll(/(?<=^|[{}])([^{}]*)\{/g)) {
      const prelude = match[1] ?? '';
      if (prelude.trim().startsWith('@')) continue;
      for (const cls of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        classes.add(cls[1]!);
      }
    }
  }
  return classes;
}

function definedTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const css of cssByFile.values()) {
    for (const match of css.matchAll(/(?<=^|[{}])([^{}]*)\{([^{}]*)\}/g)) {
      const prelude = match[1] ?? '';
      if (!/:root|\[data-theme|\[data-density/.test(prelude)) continue;
      for (const decl of (match[2] ?? '').matchAll(/(--[\w-]+)\s*:/g)) {
        tokens.add(decl[1]!);
      }
    }
  }
  return tokens;
}

/** Returns the source text of every `className=` attribute value. */
function classNameExpressions(source: string): string[] {
  const expressions: string[] = [];
  for (const match of source.matchAll(/className=(["{])/g)) {
    const start = match.index! + match[0].length;
    if (match[1] === '"') {
      expressions.push(`"${source.slice(start, source.indexOf('"', start))}"`);
      continue;
    }
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      index += 1;
    }
    expressions.push(source.slice(start, index - 1));
  }
  return expressions;
}

/**
 * Class tokens in one className expression: the contents of every string
 * literal, except literals that are compared (`x === 'cycles'`), plus the
 * static parts of template literals. A token glued to `${…}` is a dynamic
 * prefix or suffix and is skipped.
 */
function classTokens(expression: string, glued: { left: boolean; right: boolean } = { left: false, right: false }): string[] {
  const tokens: string[] = [];
  const literal = /(===|!==|==|!=)?\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2(\s*(?:===|!==|==|!=))?|`((?:[^`\\]|\\.)*)`/g;
  for (const match of expression.matchAll(literal)) {
    if (match[5] !== undefined) {
      const parts = match[5].split(/\$\{(?:[^{}]|\{[^{}]*\})*\}/);
      const placeholders = [...match[5].matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
      placeholders.forEach((inner, index) => {
        // `a--${kind}`: the literals inside complete a class started outside.
        const left = /[-_]$/.test(parts[index] ?? '');
        const right = /^[-_]/.test(parts[index + 1] ?? '');
        tokens.push(...classTokens(inner[1] ?? '', { left, right }));
      });
      parts.forEach((part, index) => {
        const words = part.split(/\s+/);
        words.forEach((word, wordIndex) => {
          // `bug-sla--${status}`: a word ending in - or _ before `${` is a prefix.
          const gluedLeft = index > 0 && wordIndex === 0;
          const gluedRight = index < parts.length - 1 && wordIndex === words.length - 1 && /[-_]$/.test(word);
          if (word && !gluedLeft && !gluedRight) tokens.push(word);
        });
      });
      continue;
    }
    if (match[1] || match[4]) continue;
    const text = match[3] ?? '';
    const words = text.split(/\s+/);
    if (glued.left && /^\S/.test(text)) words.shift();
    if (glued.right && /\S$/.test(text)) words.pop();
    tokens.push(...words);
  }
  return tokens.filter((token) => /^-?_*[a-zA-Z][\w-]*$/.test(token));
}

describe('design guard', () => {
  it('every class used in TSX is defined in a stylesheet', () => {
    const defined = definedClasses();
    const undefinedUses: string[] = [];
    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8');
      for (const expression of classNameExpressions(source)) {
        for (const token of classTokens(expression)) {
          if (defined.has(token) || ALLOWED_UNDEFINED_CLASSES.has(token)) continue;
          // A BEM block root (`agent-lifecycle`) whose elements or modifiers are
          // styled is a scoping hook, not a missing rule.
          if ([...defined].some((cls) => cls.startsWith(`${token}__`) || cls.startsWith(`${token}--`))) continue;
          const family = DYNAMIC_CLASS_PREFIXES.find((prefix) => token.startsWith(prefix));
          if (family && [...defined].some((cls) => cls.startsWith(family))) continue;
          undefinedUses.push(`${relative(SRC, file)}: .${token}`);
        }
      }
    }
    expect([...new Set(undefinedUses)].sort()).toEqual([]);
  });

  it('every var(--token) is defined in a token block', () => {
    const tokens = definedTokens();
    const missing: string[] = [];
    const sources: Array<[string, string]> = [
      ...[...cssByFile.entries()],
      ...sourceFiles.map((file): [string, string] => [relative(SRC, file), readFileSync(file, 'utf8')]),
    ];
    for (const [file, text] of sources) {
      for (const match of text.matchAll(/var\((--[\w-]+)/g)) {
        const name = match[1]!;
        if (tokens.has(name) || LOCAL_CUSTOM_PROPERTIES.has(name)) continue;
        missing.push(`${file}: ${name}`);
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it('TSX contains no colour literals outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const name = relative(SRC, file);
      if (COLOR_LITERAL_ALLOWLIST.has(name)) continue;
      const source = readFileSync(file, 'utf8');
      const literal = /['"`(\s:,]#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\brgba?\(/g;
      for (const match of source.matchAll(literal)) {
        offenders.push(`${name}: ${match[0].trim()}`);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('the extractor sees classes in strings, ternaries and template literals', () => {
    expect(classTokens(`"btn btn--subtle"`)).toEqual(['btn', 'btn--subtle']);
    expect(classTokens(`tab === 'a' ? 'is-active x' : 'y'`)).toEqual(['is-active', 'x', 'y']);
    expect(classTokens('`card${on ? \' card--on\' : \'\'} plain dyn--${kind}`').sort()).toEqual(['card', 'card--on', 'plain']);
    expect(classTokens("`badge badge--${a ? 'x' : 'y'}`")).toEqual(['badge']);
  });
});
