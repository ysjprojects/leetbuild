import {
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

/**
 * A `<select>` in the playground's palette. The native control's popup ignores the theme (the
 * screenshot that prompted this: a white system list over a Night dialog), so the list is drawn
 * here, the way the toolbar menus are: a pill, and under it a panel of options with the chosen one
 * ticked. Follows the WAI-ARIA select-only combobox pattern: the pill keeps focus, arrows move the
 * highlight, Enter or Space pick, Escape or a click outside close, typing jumps to a match.
 */

export interface SelectOption {
  value: string;
  label: string;
}

const Chevron: FC = memo(() => (
  <svg aria-hidden fill="none" height={10} stroke="currentColor" strokeWidth={1.8} viewBox="0 0 10 10" width={10}>
    <path d="m2.5 3.75 2.5 2.5 2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
));
Chevron.displayName = 'SelectChevron';

const Tick: FC = memo(() => (
  <svg aria-hidden fill="none" height={12} stroke="currentColor" strokeWidth={2} viewBox="0 0 12 12" width={12}>
    <path d="m2.5 6.5 2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
));
Tick.displayName = 'SelectTick';

const Option: FC<{
  option: SelectOption;
  id: string;
  selected: boolean;
  active: boolean;
  onPick: (value: string) => void;
  onHover: (value: string) => void;
}> = memo(({option, id, selected, active, onPick, onHover}) => {
  const onClick = useCallback(() => onPick(option.value), [onPick, option.value]);
  const onMouseMove = useCallback(() => onHover(option.value), [onHover, option.value]);
  return (
    <li
      aria-selected={selected}
      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12px] transition ${
        active ? 'bg-ink-700 text-ink-50' : 'text-ink-200'
      }`}
      id={id}
      onClick={onClick}
      onMouseMove={onMouseMove}
      role="option">
      <span className={selected ? 'font-semibold' : ''}>{option.label}</span>
      <span className={`text-iris-300 ${selected ? '' : 'invisible'}`}>
        <Tick />
      </span>
    </li>
  );
});
Option.displayName = 'SelectOption';

export const Select: FC<{
  /** What the control chooses, for assistive tech and the tooltip: "language". */
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Which edge of the pill the panel hangs from (default left). */
  align?: 'left' | 'right';
  className?: string;
}> = memo(({label, value, options, onChange, align = 'left', className = ''}) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const optionId = useCallback((v: string) => `${listId}-${v}`, [listId]);
  const current = options.find(o => o.value === value) ?? options[0];

  const openList = useCallback(() => {
    setActive(value);
    setOpen(true);
  }, [value]);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  const pick = useCallback(
    (v: string) => {
      if (v !== value) onChange(v);
      close();
    },
    [value, onChange, close],
  );
  const toggle = useCallback(() => (open ? close() : openList()), [open, close, openList]);

  // Closes on a click outside; the pill's own keydown handles everything else, so focus never leaves it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({block: 'nearest'});
  }, [open, active, optionId]);

  const typed = useRef({text: '', at: 0});
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const index = options.findIndex(o => o.value === active);
      const move = (to: number): void => setActive(options[(to + options.length) % options.length].value);
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openList();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          move(index + 1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          move(index - 1);
          return;
        case 'Home':
          e.preventDefault();
          move(0);
          return;
        case 'End':
          e.preventDefault();
          move(options.length - 1);
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          pick(active);
          return;
        case 'Escape':
          e.preventDefault();
          close();
          return;
        case 'Tab':
          setOpen(false);
          return;
        default:
      }
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
      // Type to jump: letters typed within a second accumulate; the match after the highlight wins, wrapping.
      const now = Date.now();
      const text = (now - typed.current.at < 1000 ? typed.current.text : '') + e.key.toLowerCase();
      typed.current = {text, at: now};
      const from = text.length === 1 ? index + 1 : index;
      for (let i = 0; i < options.length; i++) {
        const candidate = options[(from + i) % options.length];
        if (candidate.label.toLowerCase().startsWith(text)) {
          setActive(candidate.value);
          return;
        }
      }
    },
    [open, options, active, openList, pick, close],
  );

  return (
    <div className={`relative inline-block ${className}`} ref={root}>
      <button
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className={`border-ink-600 bg-ink-800 font-code text-ink-100 hover:border-ink-500 focus:border-iris-400 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition focus:outline-none ${
          open ? 'border-iris-400' : ''
        }`}
        onClick={toggle}
        onKeyDown={onKeyDown}
        ref={button}
        role="combobox"
        title={label}
        type="button">
        <span>{current.label}</span>
        <span className={`text-ink-400 transition ${open ? 'rotate-180' : ''}`}>
          <Chevron />
        </span>
      </button>
      {open ? (
        <ul
          aria-label={label}
          className={`border-ink-600 bg-ink-800 absolute top-full z-40 mt-1.5 min-w-[9rem] rounded-xl border p-1.5 shadow-2xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          id={listId}
          role="listbox">
          {options.map(o => (
            <Option
              active={o.value === active}
              id={optionId(o.value)}
              key={o.value}
              onHover={setActive}
              onPick={pick}
              option={o}
              selected={o.value === value}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
});
Select.displayName = 'Select';
