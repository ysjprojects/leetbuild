import {
  type ChangeEvent,
  type CSSProperties,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type BoxShape,
  type Handle,
  type Hue,
  type LineShape,
  type PenShape,
  type Point,
  type Rect,
  type Shape,
  type TextShape,
  type Tool,
  type View,
  attach,
  constrainAngle,
  DEFAULT_BOX,
  DEFAULT_VIEW,
  exportPng,
  fitView,
  fromDiagram,
  handleAt,
  hitTest,
  HUE_LABEL,
  hueColor,
  HUES,
  inRect,
  isBox,
  isLine,
  MAX_SCALE,
  measureText,
  MIN_SCALE,
  normalizeRect,
  render,
  snap,
  textSize,
  toScreen,
  toWorld,
  translate,
  uid,
  WIDTHS,
  withHandle,
  zoomAt,
} from '@/lib/scratchpad';
import {useDocumentTheme} from '@/lib/theme';
import type {Problem} from '@/lib/types';
import {useMediaQuery} from '@/lib/useMediaQuery';
import {PALETTE} from '@/styles/palette';

import {useDialog} from './Dialog';
import {isEditable, MAC, mod} from './Shortcuts';

/**
 * The scratchpad: a floating whiteboard over the playground (drag it by its title bar, resize it
 * from the corner, maximise it) for sketching the system while building it. Non-modal, so the task
 * and the editor stay readable and usable beside it. One sketch per course, persisted by the
 * playground; the model, geometry and rendering live in lib/scratchpad.ts.
 */

const FRAME_KEY = 'leetbuild:scratchpad';
/** Below `lg` the window is the whole viewport. */
const NARROW = '(max-width: 1023px)';
const HISTORY_LIMIT = 80;
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, Shape> = new Map();

const screenPoint = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
  const rect = e.currentTarget.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
};

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Viewport {
  w: number;
  h: number;
}

const MIN_FRAME: Viewport = {w: 420, h: 280};
/** A window this small is not one the learner is looking at (hidden tab, mid-rotation): ignore it. */
const USABLE_VIEWPORT: Viewport = {w: 240, h: 160};

const currentViewport = (): Viewport | null =>
  window.innerWidth >= USABLE_VIEWPORT.w && window.innerHeight >= USABLE_VIEWPORT.h
    ? {w: window.innerWidth, h: window.innerHeight}
    : null;

/** `f` kept inside `vp`: at least the minimum size, no larger than the viewport, fully on screen. */
const clampFrame = (f: Frame, vp: Viewport): Frame => {
  const w = Math.min(Math.max(MIN_FRAME.w, f.w), vp.w);
  const h = Math.min(Math.max(MIN_FRAME.h, f.h), vp.h);
  return {
    w,
    h,
    x: Math.round(Math.min(Math.max(0, f.x), vp.w - w)),
    y: Math.round(Math.min(Math.max(0, f.y), vp.h - h)),
  };
};

const defaultFrame = (vp: Viewport): Frame => {
  const w = Math.min(vp.w - 32, Math.max(640, Math.round(vp.w * 0.66)));
  const h = Math.min(vp.h - 32, Math.max(420, Math.round(vp.h * 0.72)));
  return clampFrame({x: (vp.w - w) / 2, y: (vp.h - h) / 2, w, h}, vp);
};

const loadFrame = (): Frame => {
  try {
    const raw = window.localStorage.getItem(FRAME_KEY);
    if (raw !== null) {
      const f = JSON.parse(raw) as Partial<Frame>;
      if ([f.x, f.y, f.w, f.h].every(v => typeof v === 'number' && Number.isFinite(v))) return f as Frame;
    }
  } catch {
    // storage unavailable: the default geometry
  }
  return defaultFrame(currentViewport() ?? {w: 1280, h: 800});
};

// ---- toolbar -------------------------------------------------------------------------------------

interface ToolSpec {
  tool: Tool;
  key: string;
  label: string;
  icon: ReactNode;
}

const TOOLS: readonly ToolSpec[] = [
  {tool: 'select', key: 'V', label: 'Select', icon: <path d="M3.5 2.5l9 5.5-4 1-2 3.5z" />},
  {
    tool: 'hand',
    key: 'H',
    label: 'Pan',
    icon: (
      <path d="M6 8.5V3.5a1 1 0 0 1 2 0V7m0-3.5a1 1 0 0 1 2 0V7m0-2.5a1 1 0 0 1 2 0v5a4 4 0 0 1-4 4H7.5a4 4 0 0 1-3.3-1.8L2.6 9.3a1 1 0 0 1 1.7-1.1L6 10" />
    ),
  },
  {tool: 'pen', key: 'P', label: 'Pen', icon: <path d="M3 13l1-3.5L11.5 2 14 4.5 6.5 12 3 13zm6.5-9L12 6.5" />},
  {tool: 'rect', key: 'R', label: 'Box', icon: <rect height={9} rx={1.5} width={11} x={2.5} y={3.5} />},
  {tool: 'ellipse', key: 'O', label: 'Ellipse', icon: <ellipse cx={8} cy={8} rx={5.5} ry={4.5} />},
  {tool: 'diamond', key: 'D', label: 'Diamond', icon: <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />},
  {tool: 'arrow', key: 'A', label: 'Arrow', icon: <path d="M3 13L13 3m0 0H7.5M13 3v5.5" />},
  {tool: 'line', key: 'L', label: 'Line', icon: <path d="M3 13L13 3" />},
  {tool: 'text', key: 'T', label: 'Text', icon: <path d="M3.5 4.5V3h9v1.5M8 3v10M6 13h4" />},
  {tool: 'eraser', key: 'E', label: 'Eraser', icon: <path d="M2.5 10.5l6-6 4.5 4.5-3.5 3.5H6l-3.5-2zm7-4L13 10" />},
];

const TOOL_CURSOR: Record<Tool, string> = {
  select: 'default',
  hand: 'grab',
  pen: 'crosshair',
  rect: 'crosshair',
  ellipse: 'crosshair',
  diamond: 'crosshair',
  arrow: 'crosshair',
  line: 'crosshair',
  text: 'text',
  eraser: 'cell',
};

const WHEEL = MAC ? '⌘ + wheel' : 'Ctrl + wheel';

const HINTS: Record<Tool, string> = {
  select: `drag to move · corners resize · drag empty space to select several · double-click to edit text · ${WHEEL} zooms`,
  hand: `drag to pan · wheel scrolls · ${WHEEL} zooms`,
  pen: 'draw freehand · space + drag pans',
  rect: 'drag to draw a box, or click to place one and type its label · ⇧ keeps it square',
  ellipse: 'drag to draw, or click to place one and type its label · ⇧ keeps it round',
  diamond: 'drag to draw, or click to place one and type its label',
  arrow:
    'drag from one box to another: the ends attach to their outlines · ⇧ snaps to 45° · double-click it later to label it',
  line: 'drag to draw · ⇧ snaps to 45° · double-click it later to label it',
  text: `click to place text · Esc or ${mod('⏎')} finishes · ⏎ for a new line`,
  eraser: 'click or sweep over shapes to remove them',
};

const iconButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-30';
const quietButton = `${iconButton} text-ink-300 hover:bg-ink-800 hover:text-ink-50`;
const activeButton = `${iconButton} bg-iris-400/20 text-iris-200`;

const Icon: FC<{children: ReactNode}> = memo(({children}) => (
  <svg
    aria-hidden
    fill="none"
    height={15}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.6}
    viewBox="0 0 16 16"
    width={15}>
    {children}
  </svg>
));
Icon.displayName = 'ScratchpadIcon';

const ToolButton: FC<{spec: ToolSpec; active: boolean; onPick: (tool: Tool) => void}> = memo(
  ({spec, active, onPick}) => {
    const onClick = useCallback(() => onPick(spec.tool), [onPick, spec.tool]);
    return (
      <button
        aria-label={spec.label}
        aria-pressed={active}
        className={active ? activeButton : quietButton}
        onClick={onClick}
        title={`${spec.label} (${spec.key})`}
        type="button">
        <Icon>{spec.icon}</Icon>
      </button>
    );
  },
);
ToolButton.displayName = 'ToolButton';

const Swatch: FC<{hue: Hue; color: string; active: boolean; onPick: (hue: Hue) => void}> = memo(
  ({hue, color, active, onPick}) => {
    const onClick = useCallback(() => onPick(hue), [onPick, hue]);
    const style = useMemo(() => ({background: color}), [color]);
    return (
      <button
        aria-label={`colour: ${HUE_LABEL[hue]}`}
        aria-pressed={active}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition ${
          active ? 'ring-iris-400 ring-2 ring-offset-2 ring-offset-[var(--lb-panel)]' : 'hover:scale-110'
        }`}
        onClick={onClick}
        title={HUE_LABEL[hue]}
        type="button">
        <span className="block h-3.5 w-3.5 rounded-full" style={style} />
      </button>
    );
  },
);
Swatch.displayName = 'Swatch';

const WidthButton: FC<{width: number; active: boolean; onPick: (width: number) => void}> = memo(
  ({width, active, onPick}) => {
    const onClick = useCallback(() => onPick(width), [onPick, width]);
    const style = useMemo(() => ({width: width * 1.8 + 2, height: width * 1.8 + 2}), [width]);
    return (
      <button
        aria-label={`stroke width ${width}`}
        aria-pressed={active}
        className={active ? activeButton : quietButton}
        onClick={onClick}
        title={width <= 2 ? 'thin' : width <= 3.5 ? 'regular' : 'bold'}
        type="button">
        <span className="block rounded-full bg-current" style={style} />
      </button>
    );
  },
);
WidthButton.displayName = 'WidthButton';

const Separator: FC = memo(() => <span aria-hidden className="bg-ink-700 mx-1 h-5 w-px shrink-0" />);
Separator.displayName = 'ScratchpadSeparator';

// ---- the window ----------------------------------------------------------------------------------

interface History {
  past: Shape[][];
  present: Shape[];
  future: Shape[][];
}

type Gesture =
  | {type: 'draw'}
  | {type: 'box'; ax: number; ay: number}
  | {type: 'line'; ax: number; ay: number}
  | {type: 'move'; sx: number; sy: number; origin: Shape[]; moved: boolean}
  | {type: 'handle'; id: string; handle: Handle; origin: Shape}
  | {type: 'marquee'; ax: number; ay: number}
  | {type: 'pan'; sx: number; sy: number; view: View}
  | {type: 'erase'}
  | {type: 'text'; wx: number; wy: number};

interface Editing {
  id: string;
  /** A text being placed: it joins the sketch only once something is typed. */
  fresh: boolean;
}

interface Props {
  problem: Problem | null;
  /** The persisted sketch this window opens with. */
  shapes: readonly Shape[];
  /** Every committed change (also undo and redo). */
  onChange: (shapes: Shape[]) => void;
  onClose: () => void;
}

const Scratchpad: FC<Props> = memo(({problem, shapes: initial, onChange, onClose}) => {
  const theme = useDocumentTheme();
  const narrow = useMediaQuery(NARROW);
  const palette = PALETTE[theme];
  const [dialog, openDialog] = useDialog();

  // Window geometry: `frame` is where the learner left the window; what is shown is that frame kept
  // inside the current viewport. Clamping never writes back, so a transient zero-size viewport (a
  // background tab, an orientation change) cannot shrink the saved frame for good.
  const [frame, setFrame] = useState<Frame>(loadFrame);
  const [viewport, setViewport] = useState<Viewport>(() => currentViewport() ?? {w: 1280, h: 800});
  const [maximized, setMaximized] = useState(false);
  const full = maximized || narrow;
  const shown = useMemo(() => clampFrame(frame, viewport), [frame, viewport]);
  useEffect(() => {
    try {
      window.localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
    } catch {
      // storage disabled: the geometry just does not persist
    }
  }, [frame]);
  useEffect(() => {
    const onResize = (): void => {
      const next = currentViewport();
      if (next !== null) setViewport(next);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Sketch, settings and view.
  const [history, setHistory] = useState<History>(() => ({past: [], present: [...initial], future: []}));
  const historyRef = useRef(history);
  const shapes = history.present;
  const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_SET);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const viewRef = useRef(view);
  const [tool, setTool] = useState<Tool>('select');
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [hue, setHue] = useState<Hue>('ink');
  const hueRef = useRef(hue);
  hueRef.current = hue;
  const [width, setWidth] = useState(WIDTHS[0]);
  const widthRef = useRef(width);
  widthRef.current = width;
  const [fill, setFill] = useState(false);
  const fillRef = useRef(fill);
  fillRef.current = fill;
  const [grid, setGrid] = useState(true);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [draftText, setDraftText] = useState('');
  const draftTextRef = useRef(draftText);
  draftTextRef.current = draftText;
  const [size, setSize] = useState({w: 1, h: 1});
  const sizeRef = useRef(size);
  const [cursor, setCursor] = useState<string | null>(null);

  // Gesture scratch: never rendered through React, painted straight to the canvas.
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<Shape | null>(null);
  const overridesRef = useRef<ReadonlyMap<string, Shape>>(EMPTY_MAP);
  const marqueeRef = useRef<Rect | null>(null);
  const erasingRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const pendingRef = useRef<TextShape | null>(null);
  const spaceRef = useRef(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas === null || ctx === null || ctx === undefined) return;
    const {w, h} = sizeRef.current;
    render(ctx, w, h, window.devicePixelRatio || 1, {
      shapes: historyRef.current.present,
      overrides: overridesRef.current,
      draft: draftRef.current,
      selection: selectionRef.current,
      erasing: erasingRef.current,
      editing: editingRef.current?.id ?? null,
      marquee: marqueeRef.current,
      view: viewRef.current,
      theme: themeRef.current,
      grid: gridRef.current,
    });
  }, []);

  useEffect(() => {
    redraw();
  }, [shapes, selection, view, theme, grid, editing, size, redraw]);

  // The canvas follows its host's size at device resolution.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;
    const observer = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      sizeRef.current = {w, h};
      setSize({w, h});
      redraw();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [redraw]);

  // Wheel: scroll pans, ⌘/Ctrl (and trackpad pinch) zooms. Registered natively: React's wheel listener is passive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) setView(v => zoomAt(v, sx, sy, Math.exp(-e.deltaY * 0.01)));
      else {
        const k = e.deltaMode === 1 ? 16 : 1;
        setView(v => ({...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k}));
      }
    };
    canvas.addEventListener('wheel', onWheel, {passive: false});
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    rootRef.current?.focus({preventScroll: true});
  }, []);

  // ---- history ---------------------------------------------------------------------------------

  const apply = useCallback(
    (next: History) => {
      historyRef.current = next;
      setHistory(next);
      onChange(next.present);
    },
    [onChange],
  );
  const commit = useCallback(
    (present: Shape[]) => {
      const h = historyRef.current;
      apply({past: [...h.past.slice(-(HISTORY_LIMIT - 1)), h.present], present, future: []});
    },
    [apply],
  );
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;
    apply({past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future]});
  }, [apply]);
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;
    apply({past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1)});
  }, [apply]);

  // ---- text editing ----------------------------------------------------------------------------

  const startEditing = useCallback((shape: Shape) => {
    if (shape.kind === 'pen') return;
    setDraftText(shape.kind === 'text' ? shape.text : shape.label);
    setEditing({id: shape.id, fresh: false});
    setSelection(new Set([shape.id]));
  }, []);

  const placeText = useCallback((wx: number, wy: number) => {
    const size = textSize(widthRef.current);
    const on = gridRef.current;
    pendingRef.current = {
      id: uid(),
      kind: 'text',
      hue: hueRef.current,
      width: widthRef.current,
      x: snap(wx, on),
      y: snap(wy, on),
      text: '',
      size,
      w: 0,
      h: 0,
    };
    setDraftText('');
    setEditing({id: pendingRef.current.id, fresh: true});
  }, []);

  const commitEdit = useCallback(() => {
    const ed = editingRef.current;
    if (ed === null) return;
    const text = draftTextRef.current;
    const present = historyRef.current.present;
    setEditing(null);
    editingRef.current = null;
    if (ed.fresh) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null && text.trim() !== '') {
        const shape: TextShape = {...pending, text, ...measureText(text, pending.size)};
        commit([...present, shape]);
        setSelection(new Set([shape.id]));
      }
      setTool('select');
      return;
    }
    const target = present.find(s => s.id === ed.id);
    if (target === undefined) return;
    if (target.kind === 'text') {
      if (text.trim() === '') commit(present.filter(s => s.id !== ed.id));
      else if (text !== target.text)
        commit(present.map(s => (s.id === ed.id ? {...target, text, ...measureText(text, target.size)} : s)));
    } else if ((isBox(target) || isLine(target)) && text !== target.label)
      commit(present.map(s => (s.id === ed.id ? {...target, label: text} : s)));
  }, [commit]);

  const onDraftText = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => setDraftText(e.currentTarget.value), []);
  const onEditorKey = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        commitEdit();
      }
    },
    [commitEdit],
  );

  // ---- operations on the selection -------------------------------------------------------------

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.size === 0) return;
    commit(historyRef.current.present.filter(s => !sel.has(s.id)));
    setSelection(EMPTY_SET);
  }, [commit]);

  const duplicate = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.size === 0) return;
    const copies = historyRef.current.present
      .filter(s => sel.has(s.id))
      .map(s => ({...translate(s, 24, 24), id: uid()}));
    commit([...historyRef.current.present, ...copies]);
    setSelection(new Set(copies.map(s => s.id)));
  }, [commit]);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      commit(historyRef.current.present.map(s => (sel.has(s.id) ? translate(s, dx, dy) : s)));
    },
    [commit],
  );

  const zoomBy = useCallback((factor: number) => {
    const {w, h} = sizeRef.current;
    setView(v => zoomAt(v, w / 2, h / 2, factor));
  }, []);
  const zoomIn = useCallback(() => zoomBy(1.25), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(0.8), [zoomBy]);
  const fit = useCallback(() => {
    const {w, h} = sizeRef.current;
    setView(fitView(historyRef.current.present, w, h));
  }, []);

  const clear = useCallback(() => {
    if (historyRef.current.present.length === 0) return;
    void openDialog({
      title: 'Clear the scratchpad?',
      body: 'Every shape goes; undo brings them back until the window is closed.',
      confirm: 'Clear',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      commit([]);
      setSelection(EMPTY_SET);
    });
  }, [openDialog, commit]);

  const loadDiagram = useCallback(() => {
    if (problem === null) return;
    const load = (): void => {
      const next = fromDiagram(problem);
      commit(next);
      setSelection(EMPTY_SET);
      const {w, h} = sizeRef.current;
      setView(fitView(next, w, h));
      setTool('select');
    };
    if (historyRef.current.present.length === 0) {
      load();
      return;
    }
    void openDialog({
      title: 'Start from the course diagram?',
      body: `The sketch is replaced by ${problem.title}'s architecture — its boxes and arrows, editable. Undo brings the current sketch back.`,
      confirm: 'Replace',
      danger: true,
    }).then(ok => {
      if (ok) load();
    });
  }, [problem, openDialog, commit]);

  const download = useCallback(() => {
    void exportPng(historyRef.current.present, themeRef.current).then(blob => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leetbuild-scratchpad-${problem?.id ?? 'notes'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }, [problem]);

  const close = useCallback(() => {
    commitEdit();
    onClose();
  }, [commitEdit, onClose]);

  const toggleMaximized = useCallback(() => setMaximized(v => !v), []);
  const toggleGrid = useCallback(() => setGrid(v => !v), []);
  const toggleFill = useCallback(() => {
    setFill(v => !v);
    // Applies to the selected boxes too, so a box can be tinted after the fact.
    const sel = selectionRef.current;
    const present = historyRef.current.present;
    if (present.some(s => sel.has(s.id) && isBox(s))) {
      const next = !fillRef.current;
      commit(present.map(s => (sel.has(s.id) && isBox(s) ? {...s, fill: next} : s)));
    }
  }, [commit]);
  const pickHue = useCallback(
    (next: Hue) => {
      setHue(next);
      const sel = selectionRef.current;
      const present = historyRef.current.present;
      if (present.some(s => sel.has(s.id))) commit(present.map(s => (sel.has(s.id) ? {...s, hue: next} : s)));
    },
    [commit],
  );
  const pickWidth = useCallback(
    (next: number) => {
      setWidth(next);
      const sel = selectionRef.current;
      const present = historyRef.current.present;
      if (present.some(s => sel.has(s.id)))
        commit(
          present.map(s =>
            sel.has(s.id)
              ? s.kind === 'text'
                ? {...s, width: next, size: textSize(next), ...measureText(s.text, textSize(next))}
                : {...s, width: next}
              : s,
          ),
        );
    },
    [commit],
  );
  const pickTool = useCallback((next: Tool) => {
    setTool(next);
    rootRef.current?.focus({preventScroll: true});
  }, []);

  // ---- pointer gestures on the canvas ----------------------------------------------------------

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (e.button !== 0 && e.button !== 1) return;
      if (editingRef.current !== null) commitEdit();
      rootRef.current?.focus({preventScroll: true});
      const [sx, sy] = screenPoint(e);
      const v = viewRef.current;
      const [wx, wy] = toWorld(v, sx, sy);
      const on = gridRef.current;
      const t = toolRef.current;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (e.button === 1 || spaceRef.current || t === 'hand') {
        gestureRef.current = {type: 'pan', sx, sy, view: v};
        setCursor('grabbing');
        return;
      }
      const present = historyRef.current.present;
      const tol = 6 / v.scale;
      const base = {id: uid(), hue: hueRef.current, width: widthRef.current};
      switch (t) {
        case 'select': {
          const sel = selectionRef.current;
          if (sel.size === 1) {
            const only = present.find(s => sel.has(s.id));
            const handle = only === undefined ? null : handleAt(only, v, sx, sy);
            if (only !== undefined && handle !== null) {
              gestureRef.current = {type: 'handle', id: only.id, handle, origin: only};
              return;
            }
          }
          const hit = hitTest(present, wx, wy, tol);
          if (hit !== null) {
            let next: ReadonlySet<string>;
            if (e.shiftKey) {
              const s = new Set(sel);
              if (s.has(hit.id)) s.delete(hit.id);
              else s.add(hit.id);
              next = s;
            } else next = sel.has(hit.id) ? sel : new Set([hit.id]);
            selectionRef.current = next;
            setSelection(next);
            gestureRef.current = {
              type: 'move',
              sx: wx,
              sy: wy,
              origin: present.filter(s => next.has(s.id)),
              moved: false,
            };
            setCursor('grabbing');
          } else {
            if (!e.shiftKey && sel.size > 0) {
              selectionRef.current = EMPTY_SET;
              setSelection(EMPTY_SET);
            }
            gestureRef.current = {type: 'marquee', ax: wx, ay: wy};
            marqueeRef.current = {x: wx, y: wy, w: 0, h: 0};
          }
          break;
        }
        case 'pen':
          draftRef.current = {...base, kind: 'pen', points: [[wx, wy]]};
          gestureRef.current = {type: 'draw'};
          break;
        case 'rect':
        case 'ellipse':
        case 'diamond': {
          const x = snap(wx, on);
          const y = snap(wy, on);
          draftRef.current = {...base, kind: t, x, y, w: 0, h: 0, fill: fillRef.current, label: ''};
          gestureRef.current = {type: 'box', ax: x, ay: y};
          break;
        }
        case 'arrow':
        case 'line': {
          const x = snap(wx, on);
          const y = snap(wy, on);
          draftRef.current = {...base, kind: t, x1: x, y1: y, x2: x, y2: y, label: ''};
          gestureRef.current = {type: 'line', ax: x, ay: y};
          break;
        }
        case 'text':
          // The editor opens on release: a textarea focused during pointerdown loses focus again to the
          // browser's own mousedown handling, which would commit it empty.
          gestureRef.current = {type: 'text', wx, wy};
          return;
        case 'eraser': {
          const erasing = new Set<string>();
          const hit = hitTest(present, wx, wy, tol);
          if (hit !== null) erasing.add(hit.id);
          erasingRef.current = erasing;
          gestureRef.current = {type: 'erase'};
          break;
        }
        default:
          return;
      }
      redraw();
    },
    [commitEdit, redraw],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (g === null) return;
      const [sx, sy] = screenPoint(e);
      const v = viewRef.current;
      const [wx, wy] = toWorld(v, sx, sy);
      const on = gridRef.current;
      const present = historyRef.current.present;
      switch (g.type) {
        case 'pan':
          viewRef.current = {...g.view, x: g.view.x + (sx - g.sx), y: g.view.y + (sy - g.sy)};
          break;
        case 'draw': {
          const d = draftRef.current as PenShape;
          const last = d.points[d.points.length - 1];
          if (Math.hypot(wx - last[0], wy - last[1]) >= 1.5 / v.scale) d.points.push([wx, wy]);
          break;
        }
        case 'box': {
          const d = draftRef.current as BoxShape;
          let w = snap(wx, on) - g.ax;
          let h = snap(wy, on) - g.ay;
          if (e.shiftKey) {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = (w < 0 ? -1 : 1) * m;
            h = (h < 0 ? -1 : 1) * m;
          }
          draftRef.current = {...d, w, h};
          break;
        }
        case 'line': {
          const d = draftRef.current as LineShape;
          let x = snap(wx, on);
          let y = snap(wy, on);
          if (e.shiftKey) [x, y] = constrainAngle(g.ax, g.ay, x, y);
          const [x2, y2] = attach(present, x, y, g.ax, g.ay);
          const [x1, y1] = attach(present, g.ax, g.ay, x2, y2);
          draftRef.current = {...d, x1, y1, x2, y2};
          break;
        }
        case 'move': {
          const dx = wx - g.sx;
          const dy = wy - g.sy;
          if (!g.moved && Math.hypot(dx, dy) * v.scale < 2) return;
          g.moved = true;
          const overrides = new Map<string, Shape>();
          for (const s of g.origin) overrides.set(s.id, translate(s, snap(dx, on), snap(dy, on)));
          overridesRef.current = overrides;
          break;
        }
        case 'handle': {
          let x = snap(wx, on);
          let y = snap(wy, on);
          if (isLine(g.origin)) {
            const [ox, oy]: Point = g.handle === 'a' ? [g.origin.x2, g.origin.y2] : [g.origin.x1, g.origin.y1];
            [x, y] = attach(
              present.filter(s => s.id !== g.id),
              x,
              y,
              ox,
              oy,
            );
          }
          overridesRef.current = new Map([[g.id, withHandle(g.origin, g.handle, x, y)]]);
          break;
        }
        case 'marquee':
          marqueeRef.current = normalizeRect(g.ax, g.ay, wx - g.ax, wy - g.ay);
          break;
        case 'erase': {
          const hit = hitTest(present, wx, wy, 6 / v.scale);
          if (hit !== null && !erasingRef.current.has(hit.id))
            erasingRef.current = new Set([...erasingRef.current, hit.id]);
          break;
        }
        default:
          return;
      }
      redraw();
    },
    [redraw],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (g === null) return;
      gestureRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      setCursor(spaceRef.current ? 'grab' : null);
      const present = historyRef.current.present;
      switch (g.type) {
        case 'pan':
          setView(viewRef.current);
          break;
        case 'draw': {
          const d = draftRef.current;
          draftRef.current = null;
          if (d !== null) commit([...present, d]);
          break;
        }
        case 'box': {
          const d = draftRef.current as BoxShape;
          draftRef.current = null;
          const placed = Math.abs(d.w) < 4 && Math.abs(d.h) < 4;
          const box: BoxShape = placed
            ? {...d, x: d.x - DEFAULT_BOX.w / 2, y: d.y - DEFAULT_BOX.h / 2, w: DEFAULT_BOX.w, h: DEFAULT_BOX.h}
            : {...d, ...normalizeRect(d.x, d.y, d.w, d.h)};
          commit([...present, box]);
          setSelection(new Set([box.id]));
          setTool('select');
          if (placed) {
            setDraftText('');
            setEditing({id: box.id, fresh: false});
          }
          break;
        }
        case 'line': {
          const d = draftRef.current as LineShape;
          draftRef.current = null;
          if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 4) {
            commit([...present, d]);
            setSelection(new Set([d.id]));
          }
          setTool('select');
          break;
        }
        case 'move': {
          const overrides = overridesRef.current;
          overridesRef.current = EMPTY_MAP;
          if (g.moved && overrides.size > 0) commit(present.map(s => overrides.get(s.id) ?? s));
          break;
        }
        case 'handle': {
          const next = overridesRef.current.get(g.id);
          overridesRef.current = EMPTY_MAP;
          if (next !== undefined) commit(present.map(s => (s.id === g.id ? next : s)));
          break;
        }
        case 'marquee': {
          const m = marqueeRef.current;
          marqueeRef.current = null;
          if (m !== null && (m.w > 2 || m.h > 2)) {
            const ids = present.filter(s => inRect(s, m)).map(s => s.id);
            setSelection(e.shiftKey ? new Set([...selectionRef.current, ...ids]) : new Set(ids));
          }
          break;
        }
        case 'text':
          placeText(g.wx, g.wy);
          break;
        case 'erase': {
          const ids = erasingRef.current;
          erasingRef.current = EMPTY_SET;
          if (ids.size > 0) {
            commit(present.filter(s => !ids.has(s.id)));
            setSelection(new Set([...selectionRef.current].filter(id => !ids.has(id))));
          }
          break;
        }
        default:
          break;
      }
      redraw();
    },
    [commit, placeText, redraw],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const t = toolRef.current;
      if (t !== 'select' && t !== 'hand') return;
      const rect = e.currentTarget.getBoundingClientRect();
      const v = viewRef.current;
      const [wx, wy] = toWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      const hit = hitTest(historyRef.current.present, wx, wy, 6 / v.scale);
      if (hit !== null) startEditing(hit);
      else placeText(wx, wy);
    },
    [startEditing, placeText],
  );

  // ---- keyboard --------------------------------------------------------------------------------

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isEditable(e.target)) return;
      // A focused toolbar button keeps Space and Enter for itself.
      if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
      const modKey = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const handled = (): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (modKey && key === 'z') {
        handled();
        if (e.shiftKey) redo();
        else undo();
      } else if (modKey && key === 'y') {
        handled();
        redo();
      } else if (modKey && key === 'a') {
        handled();
        setSelection(new Set(historyRef.current.present.map(s => s.id)));
      } else if (modKey && key === 'd') {
        handled();
        duplicate();
      } else if (modKey) {
        // ⌘; and the other playground shortcuts keep working from inside the window.
      } else if (e.key === ' ') {
        handled();
        if (!spaceRef.current) {
          spaceRef.current = true;
          setCursor('grab');
        }
      } else if (e.key === 'Escape') {
        handled();
        if (selectionRef.current.size > 0) setSelection(EMPTY_SET);
        else close();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        handled();
        deleteSelection();
      } else if (e.key === 'Enter') {
        const sel = selectionRef.current;
        const only = sel.size === 1 ? historyRef.current.present.find(s => sel.has(s.id)) : undefined;
        if (only !== undefined && only.kind !== 'pen') {
          handled();
          startEditing(only);
        }
      } else if (e.key.startsWith('Arrow')) {
        if (selectionRef.current.size === 0) return;
        handled();
        const step = e.shiftKey ? 10 : 1;
        nudge(
          e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
          e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
        );
      } else if (e.key === '+' || e.key === '=') {
        handled();
        zoomIn();
      } else if (e.key === '-') {
        handled();
        zoomOut();
      } else if (e.key === '0') {
        handled();
        setView(DEFAULT_VIEW);
      } else if (key === 'g') {
        handled();
        toggleGrid();
      } else if (key === 'f' && !e.altKey) {
        handled();
        fit();
      } else if (!e.altKey) {
        const spec = TOOLS.find(s => s.key.toLowerCase() === key);
        if (spec !== undefined) {
          handled();
          setTool(spec.tool);
        }
      }
    },
    [undo, redo, duplicate, close, deleteSelection, startEditing, nudge, zoomIn, zoomOut, toggleGrid, fit],
  );

  const onKeyUp = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ') {
      spaceRef.current = false;
      if (gestureRef.current === null) setCursor(null);
    }
  }, []);

  // ---- window drag & resize --------------------------------------------------------------------

  const dragRef = useRef<{sx: number; sy: number; frame: Frame; resize: boolean} | null>(null);
  const onBarDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (full || e.button !== 0 || (e.target as HTMLElement).closest('button') !== null) return;
      dragRef.current = {sx: e.clientX, sy: e.clientY, frame: shown, resize: false};
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [full, shown],
  );
  const onGripDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (full || e.button !== 0) return;
      dragRef.current = {sx: e.clientX, sy: e.clientY, frame: shown, resize: true};
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [full, shown],
  );
  const onDragMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (d === null) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      setFrame(
        clampFrame(
          d.resize
            ? {...d.frame, w: d.frame.w + dx, h: d.frame.h + dy}
            : {...d.frame, x: d.frame.x + dx, y: d.frame.y + dy},
          viewport,
        ),
      );
    },
    [viewport],
  );
  const onDragUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // ---- derived view state ----------------------------------------------------------------------

  const frameStyle = useMemo(
    (): CSSProperties => (full ? {inset: 0} : {left: shown.x, top: shown.y, width: shown.w, height: shown.h}),
    [full, shown],
  );
  const canvasStyle = useMemo(
    (): CSSProperties => ({cursor: cursor ?? TOOL_CURSOR[tool], touchAction: 'none'}),
    [cursor, tool],
  );

  const editTarget = useMemo((): Shape | null => {
    if (editing === null) return null;
    return editing.fresh ? pendingRef.current : shapes.find(s => s.id === editing.id) ?? null;
  }, [editing, shapes]);

  /** Where the text editor sits: a text's top-left, a box's area, or a connector's midpoint. */
  const editorStyle = useMemo((): CSSProperties | null => {
    if (editTarget === null) return null;
    const color = hueColor(palette, editTarget.hue);
    if (editTarget.kind === 'text') {
      const [left, top] = toScreen(view, editTarget.x, editTarget.y);
      return {left, top, fontSize: editTarget.size * view.scale, color, minWidth: 80 * view.scale, textAlign: 'left'};
    }
    if (isBox(editTarget)) {
      const b = normalizeRect(editTarget.x, editTarget.y, editTarget.w, editTarget.h);
      const [left, top] = toScreen(view, b.x, b.y);
      return {
        left,
        top,
        width: b.w * view.scale,
        height: b.h * view.scale,
        fontSize: 13 * view.scale,
        color: palette.ink[50],
        textAlign: 'center',
      };
    }
    if (isLine(editTarget)) {
      const [cx, cy] = toScreen(view, (editTarget.x1 + editTarget.x2) / 2, (editTarget.y1 + editTarget.y2) / 2);
      const w = 220 * view.scale;
      return {
        left: cx - w / 2,
        top: cy - 12 * view.scale,
        width: w,
        fontSize: 12 * view.scale,
        color,
        textAlign: 'center',
      };
    }
    return null;
  }, [editTarget, view, palette]);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const zoom = Math.round(view.scale * 100);
  const title = problem === null ? 'Scratchpad' : `Scratchpad · ${problem.title}`;

  return (
    <div
      aria-label={title}
      className={`bg-ink-850 text-ink-100 border-ink-600 fixed z-[60] flex flex-col overflow-hidden shadow-2xl outline-none ${
        full ? '' : 'rounded-xl border'
      }`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      ref={rootRef}
      role="dialog"
      style={frameStyle}
      tabIndex={-1}>
      <div
        className={`border-ink-700 bg-ink-900/70 flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b px-2 py-1.5 ${
          full ? '' : 'cursor-move'
        }`}
        onDoubleClick={narrow ? undefined : toggleMaximized}
        onPointerDown={onBarDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}>
        <span className="text-ink-50 mr-2 select-none text-[12px] font-bold">{title}</span>
        <div aria-label="tools" className="flex items-center gap-0.5" role="toolbar">
          {TOOLS.map(spec => (
            <ToolButton active={tool === spec.tool} key={spec.tool} onPick={pickTool} spec={spec} />
          ))}
        </div>
        <Separator />
        <div aria-label="colour" className="flex items-center gap-0.5" role="toolbar">
          {HUES.map(h => (
            <Swatch active={hue === h} color={hueColor(palette, h)} hue={h} key={h} onPick={pickHue} />
          ))}
        </div>
        <Separator />
        <div aria-label="stroke" className="flex items-center gap-0.5" role="toolbar">
          {WIDTHS.map(w => (
            <WidthButton active={width === w} key={w} onPick={pickWidth} width={w} />
          ))}
          <button
            aria-label="fill boxes"
            aria-pressed={fill}
            className={fill ? activeButton : quietButton}
            onClick={toggleFill}
            title={fill ? 'boxes are tinted; click for outlines only' : 'tint boxes with their colour'}
            type="button">
            <Icon>
              <rect height={9} rx={1.5} width={11} x={2.5} y={3.5} />
              <path d="M2.5 8h5.5v4.5" fill="currentColor" stroke="none" />
            </Icon>
          </button>
          <button
            aria-label="grid"
            aria-pressed={grid}
            className={grid ? activeButton : quietButton}
            onClick={toggleGrid}
            title={`${grid ? 'hide' : 'show'} the grid and snap to it (G)`}
            type="button">
            <Icon>
              <path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12" />
            </Icon>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            aria-label="undo"
            className={quietButton}
            disabled={!canUndo}
            onClick={undo}
            title={`undo (${mod('Z')})`}
            type="button">
            <Icon>
              <path d="M6 4L3 7l3 3M3.5 7H10a3 3 0 0 1 0 6H7" />
            </Icon>
          </button>
          <button
            aria-label="redo"
            className={quietButton}
            disabled={!canRedo}
            onClick={redo}
            title={`redo (${mod('⇧Z')})`}
            type="button">
            <Icon>
              <path d="M10 4l3 3-3 3M12.5 7H6a3 3 0 0 0 0 6h3" />
            </Icon>
          </button>
          <Separator />
          <button
            aria-label="zoom out"
            className={quietButton}
            disabled={view.scale <= MIN_SCALE}
            onClick={zoomOut}
            title="zoom out (−)"
            type="button">
            <Icon>
              <path d="M3.5 8h9" />
            </Icon>
          </button>
          <button
            className="font-code text-ink-300 hover:text-ink-50 w-11 shrink-0 rounded-md text-[11px] transition"
            onClick={fit}
            title="fit the sketch in the window (F)"
            type="button">
            {zoom}%
          </button>
          <button
            aria-label="zoom in"
            className={quietButton}
            disabled={view.scale >= MAX_SCALE}
            onClick={zoomIn}
            title="zoom in (+)"
            type="button">
            <Icon>
              <path d="M8 3.5v9M3.5 8h9" />
            </Icon>
          </button>
          <Separator />
          {problem !== null ? (
            <button
              className="text-ink-300 hover:bg-ink-800 hover:text-ink-50 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition"
              onClick={loadDiagram}
              title="start from this course's architecture diagram, as editable boxes and arrows"
              type="button">
              <Icon>
                <rect height={4} rx={1} width={5} x={1.5} y={2.5} />
                <rect height={4} rx={1} width={5} x={9.5} y={9.5} />
                <path d="M6.5 4.5h3a2 2 0 0 1 2 2v3M9.5 7.5l2 2 2-2" />
              </Icon>
              course diagram
            </button>
          ) : null}
          <button
            aria-label="download as PNG"
            className={quietButton}
            disabled={shapes.length === 0}
            onClick={download}
            title="download the sketch as a PNG"
            type="button">
            <Icon>
              <path d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
            </Icon>
          </button>
          <button
            aria-label="clear the scratchpad"
            className={`${quietButton} hover:text-danger-300`}
            disabled={shapes.length === 0}
            onClick={clear}
            title="clear the scratchpad"
            type="button">
            <Icon>
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8" />
            </Icon>
          </button>
          <Separator />
          {narrow ? null : (
            <button
              aria-label={maximized ? 'restore the window' : 'maximise the window'}
              className={quietButton}
              onClick={toggleMaximized}
              title={maximized ? 'restore' : 'maximise'}
              type="button">
              <Icon>
                {maximized ? (
                  <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M2.5 6.5l4-4M13.5 9.5l-4 4" />
                ) : (
                  <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4 4M2.5 13.5l4-4" />
                )}
              </Icon>
            </button>
          )}
          <button
            aria-label="close the scratchpad"
            className={quietButton}
            onClick={close}
            title="close (Esc)"
            type="button">
            <Icon>
              <path d="M4 4l8 8M12 4l-8 8" />
            </Icon>
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1" ref={hostRef}>
        <canvas
          aria-label="drawing canvas"
          className="block"
          onDoubleClick={onDoubleClick}
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          ref={canvasRef}
          style={canvasStyle}
        />
        {editorStyle !== null ? (
          <div className="pointer-events-none absolute flex items-center justify-center" style={editorStyle}>
            <textarea
              aria-label="text"
              autoFocus
              className="pointer-events-auto w-full resize-none overflow-hidden bg-transparent font-medium leading-[1.3] outline-none placeholder:opacity-40"
              onBlur={commitEdit}
              onChange={onDraftText}
              onKeyDown={onEditorKey}
              placeholder={editTarget !== null && editTarget.kind === 'text' ? 'Type…' : 'Label'}
              rows={Math.max(1, draftText.split('\n').length)}
              spellCheck={false}
              value={draftText}
            />
          </div>
        ) : null}
      </div>

      <div className="border-ink-700 text-ink-400 flex shrink-0 items-center gap-3 border-t px-3 py-1 text-[10.5px]">
        <span className="min-w-0 flex-1 truncate">{HINTS[tool]}</span>
        {selection.size > 0 ? (
          <span className="font-code shrink-0">
            {selection.size} selected · ⌦ removes · {mod('D')} duplicates
          </span>
        ) : (
          <span className="font-code shrink-0">
            {shapes.length} shape{shapes.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {full ? null : (
        <div
          aria-hidden
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          onPointerDown={onGripDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
        />
      )}
      {dialog}
    </div>
  );
});
Scratchpad.displayName = 'Scratchpad';

export default Scratchpad;

export const ScratchpadIcon: FC = memo(() => (
  <Icon>
    <path d="M3 13l1-3.5L11.5 2 14 4.5 6.5 12 3 13zm6.5-9L12 6.5M2.5 13.5h11" />
  </Icon>
));
ScratchpadIcon.displayName = 'ScratchpadIcon';
