import {type FC, memo} from 'react';

/**
 * Keyboard shortcuts of the playground, written the way the platform does (⌘B on a Mac, Ctrl+B
 * elsewhere), and the help list behind the header's keyboard button and the `?` key. The handler
 * itself lives in the playground, which owns the state the shortcuts act on.
 */

/** The playground never renders on the server, so the platform is known at module load. */
export const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** `⌘B` / `Ctrl+B`. */
export const mod = (key: string): string => (MAC ? `⌘${key}` : `Ctrl+${key}`);
/** `⌥]` / `Alt+]`. */
export const alt = (key: string): string => (MAC ? `⌥${key}` : `Alt+${key}`);

export interface Shortcut {
  keys: string;
  label: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {keys: mod('⏎'), label: 'Submit the step'},
  {keys: mod('B'), label: 'Show or hide the file explorer'},
  {keys: mod('\\'), label: 'Show or hide the problem pane'},
  {keys: mod(';'), label: 'Open or close the scratchpad'},
  {keys: alt(']'), label: 'Next step (once unlocked)'},
  {keys: alt('['), label: 'Previous step'},
  {keys: '?', label: 'This list (outside the editor)'},
  {keys: 'Esc', label: 'Close a dialog or the scratchpad'},
];

/** True when typing in `target` should keep plain keys (like `?`) to itself. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export const ShortcutList: FC = memo(() => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
    {SHORTCUTS.map(s => (
      <div className="contents" key={s.keys}>
        <dt>
          <kbd className="border-ink-600 bg-ink-900 font-code text-ink-100 inline-block rounded-md border px-1.5 py-0.5 text-[11px] shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)]">
            {s.keys}
          </kbd>
        </dt>
        <dd className="text-ink-200 self-center text-[13px]">{s.label}</dd>
      </div>
    ))}
  </dl>
));
ShortcutList.displayName = 'ShortcutList';

export const KeyboardIcon: FC = memo(() => (
  <svg
    aria-hidden
    fill="none"
    height={14}
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth={1.6}
    viewBox="0 0 16 16"
    width={14}>
    <rect height={9} rx={1.5} width={14} x={1} y={3.5} />
    <path d="M4 6.5h1M7.5 6.5h1M11 6.5h1M4 9.5h1M7.5 9.5h1M11 9.5h1M5.5 12h5" />
  </svg>
));
KeyboardIcon.displayName = 'KeyboardIcon';
