import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IcoCheck, IcoClose, IcoProject } from './Icons';

export interface AvailableProject {
  id: string;
  identifier: string;
  name: string;
  key: string;
  issueCount: number;
}

export interface ProjectFilterComboboxProps {
  projects: AvailableProject[];
  selectedProjectKey: string | null;
  totalCount?: number;
  onSelectProject: (projectKey: string | null) => void;
  className?: string;
  placeholder?: string;
  showQuickPills?: boolean;
}

export function ProjectFilterCombobox({
  projects,
  selectedProjectKey,
  totalCount = 0,
  onSelectProject,
  className = '',
  placeholder = 'Filter projects...',
  showQuickPills = false,
}: ProjectFilterComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Exact matching for selected project (case-insensitive)
  const activeProject = useMemo(() => {
    if (!selectedProjectKey) return null;
    const target = selectedProjectKey.trim().toLowerCase();
    return (
      projects.find(
        (p) => p.name.toLowerCase() === target || p.identifier.toLowerCase() === target,
      ) ?? null
    );
  }, [projects, selectedProjectKey]);

  // Search filtering matches identifier or name
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase().trim();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
    );
  }, [projects, searchQuery]);

  const totalSelectable = filteredProjects.length + 1;

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setSearchQuery('');
    setHighlightedIndex(0);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setSearchQuery('');
    triggerRef.current?.focus();
  }, []);

  const handleSelect = useCallback(
    (projectKey: string | null) => {
      onSelectProject(projectKey);
      setIsOpen(false);
      setSearchQuery('');
      triggerRef.current?.focus();
    },
    [onSelectProject],
  );

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isOpen]);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Keyboard navigation & two-stage Escape
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (searchQuery) {
        setSearchQuery('');
        setHighlightedIndex(0);
      } else {
        handleClose();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % totalSelectable);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + totalSelectable) % totalSelectable);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex === 0) {
        handleSelect(null);
      } else {
        const item = filteredProjects[highlightedIndex - 1];
        const first = filteredProjects[0];
        if (item) {
          handleSelect(item.name);
        } else if (first) {
          handleSelect(first.name);
        }
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={`project-combobox ${className}`.trim()}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      {/* Combobox Trigger Group */}
      <div className={`project-combobox__trigger-group${activeProject ? ' project-combobox__trigger-group--active' : ''}`}>
        <button
          ref={triggerRef}
          type="button"
          className={`project-combobox__trigger${activeProject ? ' project-combobox__trigger--active' : ''}`}
          onClick={() => (isOpen ? handleClose() : handleOpen())}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={activeProject ? `Project: ${activeProject.name}` : 'Filter by project'}
          title={activeProject ? `Project: ${activeProject.name} (${activeProject.identifier})` : 'Filter by project'}
        >
          <IcoProject size={13} style={{ color: activeProject ? 'var(--accent)' : 'var(--fg-dim)', flexShrink: 0 }} />
          {activeProject ? (
            <>
              <span className="mono project-combobox__trigger-id">{activeProject.identifier}</span>
              <span className="project-combobox__trigger-name">{activeProject.name}</span>
              <span className="project-combobox__trigger-count">{activeProject.issueCount}</span>
            </>
          ) : (
            <>
              <span className="project-combobox__trigger-label">Project:</span>
              <span className="project-combobox__trigger-value">All Projects</span>
              {totalCount > 0 ? (
                <span className="project-combobox__trigger-count">{totalCount}</span>
              ) : null}
            </>
          )}
          <span className="project-combobox__trigger-chevron" aria-hidden="true">▾</span>
        </button>

        {activeProject ? (
          <button
            type="button"
            className="project-combobox__clear-btn"
            title="Clear project filter (Show all)"
            onClick={(e) => {
              e.stopPropagation();
              onSelectProject(null);
            }}
            aria-label="Clear project filter"
          >
            <IcoClose size={11} />
          </button>
        ) : null}
      </div>

      {/* Quick Pills (if showQuickPills and <= 4 projects) */}
      {showQuickPills && projects.length > 0 && projects.length <= 4 ? (
        <div className="project-combobox__quick-pills" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {projects.map((p) => {
            const isActive =
              Boolean(selectedProjectKey) &&
              (selectedProjectKey?.toLowerCase() === p.name.toLowerCase() ||
                selectedProjectKey?.toLowerCase() === p.identifier.toLowerCase());
            return (
              <button
                key={p.id}
                type="button"
                className={`board-project-pill${isActive ? ' board-project-pill--active' : ''}`}
                onClick={() => onSelectProject(isActive ? null : p.name)}
                title={`Filter to ${p.name} (${p.issueCount} issues)`}
              >
                <span className="mono board-project-pill__id">{p.identifier}</span>
                <span className="board-project-pill__name">{p.name}</span>
                <span className="board-project-pill__count">{p.issueCount}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Popover Dropdown */}
      {isOpen && (
        <div
          className="project-combobox__popover"
          role="dialog"
          aria-label="Project filter menu"
        >
          {/* Search Box */}
          <div className="project-combobox__search-wrap">
            <svg
              className="project-combobox__search-icon"
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3" />
              <path d="m9 9 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              className="project-combobox__search-input"
              value={searchQuery}
              placeholder={placeholder}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setHighlightedIndex(0);
              }}
              onKeyDown={handleKeyDown}
            />
            {searchQuery ? (
              <button
                type="button"
                className="project-combobox__search-clear"
                onClick={() => {
                  setSearchQuery('');
                  setHighlightedIndex(0);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
              >
                <IcoClose size={10} />
              </button>
            ) : null}
          </div>

          {/* Options List */}
          <ul ref={listRef} className="project-combobox__list" role="listbox">
            {/* "All Projects" Option */}
            <li
              className={`project-combobox__item${highlightedIndex === 0 ? ' project-combobox__item--highlighted' : ''}${!activeProject ? ' project-combobox__item--selected' : ''}`}
              role="option"
              aria-selected={!activeProject}
              onClick={() => handleSelect(null)}
              onMouseEnter={() => setHighlightedIndex(0)}
            >
              <span className="project-combobox__item-check">
                {!activeProject ? <IcoCheck size={12} /> : null}
              </span>
              <span className="project-combobox__item-name">All Projects</span>
              {totalCount > 0 ? (
                <span className="project-combobox__item-count">{totalCount}</span>
              ) : null}
            </li>

            <div className="project-combobox__divider" />

            {/* Project Rows */}
            {filteredProjects.length === 0 ? (
              <li className="project-combobox__empty">No matching projects</li>
            ) : (
              filteredProjects.map((p, index) => {
                const itemIndex = index + 1;
                const isSelected =
                  Boolean(selectedProjectKey) &&
                  (selectedProjectKey?.toLowerCase() === p.name.toLowerCase() ||
                    selectedProjectKey?.toLowerCase() === p.identifier.toLowerCase());
                const isHighlighted = highlightedIndex === itemIndex;

                return (
                  <li
                    key={p.id}
                    className={`project-combobox__item${isHighlighted ? ' project-combobox__item--highlighted' : ''}${isSelected ? ' project-combobox__item--selected' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(p.name)}
                    onMouseEnter={() => setHighlightedIndex(itemIndex)}
                  >
                    <span className="project-combobox__item-check">
                      {isSelected ? <IcoCheck size={12} /> : null}
                    </span>
                    <span className="mono project-combobox__item-id">{p.identifier}</span>
                    <span className="project-combobox__item-name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="project-combobox__item-count">{p.issueCount}</span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
