import { looksSensitiveValue } from './redact';

/**
 * A CSS selector for the picked element (INV-1147), unique within its
 * document, preferring what survives a rebuild: an id, a data-testid, stable
 * class names, and only then an nth-of-type path. Ids and classes that look
 * generated (hashes, CSS-module suffixes) or sensitive (an email, a token) are
 * not used.
 */
const TEST_ATTRIBUTES = ['data-testid', 'data-test', 'data-test-id', 'data-cy'];
const MAX_DEPTH = 12;

export function cssEscape(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (escape) return escape(value);
  return value.replace(/^(\d)/, '\\3$1 ').replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
}

/** Generated-looking names: hashes, long digit runs, CSS-module / styled-components suffixes. */
export function isStableName(name: string): boolean {
  if (!name || name.length > 40) return false;
  if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)) return false;
  if (looksSensitiveValue(name)) return false;
  if (/\d{3,}/.test(name)) return false;
  if (/^(css|sc|jsx|emotion|svelte|tw)-/.test(name)) return false;
  if (/__[A-Za-z0-9]{5,}$/.test(name)) return false;
  // A segment that mixes digits with letters, or upper with lower after the first letter, reads as a hash.
  return name.split(/[-_]+/).every((segment) => {
    if (segment.length < 5) return true;
    const digits = (segment.match(/\d/g) ?? []).length;
    if (digits >= 2) return false;
    return !(digits >= 1 && /[A-Z]/.test(segment.slice(1)) && /[a-z]/.test(segment));
  });
}

function isUnique(root: Document, selector: string, element: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

/** The simple selector for one element on its own: tag plus id / test attribute / stable classes. */
function candidates(element: Element): string[] {
  const tag = element.tagName.toLowerCase();
  const list: string[] = [];
  const id = element.getAttribute('id');
  if (id && isStableName(id)) list.push(`#${cssEscape(id)}`);
  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value && !looksSensitiveValue(value) && value.length <= 80) list.push(`[${attribute}="${value.replace(/["\\]/g, '\\$&')}"]`);
  }
  const classes = [...element.classList].filter(isStableName).slice(0, 3);
  if (classes.length > 0) list.push(`${tag}${classes.map((name) => `.${cssEscape(name)}`).join('')}`);
  return list;
}

function nthOfType(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;
  const same = [...parent.children].filter((child) => child.tagName === element.tagName);
  if (same.length === 1) return tag;
  return `${tag}:nth-of-type(${same.indexOf(element) + 1})`;
}

/** Build a selector that matches exactly this element in its document. */
export function buildSelector(element: Element): string {
  const root = element.ownerDocument;
  // Walk up from the element: at each ancestor, try its stable anchors in front
  // of the path so far, then extend the path with its nth-of-type step.
  const path: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current && current !== root.documentElement && depth < MAX_DEPTH) {
    for (const candidate of candidates(current)) {
      const selector = [candidate, ...path].join(' > ');
      if (isUnique(root, selector, element)) return selector;
    }
    path.unshift(nthOfType(current));
    const selector = path.join(' > ');
    if (isUnique(root, selector, element)) return selector;
    current = current.parentElement;
    depth += 1;
  }
  // A full nth-of-type path from <html> is always unique.
  const full: string[] = [];
  let node: Element | null = element;
  while (node && node !== root.documentElement) {
    full.unshift(nthOfType(node));
    node = node.parentElement;
  }
  return ['html', ...full].join(' > ');
}
