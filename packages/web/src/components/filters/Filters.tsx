import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';

import { Checkbox, Select } from '../controls';
import { IcoClose, IcoSearch } from '../Icons';
import { Btn } from '../Primitives';

/**
 * The pieces of a list page's filter bar (INV-1314). They sit in the
 * `filters` and `view` slots of PageToolbar; Board and Backlog use the same
 * ones. Styles: styles/layout.css.
 */

export interface FilterMenuOption {
  value: string;
  label: ReactNode;
  count?: number | undefined;
  /** Accessible name of the option's checkbox when the label is not plain text. */
  'aria-label'?: string | undefined;
}

export interface FilterMenuProps {
  /** Trigger text ("States", "Labels"); also the popover's accessible name. */
  label: string;
  options: ReadonlyArray<FilterMenuOption>;
  /** Values currently checked. */
  selected: ReadonlyArray<string>;
  onToggle: (value: string) => void;
  /** Which edge of the trigger the popover lines up with. */
  align?: 'start' | 'end' | undefined;
  /** Hide the selected-count badge (e.g. a "Columns" visibility menu). */
  hideCount?: boolean | undefined;
  emptyText?: ReactNode | undefined;
}

/** A trigger with a checkbox popover; closes on Escape and outside click. */
export function FilterMenu({ label, options, selected, onToggle, align = 'start', hideCount = false, emptyText = 'Nothing to filter' }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    function handlePointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [open]);

  const activeCount = hideCount ? 0 : selected.length;

  return (
    <div
      ref={rootRef}
      className="filter-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={activeCount > 0 ? 'filter-menu__trigger is-active' : 'filter-menu__trigger'}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        {activeCount > 0 ? <span className="filter-menu__count">{activeCount}</span> : null}
      </button>
      {open ? (
        <div id={popoverId} className={align === 'end' ? 'filter-menu__popover filter-menu__popover--end' : 'filter-menu__popover'} role="group" aria-label={label}>
          {options.length === 0 ? <p className="filter-menu__empty">{emptyText}</p> : null}
          {options.map((option) => (
            <Checkbox
              key={option.value}
              className="filter-menu__option"
              checked={selected.includes(option.value)}
              onChange={() => onToggle(option.value)}
              aria-label={option['aria-label']}
              label={
                <>
                  <span className="filter-menu__option-label">{option.label}</span>
                  {option.count !== undefined ? <span className="filter-menu__option-count">{option.count}</span> : null}
                </>
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface FilterChipProps {
  children: ReactNode;
  onRemove: () => void;
  /** Accessible name of the remove button, e.g. "Remove Label: Bug". */
  removeLabel: string;
}

/** One active filter, removable. */
export function FilterChip({ children, onRemove, removeLabel }: FilterChipProps) {
  return (
    <button type="button" className="filter-chip" aria-label={removeLabel} onClick={onRemove}>
      <span className="filter-chip__text">{children}</span>
      <span className="filter-chip__remove" aria-hidden="true"><IcoClose size={10} /></span>
    </button>
  );
}

export interface FilterSearchProps {
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
  placeholder?: string | undefined;
  /** Shortcut hint drawn at the right edge (e.g. "/"). */
  shortcut?: string | undefined;
  /** Shown while there is text, e.g. a "Search all work →" link. */
  trailing?: ReactNode | undefined;
  /** First Esc clears the text; with `blurOnEmptyEscape` the next one leaves the box. */
  blurOnEmptyEscape?: boolean | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** The text filter of a list: a search glyph, the input, optional trailing action and shortcut. */
export function FilterSearch({ value, onChange, 'aria-label': ariaLabel, placeholder, shortcut, trailing, blurOnEmptyEscape = false, ref }: FilterSearchProps) {
  return (
    <div className="filter-search">
      <span className="filter-search__icon" aria-hidden="true"><IcoSearch size={12} /></span>
      <input
        ref={ref}
        className="filter-search__input"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          if (value) {
            event.preventDefault();
            onChange('');
          } else if (blurOnEmptyEscape) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {value.trim() && trailing ? trailing : null}
      {shortcut ? <kbd className="filter-search__kbd">{shortcut}</kbd> : null}
    </div>
  );
}

interface SelectSpec<T extends string> {
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  options: ReadonlyArray<{ value: T; label: string }>;
}

export interface SortControlProps<S extends string, G extends string> {
  sort: SelectSpec<S>;
  direction: { value: 'asc' | 'desc'; onChange: (value: 'asc' | 'desc') => void; 'aria-label': string };
  group?: SelectSpec<G> | undefined;
}

/** Sort field + direction (+ optional Group by), each a small Select with a dim caption. */
export function SortControl<S extends string, G extends string = string>({ sort, direction, group }: SortControlProps<S, G>) {
  return (
    <div className="sort-control">
      <span className="sort-control__caption">Sort</span>
      <Select size="sm" aria-label={sort['aria-label']} value={sort.value} onChange={(event) => sort.onChange(event.target.value as S)}>
        {sort.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      <Select size="sm" aria-label={direction['aria-label']} value={direction.value} onChange={(event) => direction.onChange(event.target.value as 'asc' | 'desc')}>
        <option value="asc">Ascending</option>
        <option value="desc">Descending</option>
      </Select>
      {group ? (
        <>
          <span className="sort-control__caption">Group</span>
          <Select size="sm" aria-label={group['aria-label']} value={group.value} onChange={(event) => group.onChange(event.target.value as G)}>
            {group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </>
      ) : null}
    </div>
  );
}

export interface SavedViewControlProps {
  views: ReadonlyArray<{ id: string; name: string }>;
  activeViewId: string;
  onLoad: (viewId: string) => void;
  onSave: () => void;
  /** Deletes the active view; the button is hidden when omitted. */
  onDelete?: (() => void) | undefined;
  /** Resets the working view to defaults. */
  onClear: () => void;
  'aria-label': string;
  /** The empty option's text ("Views", "Current filters"). */
  placeholder?: string | undefined;
}

/** Saved views: a select to load one, then Save / Delete / Clear. */
export function SavedViewControl({ views, activeViewId, onLoad, onSave, onDelete, onClear, 'aria-label': ariaLabel, placeholder = 'Views' }: SavedViewControlProps) {
  return (
    <div className="saved-view-control">
      <Select size="sm" aria-label={ariaLabel} value={activeViewId} onChange={(event) => onLoad(event.target.value)}>
        <option value="">{placeholder}</option>
        {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </Select>
      <Btn variant="subtle" onClick={onSave}>Save view</Btn>
      {onDelete ? <Btn variant="ghost" disabled={!activeViewId} onClick={onDelete}>Delete view</Btn> : null}
      <Btn variant="ghost" onClick={onClear}>Clear</Btn>
    </div>
  );
}
