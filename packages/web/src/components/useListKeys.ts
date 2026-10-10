import { useEffect, useRef, useState } from 'react';

import { isGotoChordPending } from '../app/goto-chord';

/**
 * Board-style keys for review queues (INV-1087): J/K or ↑/↓ move focus, X
 * toggles the focused row, ⇧A selects every visible row, ⇧X clears, Enter
 * opens, ⌘↵ runs the page's primary action on the focused row. Ignored while
 * typing and during the `g` navigation chord. When the focused row leaves the
 * list (it was decided), focus moves to the row that took its place in the
 * direction J/K last moved, so a queue is cleared without reaching for the
 * mouse (INV-1092). `onKey` gives a page its own single-letter keys.
 */
export function useListKeys<T extends { id: string }>(
  items: T[],
  handlers: {
    onToggle: (item: T) => void;
    onSelectAll: () => void;
    onClear: () => void;
    onOpen: (item: T) => void;
    onPrimary?: (item: T) => void;
    /** A page's own plain key on the focused row; return true when handled. */
    onKey?: (key: string, item: T) => boolean;
  },
) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const ref = useRef({ items, handlers, focusedId });
  ref.current = { items, handlers, focusedId };
  // Where the focused row sat, and which way J/K last went.
  const place = useRef<{ index: number; up: boolean }>({ index: 0, up: false });

  useEffect(() => {
    const index = focusedId ? items.findIndex((item) => item.id === focusedId) : -1;
    if (index >= 0) {
      place.current.index = index;
      return;
    }
    if (!focusedId) return;
    const { index: was, up } = place.current;
    const next = up ? Math.max(0, was - 1) : Math.min(items.length - 1, was);
    setFocusedId(items[next]?.id ?? null);
  }, [items, focusedId]);

  useEffect(() => {
    if (focusedId) document.querySelector(`[data-list-key-id="${CSS.escape(focusedId)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusedId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (isGotoChordPending() || event.defaultPrevented || event.altKey) return;
      const { items: list, handlers: on, focusedId: current } = ref.current;
      if (list.length === 0) return;
      const index = Math.max(0, list.findIndex((item) => item.id === current));
      const focused = list.find((item) => item.id === current) ?? null;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (focused && on.onPrimary) { event.preventDefault(); on.onPrimary(focused); }
        return;
      }
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); place.current.up = false; setFocusedId(list[current ? Math.min(list.length - 1, index + 1) : 0]!.id); return; }
      if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); place.current.up = true; setFocusedId(list[Math.max(0, index - 1)]!.id); return; }
      if (event.key === 'x' && focused) { event.preventDefault(); on.onToggle(focused); return; }
      if (event.key === 'X' && event.shiftKey) { event.preventDefault(); on.onClear(); return; }
      if (event.key === 'A' && event.shiftKey) { event.preventDefault(); on.onSelectAll(); return; }
      if ((event.key === 'Enter' || event.key === 'o') && focused) { event.preventDefault(); on.onOpen(focused); return; }
      if (focused && on.onKey?.(event.key, focused)) event.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { focusedId, setFocusedId };
}
