import type { DensityMode, ThemeMode } from './TweaksPanel';
import { OPEN_CREATE_ISSUE_EVENT } from '../board/utils';

export const THEME_STORAGE_KEY = 'involute.theme';
export const DENSITY_STORAGE_KEY = 'involute.density';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'involute.sidebar-width';

export function getStoredTheme(): ThemeMode {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme;
    }
  } catch {
    // Ignore localStorage failures and fall back to the Atelier light default.
  }

  return 'light';
}

export function persistTheme(nextTheme: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    // Ignore localStorage failures; the theme will still apply for this session.
  }
}

export function getStoredDensity(): DensityMode {
  try {
    const storedDensity = window.localStorage.getItem(DENSITY_STORAGE_KEY);

    if (storedDensity === 'compact' || storedDensity === 'cozy' || storedDensity === 'comfortable') {
      return storedDensity;
    }
  } catch {
    // Ignore localStorage failures and fall back to cozy.
  }

  return 'cozy';
}

export function persistDensity(nextDensity: DensityMode) {
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, nextDensity);
  } catch {
    // Ignore localStorage failures.
  }
}

export function getStoredSidebarWidth() {
  try {
    const storedSidebarWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));

    if (!Number.isNaN(storedSidebarWidth) && storedSidebarWidth >= 220 && storedSidebarWidth <= 320) {
      return storedSidebarWidth;
    }
  } catch {
    // Ignore localStorage failures and fall back to the default sidebar width.
  }

  return 248;
}

export function persistSidebarWidth(nextSidebarWidth: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextSidebarWidth));
  } catch {
    // Ignore localStorage failures.
  }
}

export function openCreateIssueSurface(
  navigate: (to: string, options?: { state?: unknown }) => void,
  pathname: string,
) {
  if (pathname === '/' || pathname === '/backlog') {
    window.dispatchEvent(new Event(OPEN_CREATE_ISSUE_EVENT));
    return;
  }

  navigate('/', {
    state: {
      openCreateIssue: true,
    },
  });
}
