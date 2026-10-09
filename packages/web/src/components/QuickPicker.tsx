import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The in-place picker behind S / P / A / L on the board (INV-1087): type to
 * filter, ↑↓ to move, Enter to choose, Esc to cancel. Opens over the page and
 * hands focus back when it closes.
 */
export interface QuickPickerOption {
  id: string;
  label: string;
  /** Shown as already applied (labels). */
  checked?: boolean;
  /** A digit that picks this option directly (priorities). */
  hotkey?: string;
}

export function QuickPicker({
  title,
  options,
  onPick,
  onClose,
}: {
  title: string;
  options: QuickPickerOption[];
  onPick: (option: QuickPickerOption) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocus = useRef<Element | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;
  }, [options, query]);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, []);

  useEffect(() => setIndex(0), [query]);

  function choose(option: QuickPickerOption | undefined) {
    if (!option) return;
    onPick(option);
    onClose();
  }

  return (
    <div className="quick-picker__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="quick-picker" role="dialog" aria-label={title}>
        <input
          ref={inputRef}
          className="quick-picker__input"
          aria-label={`${title} filter`}
          placeholder={title}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((current) => Math.min(visible.length - 1, current + 1)); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); return; }
            if (event.key === 'Enter') { event.preventDefault(); choose(visible[index]); return; }
            if (!query && /^[0-9]$/.test(event.key)) {
              const direct = options.find((option) => option.hotkey === event.key);
              if (direct) { event.preventDefault(); choose(direct); }
            }
          }}
        />
        <ul className="quick-picker__list" role="listbox" aria-label={title}>
          {visible.map((option, position) => (
            <li
              key={option.id}
              role="option"
              aria-selected={position === index}
              className={`quick-picker__option${position === index ? ' quick-picker__option--active' : ''}`}
              onMouseEnter={() => setIndex(position)}
              onMouseDown={(event) => { event.preventDefault(); choose(option); }}
            >
              <span className="quick-picker__check" aria-hidden="true">{option.checked ? '✓' : ''}</span>
              <span>{option.label}</span>
              {option.hotkey ? <kbd className="quick-picker__key">{option.hotkey}</kbd> : null}
            </li>
          ))}
          {visible.length === 0 ? <li className="quick-picker__empty">No match</li> : null}
        </ul>
      </div>
    </div>
  );
}
