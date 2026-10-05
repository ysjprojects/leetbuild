/**
 * Night / Day switching. The theme is the `data-theme` attribute on <html>, which selects the
 * palette's CSS variables (tailwind.config.ts); a choice persists in localStorage, and with no
 * choice the OS preference applies. `THEME_BOOT_SCRIPT` runs inline before first paint so a saved
 * choice never flashes the other theme.
 */
import {useCallback, useEffect, useState} from 'react';

import {type Theme, PALETTE} from '@/styles/palette';

export const THEME_KEY = 'leetbuild:theme';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** Mobile browser chrome follows the page colour. */
const PAGE_COLOR: Record<Theme, string> = {dark: PALETTE.dark.ink[900], light: PALETTE.light.ink[900]};

export const THEME_BOOT_SCRIPT =
  `(function(){var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}` +
  `if(t!=='light'&&t!=='dark')t=matchMedia(${JSON.stringify(LIGHT_QUERY)}).matches?'light':'dark';` +
  `document.documentElement.dataset.theme=t;` +
  `var m=document.querySelector('meta[name=theme-color]');` +
  `if(m)m.setAttribute('content',t==='light'?${JSON.stringify(PAGE_COLOR.light)}:${JSON.stringify(
    PAGE_COLOR.dark,
  )})})()`;

const current = (): Theme =>
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PAGE_COLOR[theme]);
}

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** The active theme and a toggle. The choice is saved, shared with other tabs, and until one is made the OS preference is followed. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    const set = (next: Theme): void => {
      apply(next);
      setTheme(next);
    };
    const onStorage = (e: StorageEvent): void => {
      if (e.key === THEME_KEY && isTheme(e.newValue)) set(e.newValue);
    };
    const query = matchMedia(LIGHT_QUERY);
    const onPreference = (e: MediaQueryListEvent): void => {
      if (saved() === null) set(e.matches ? 'light' : 'dark');
    };
    window.addEventListener('storage', onStorage);
    query.addEventListener('change', onPreference);
    return () => {
      window.removeEventListener('storage', onStorage);
      query.removeEventListener('change', onPreference);
    };
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = current() === 'light' ? 'dark' : 'light';
    apply(next);
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage unavailable (private mode, quota): the choice lasts for this page.
    }
  }, []);

  return [theme, toggle];
}
