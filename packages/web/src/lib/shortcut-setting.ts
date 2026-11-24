import { isTextEditingTarget } from '../undo/status-undo';

/** Settings → Preferences → Keyboard shortcuts (INV-2126). */
export const SHORTCUTS_STORAGE_KEY = 'involute.shortcuts';

export function shortcutsEnabled(): boolean {
  try {
    return window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeShortcutsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

// Widgets whose own letter keys (type-ahead, menus) must keep working. A dialog
// is not one: the issue drawer is a dialog that takes focus, and the global
// shortcuts must stay off inside it (INV-2142). Text fields are allowed anyway.
const OWN_KEYS_SELECTOR = '[role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"], [role="combobox"]';

/**
 * Single-key shortcuts are handled in many places (the app shell, the board,
 * lists, Needs you). Rather than teach each one the setting, one capturing
 * listener on window stops a plain character key before any of them see it
 * when the person turned shortcuts off. Typing, type-ahead widgets, modified
 * keys (⌘K, ⌘↵), Escape, Enter, Tab and arrows are not touched.
 */
export function installShortcutGuard(target: Window = window): () => void {
  function guard(event: KeyboardEvent) {
    if (shortcutsEnabled()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length !== 1 || event.key === ' ') return;
    if (isTextEditingTarget(event.target)) return;
    if (event.target instanceof Element && event.target.closest(OWN_KEYS_SELECTOR)) return;
    event.stopImmediatePropagation();
  }
  target.addEventListener('keydown', guard, true);
  return () => target.removeEventListener('keydown', guard, true);
}
