import {type FC, memo} from 'react';

import useDragHandle from '@/lib/useDragHandle';

/**
 * Resize handle between two panels, LeetCode style: a hairline with a grip pill that lights up
 * on hover and while dragging. Drag to resize, double-click to restore the default split.
 */
const SplitGutter: FC<{
  axis: 'x' | 'y';
  onDrag: (delta: number) => void;
  onReset: () => void;
  className?: string;
}> = memo(({axis, onDrag, onReset, className = ''}) => {
  const {dragging, onPointerDown} = useDragHandle(axis, onDrag, onReset);
  const x = axis === 'x';
  return (
    <div
      aria-orientation={x ? 'vertical' : 'horizontal'}
      className={`group relative flex shrink-0 touch-none items-center justify-center ${
        x ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'
      } ${className}`}
      onPointerDown={onPointerDown}
      role="separator"
      title="drag to resize · double-click to reset">
      <div
        className={`absolute transition-colors ${x ? 'inset-y-0 left-1/2 w-px' : 'inset-x-0 top-1/2 h-px'} ${
          dragging ? 'bg-candy-500' : 'bg-plum-600/70 group-hover:bg-candy-500/70'
        }`}
      />
      <div
        className={`relative rounded-full transition-colors ${x ? 'h-8 w-1' : 'h-1 w-8'} ${
          dragging ? 'bg-candy-400' : 'bg-plum-400 group-hover:bg-candy-400'
        }`}
      />
    </div>
  );
});
SplitGutter.displayName = 'SplitGutter';

export default SplitGutter;
