import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

const RELOAD_KEY = 'involute.chunkReloadAt';
const RELOAD_GUARD_MS = 30_000;

/**
 * True when a dynamic import failed because the chunk is gone or unreachable —
 * typically a tab opened before a deploy asking for a file the new build no
 * longer has (INV-763).
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk .* failed|is not a valid JavaScript MIME type/i.test(
    message,
  );
}

interface ReloadDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload: () => void;
  now: () => number;
}

const browserDeps = (): ReloadDeps => ({
  storage: window.sessionStorage,
  reload: () => window.location.reload(),
  now: () => Date.now(),
});

/**
 * Load a route chunk; if it fails as a stale chunk, reload the page once so the
 * browser fetches the current build (the URL already points at the target
 * route). A second failure within 30 seconds is thrown, so a real outage shows
 * the error page instead of reloading forever.
 */
export async function loadWithReload<T>(load: () => Promise<T>, deps: ReloadDeps = browserDeps()): Promise<T> {
  try {
    const module = await load();
    deps.storage.removeItem(RELOAD_KEY);
    return module;
  } catch (error) {
    const last = Number(deps.storage.getItem(RELOAD_KEY) ?? 0);
    if (isChunkLoadError(error) && deps.now() - last > RELOAD_GUARD_MS) {
      deps.storage.setItem(RELOAD_KEY, String(deps.now()));
      deps.reload();
      return new Promise<T>(() => undefined);
    }
    throw error;
  }
}

/** React.lazy for a named route export, with stale-chunk recovery. */
export function lazyRoute<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => ({ default: await loadWithReload(load) }));
}

interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** Changing it (e.g. the pathname) clears a shown error. */
  resetKey: string;
}

/** Keeps a failing view from blanking the whole app; offers a reload instead. */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, { error: Error | null; resetKey: string }> {
  state = { error: null as Error | null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: RouteErrorBoundaryProps, state: { error: Error | null; resetKey: string }) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route failed to render', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = isChunkLoadError(this.state.error);
    return (
      <main className="board-page board-page--state">
        <section className="shell-notice" role="alert">
          <p>{stale ? 'A new version of Involute is available.' : 'This page failed to load.'}</p>
          <button type="button" className="ui-action ui-action--accent" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}
