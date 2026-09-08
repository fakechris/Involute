export type ThemeMode = 'dark' | 'light';
export type DensityMode = 'compact' | 'cozy' | 'comfortable';

export function TweaksPanel({
  density,
  onClose,
  open,
  setDensity,
  setSidebarWidth,
  setTheme,
  sidebarWidth,
  theme,
}: {
  density: DensityMode;
  onClose: () => void;
  open: boolean;
  setDensity: (nextDensity: DensityMode) => void;
  setSidebarWidth: (nextSidebarWidth: number) => void;
  setTheme: (nextTheme: ThemeMode) => void;
  sidebarWidth: number;
  theme: ThemeMode;
}) {
  if (!open) {
    return null;
  }

  return (
    <section className="tweaks-panel" aria-label="Interface tweaks">
      <div className="tweaks-panel__header">
        <strong>Tweaks</strong>
        <button type="button" className="tweaks-panel__close" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="tweaks-panel__section">
        <span className="tweaks-panel__label">Theme</span>
        <div className="tweaks-panel__options">
          {(['dark', 'light'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`tweaks-panel__option${theme === mode ? ' tweaks-panel__option--active' : ''}`}
              onClick={() => setTheme(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="tweaks-panel__section">
        <span className="tweaks-panel__label">Density</span>
        <div className="tweaks-panel__options">
          {(
            [
              ['compact', 'Compact'],
              ['cozy', 'Cozy'],
              ['comfortable', 'Comfortable'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`tweaks-panel__option${density === mode ? ' tweaks-panel__option--active' : ''}`}
              onClick={() => setDensity(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="tweaks-panel__section">
        <div className="tweaks-panel__slider-row">
          <span className="tweaks-panel__label">Sidebar width</span>
          <span className="tweaks-panel__value">{sidebarWidth}px</span>
        </div>
        <input
          type="range"
          min="220"
          max="320"
          step="4"
          value={sidebarWidth}
          onChange={(event) => setSidebarWidth(Number(event.target.value))}
        />
      </div>
    </section>
  );
}
