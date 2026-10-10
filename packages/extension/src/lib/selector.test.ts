// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { buildSelector, isStableName } from './selector';

function only(selector: string): Element {
  const found = document.querySelectorAll(selector);
  expect(found.length, selector).toBe(1);
  return found[0]!;
}

describe('buildSelector', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header id="top"><nav><a class="nav-link">Home</a><a class="nav-link">Board</a></nav></header>
      <main>
        <section class="card css-1x2y3z"><button data-testid="save">Save</button><button class="btn primary">Go</button></section>
        <section class="card"><button class="btn primary">Go</button><span>One</span><span>Two</span></section>
        <div id="user-jane@example.com"><p>Hi</p></div>
        <ul><li>a</li><li>b</li><li>c</li></ul>
      </main>`;
  });

  it('prefers an id, then a data-testid', () => {
    expect(buildSelector(document.getElementById('top')!)).toBe('#top');
    expect(buildSelector(document.querySelector('[data-testid="save"]')!)).toBe('[data-testid="save"]');
  });

  it('is unique within the document for every element', () => {
    for (const element of document.body.querySelectorAll('*')) {
      expect(only(buildSelector(element))).toBe(element);
    }
  });

  it('disambiguates repeated stable classes with a path', () => {
    const second = document.querySelectorAll('button.btn')[1]!;
    const selector = buildSelector(second);
    expect(only(selector)).toBe(second);
  });

  it('never uses generated or sensitive names', () => {
    const selectors = [...document.body.querySelectorAll('*')].map((element) => buildSelector(element)).join('\n');
    expect(selectors).not.toContain('css-1x2y3z');
    expect(selectors).not.toContain('jane');
    expect(isStableName('Button_root__3xYzQ')).toBe(false);
    expect(isStableName('sc-bdVaJa')).toBe(false);
    expect(isStableName('item-12345')).toBe(false);
    expect(isStableName('nav-link')).toBe(true);
    expect(isStableName('primary')).toBe(true);
  });

  it('uses nth-of-type for anonymous siblings', () => {
    const li = document.querySelectorAll('li')[2]!;
    expect(buildSelector(li)).toContain('li:nth-of-type(3)');
    expect(only(buildSelector(li))).toBe(li);
  });
});
