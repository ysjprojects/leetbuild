import {type FC, type ReactNode, memo, useCallback} from 'react';

import {type EditorKeymap, FONT_SIZES, setEditorSettings, useEditorSettings} from '@/lib/editorSettings';

import {MAC} from './Shortcuts';

/**
 * The editor's settings — font size, long lines, key bindings — as a short form in a dialog. Every
 * change applies at once to every editor on the page and is remembered (`leetbuild:editor`).
 */

const segment = (on: boolean): string =>
  `rounded-md px-2 py-0.5 text-[12px] transition ${on ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-50'}`;

const Row: FC<{label: string; children: ReactNode}> = memo(({label, children}) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <span className="text-ink-200 w-24 shrink-0 text-[12px] font-semibold">{label}</span>
    <span className="flex flex-wrap items-center gap-1">{children}</span>
  </div>
));
Row.displayName = 'EditorSettingsRow';

const FontSize: FC<{size: number; current: number}> = memo(({size, current}) => {
  const onClick = useCallback(() => setEditorSettings({fontSize: size}), [size]);
  return (
    <button
      aria-pressed={size === current}
      className={`font-code ${segment(size === current)}`}
      onClick={onClick}
      type="button">
      {size}
    </button>
  );
});
FontSize.displayName = 'FontSizeChoice';

const Keymap: FC<{keymap: EditorKeymap; current: EditorKeymap; label: string}> = memo(({keymap, current, label}) => {
  const onClick = useCallback(() => setEditorSettings({keymap}), [keymap]);
  return (
    <button aria-pressed={keymap === current} className={segment(keymap === current)} onClick={onClick} type="button">
      {label}
    </button>
  );
});
Keymap.displayName = 'KeymapChoice';

export const EditorSettingsForm: FC = memo(() => {
  const settings = useEditorSettings();
  const scroll = useCallback(() => setEditorSettings({wrap: false}), []);
  const wrap = useCallback(() => setEditorSettings({wrap: true}), []);
  return (
    <div className="space-y-3">
      <Row label="Font size">
        {FONT_SIZES.map(size => (
          <FontSize current={settings.fontSize} key={size} size={size} />
        ))}
        <span className="text-ink-400 ml-1 text-[11px]">px</span>
      </Row>
      <Row label="Long lines">
        <button aria-pressed={!settings.wrap} className={segment(!settings.wrap)} onClick={scroll} type="button">
          scroll sideways
        </button>
        <button aria-pressed={settings.wrap} className={segment(settings.wrap)} onClick={wrap} type="button">
          wrap
        </button>
      </Row>
      <Row label="Key bindings">
        <Keymap current={settings.keymap} keymap="default" label="default" />
        <Keymap current={settings.keymap} keymap="vim" label="Vim" />
      </Row>
      <p className="text-ink-400 text-[11px]">
        Vim adds a status line under the editor for its modes and <code className="font-code">:</code> commands;{' '}
        {MAC ? '⌘⏎' : 'Ctrl+⏎'} still submits and {MAC ? "⌘'" : "Ctrl+'"} still runs. Settings apply to every editor at
        once and are remembered in this browser.
      </p>
    </div>
  );
});
EditorSettingsForm.displayName = 'EditorSettingsForm';

export const GearIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={13} stroke="currentColor" strokeWidth={1.5} viewBox="0 0 16 16" width={13}>
    <circle cx={8} cy={8} r={2.25} />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
));
GearIcon.displayName = 'GearIcon';
