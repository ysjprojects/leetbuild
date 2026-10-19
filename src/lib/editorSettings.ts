/**
 * The learner's editor preferences — font size, line wrapping, key bindings — one set for every
 * editor on the page (the step editor, the solution and submission viewers), kept in
 * `localStorage` and read through `useEditorSettings`, so a change applies live everywhere
 * without the settings travelling through props.
 */
import {useSyncExternalStore} from 'react';

export type EditorKeymap = 'default' | 'vim';

export interface EditorSettings {
  /** Pixels; one of `FONT_SIZES`. */
  fontSize: number;
  /** Wrap long lines instead of scrolling sideways. */
  wrap: boolean;
  keymap: EditorKeymap;
}

export const FONT_SIZES: readonly number[] = [12, 13, 14, 15, 16, 18];
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {fontSize: 13, wrap: false, keymap: 'default'};
const KEY = 'leetbuild:editor';

let current: EditorSettings | null = null;
const listeners = new Set<() => void>();

const load = (): EditorSettings => {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_EDITOR_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return {
      fontSize:
        typeof parsed.fontSize === 'number' && FONT_SIZES.includes(parsed.fontSize)
          ? parsed.fontSize
          : DEFAULT_EDITOR_SETTINGS.fontSize,
      wrap: typeof parsed.wrap === 'boolean' ? parsed.wrap : DEFAULT_EDITOR_SETTINGS.wrap,
      keymap: parsed.keymap === 'vim' ? 'vim' : 'default',
    };
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
};

export function getEditorSettings(): EditorSettings {
  if (current === null) current = typeof window === 'undefined' ? DEFAULT_EDITOR_SETTINGS : load();
  return current;
}

export function setEditorSettings(patch: Partial<EditorSettings>): void {
  current = {...getEditorSettings(), ...patch};
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage disabled or full: the setting still applies for this page
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const serverSnapshot = (): EditorSettings => DEFAULT_EDITOR_SETTINGS;

/** The current settings; re-renders the caller when they change. */
export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(subscribe, getEditorSettings, serverSnapshot);
}
