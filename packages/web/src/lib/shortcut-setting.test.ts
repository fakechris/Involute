import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installShortcutGuard } from './shortcut-setting';

// INV-2126 / INV-2142: with shortcuts off, a plain key stops before any
// shortcut handler, wherever focus is, except where typing belongs.
describe('shortcut guard', () => {
  let uninstall: () => void;
  const heard = vi.fn();
  beforeEach(() => {
    window.localStorage.setItem('involute.shortcuts', 'false');
    uninstall = installShortcutGuard();
    window.addEventListener('keydown', heard);
  });
  afterEach(() => {
    window.removeEventListener('keydown', heard);
    uninstall();
    window.localStorage.removeItem('involute.shortcuts');
    document.body.innerHTML = '';
    heard.mockClear();
  });

  function press(target: Element, key: string) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  it('stops a plain key on a button inside a dialog such as the issue drawer', () => {
    document.body.innerHTML = '<aside role="dialog"><button>Close</button></aside>';
    press(document.querySelector('button')!, 't');
    expect(heard).not.toHaveBeenCalled();
  });

  it('lets type-ahead widgets and text fields keep their letters, and lets Escape through', () => {
    document.body.innerHTML = '<aside role="dialog"><ul role="listbox" tabindex="0"></ul><input /><button>Close</button></aside>';
    press(document.querySelector('[role="listbox"]')!, 'a');
    press(document.querySelector('input')!, 'c');
    press(document.querySelector('button')!, 'Escape');
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('does nothing while shortcuts are on', () => {
    window.localStorage.setItem('involute.shortcuts', 'true');
    document.body.innerHTML = '<aside role="dialog"><button>Close</button></aside>';
    press(document.querySelector('button')!, 't');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
