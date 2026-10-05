import {type PointerEvent as ReactPointerEvent, useCallback, useRef, useState} from 'react';

/**
 * Pointer-capture drag for split handles (sidebar/console dividers, panel gutters). `onDrag`
 * receives the pointer's movement along `axis` since the previous event, in pixels. While a drag
 * is in progress the page cursor and text selection are pinned so an editor next to the handle
 * does not select text or show its own cursor as the pointer crosses it.
 *
 * `onDoubleTap` fires on two pointerdowns in quick succession at the same spot (used to reset a
 * split); it is detected here because preventing the pointerdown default, which stops text
 * selection from starting, also suppresses the browser's `dblclick`.
 */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 6;

function useDragHandle(
  axis: 'x' | 'y',
  onDrag: (delta: number) => void,
  onDoubleTap?: () => void,
): {dragging: boolean; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void} {
  const [dragging, setDragging] = useState(false);
  const lastDown = useRef<{at: number; x: number; y: number} | null>(null);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const previousDown = lastDown.current;
      lastDown.current = {at: e.timeStamp, x: e.clientX, y: e.clientY};
      if (
        onDoubleTap !== undefined &&
        previousDown !== null &&
        e.timeStamp - previousDown.at < DOUBLE_TAP_MS &&
        Math.abs(e.clientX - previousDown.x) < DOUBLE_TAP_PX &&
        Math.abs(e.clientY - previousDown.y) < DOUBLE_TAP_PX
      ) {
        lastDown.current = null;
        onDoubleTap();
        return;
      }
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const body = document.body;
      const previous = {cursor: body.style.cursor, userSelect: body.style.userSelect};
      body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      body.style.userSelect = 'none';
      setDragging(true);
      let last = axis === 'x' ? e.clientX : e.clientY;
      const move = (ev: PointerEvent) => {
        const now = axis === 'x' ? ev.clientX : ev.clientY;
        onDrag(now - last);
        last = now;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        body.style.cursor = previous.cursor;
        body.style.userSelect = previous.userSelect;
        setDragging(false);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [axis, onDrag, onDoubleTap],
  );
  return {dragging, onPointerDown};
}

export default useDragHandle;
