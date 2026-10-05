import {type FC, type MouseEvent, type ReactNode, memo, useCallback, useEffect, useRef, useState} from 'react';

/**
 * In-app stand-in for `window.confirm` / `window.prompt`: a native `<dialog>` (top layer, focus
 * trap, Escape, inert page) in the playground's palette. `useDialog` gives a component one dialog
 * slot and a promise-returning opener, so a confirmation reads like the blocking call it replaces.
 */

export interface DialogSpec {
  title: string;
  body: ReactNode;
  /** Label of the affirmative button; omit for a notice that only closes. */
  confirm?: string;
  /** The affirmative action discards work: red button. */
  danger?: boolean;
}

const buttonClass = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold transition';
const cancelClass = `${buttonClass} border border-ink-600 text-ink-200 hover:border-ink-500 hover:text-ink-50`;
const confirmClass = `${buttonClass} bg-iris-400 text-ink-950 hover:bg-iris-300`;
const dangerClass = `${buttonClass} bg-danger-400 text-ink-950 hover:bg-danger-300`;

const Dialog: FC<{spec: DialogSpec; onClose: (ok: boolean) => void}> = memo(({spec, onClose}) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el !== null && !el.open) el.showModal();
  }, []);
  const cancel = useCallback(() => onClose(false), [onClose]);
  const confirm = useCallback(() => onClose(true), [onClose]);
  // The panel fills the element, so a click whose target is the element itself landed on the backdrop.
  const onClick = useCallback(
    (e: MouseEvent<HTMLDialogElement>) => {
      if (e.target === e.currentTarget) onClose(false);
    },
    [onClose],
  );
  return (
    <dialog
      aria-labelledby="lb-dialog-title"
      className="border-ink-600 bg-ink-800 text-ink-200 backdrop:bg-ink-950/70 w-[min(92vw,26rem)] rounded-xl border p-0 shadow-2xl"
      onClick={onClick}
      onClose={cancel}
      ref={ref}>
      <div className="p-4">
        <h2 className="text-ink-50 text-[15px] font-bold" id="lb-dialog-title">
          {spec.title}
        </h2>
        <div className="text-ink-300 mt-2 text-[13px] leading-relaxed">{spec.body}</div>
        <div className="mt-4 flex justify-end gap-2">
          {spec.confirm === undefined ? (
            <button autoFocus className={cancelClass} onClick={cancel} type="button">
              Close
            </button>
          ) : (
            <>
              <button autoFocus className={cancelClass} onClick={cancel} type="button">
                Cancel
              </button>
              <button className={spec.danger === true ? dangerClass : confirmClass} onClick={confirm} type="button">
                {spec.confirm}
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
});
Dialog.displayName = 'Dialog';

/** `[dialog, openDialog]`: render `dialog` anywhere in the component; `openDialog(spec)` resolves true on confirm. */
export function useDialog(): [ReactNode, (spec: DialogSpec) => Promise<boolean>] {
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  const resolve = useRef<((ok: boolean) => void) | null>(null);
  const open = useCallback(
    (next: DialogSpec) =>
      new Promise<boolean>(r => {
        resolve.current = r;
        setSpec(next);
      }),
    [],
  );
  const close = useCallback((ok: boolean) => {
    setSpec(null);
    resolve.current?.(ok);
    resolve.current = null;
  }, []);
  return [spec === null ? null : <Dialog onClose={close} spec={spec} />, open];
}
