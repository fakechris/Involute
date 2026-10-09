import { useEffect, useRef, useState } from 'react';

import { isGotoChordPending } from '../app/goto-chord';

/**
 * Board-style keys for review queues (INV-1087): J/K or ↑/↓ move focus, X
 * toggles the focused row, ⇧A selects every visible row, ⇧X clears, Enter
 * opens, ⌘↵ runs the page's primary action on the focused row. Ignored while
 * typing and during the `g` navigation chord.
 */
export function useListKeys<T extends { id: string }>(
  items: T[],
  handlers: {
    onToggle: (item: T) => void;
    onSelectAll: () => void;
    onClear: () => void;
    onOpen: (item: T) => void;
    onPrimary?: (item: T) => void;
  },
) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const ref = useRef({ items, handlers, focusedId });
  ref.current = { items, handlers, focusedId };

  useEffect(() => {
    if (focusedId && !items.some((item) => item.id === focusedId)) setFocusedId(items[0]?.id ?? null);
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
      if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); setFocusedId(list[current ? Math.min(list.length - 1, index + 1) : 0]!.id); return; }
      if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); setFocusedId(list[Math.max(0, index - 1)]!.id); return; }
      if (event.key === 'x' && focused) { event.preventDefault(); on.onToggle(focused); return; }
      if (event.key === 'X' && event.shiftKey) { event.preventDefault(); on.onClear(); return; }
      if (event.key === 'A' && event.shiftKey) { event.preventDefault(); on.onSelectAll(); return; }
      if ((event.key === 'Enter' || event.key === 'o') && focused) { event.preventDefault(); on.onOpen(focused); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { focusedId, setFocusedId };
}
