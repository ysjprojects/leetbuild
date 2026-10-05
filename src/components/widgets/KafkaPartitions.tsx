import {type ChangeEvent, type FC, type FormEvent, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import WidgetFrame, {clamp, numParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const SUGGESTED = ['cat', 'dog', 'AAPL', 'merchant-42'] as const;
const SEED = ['cat', 'dog', 'cat', 'AAPL', 'merchant-42', 'cat'];
const PALETTE = ['#ff3fa6', '#a78bfa', '#34d399', '#fbbf24', '#60a5fa', '#fb7185'];
const LEFT = 36;
const CELL_W = 46;
const CELL_H = 26;
const ROW = 34;
const MAX_CELLS = 12;
const WIDTH = LEFT + MAX_CELLS * CELL_W + 8;

const INPUT_CLASS =
  'w-28 rounded-md border border-plum-600 bg-plum-900 px-2 py-0.5 font-code text-[11px] text-cream focus:border-candy-500 focus:ring-0 disabled:opacity-40';

/** 32-bit FNV-1a. Kafka's default partitioner uses murmur2; any stable hash gives the same per-key property. */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

interface Message {
  key: string | null;
  partition: number;
  offset: number;
}

/** Keyed records go to `hash(key) % partitions`; keyless ones are spread round-robin. Offsets are per partition. */
const append = (log: Message[], key: string | null, partitions: number): Message[] => {
  const partition = key === null ? log.filter(m => m.key === null).length % partitions : fnv1a(key) % partitions;
  const offset = log.filter(m => m.partition === partition).length;
  return [...log, {key, partition, offset}];
};

const KafkaPartitions: FC<WidgetProps> = memo(({params}) => {
  const partitions = clamp(Math.floor(numParam(params, 'partitions', 4)), 1, 8);
  const [draft, setDraft] = useState('cat');
  const [keyless, setKeyless] = useState(false);
  const [log, setLog] = useState<Message[]>(() => SEED.reduce<Message[]>((acc, k) => append(acc, k, partitions), []));

  const onDraft = useCallback((e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value), []);
  const onChip = useCallback((e: MouseEvent<HTMLButtonElement>) => setDraft(e.currentTarget.value), []);
  const toggleKeyless = useCallback(() => setKeyless(k => !k), []);
  const onClear = useCallback(() => setLog([]), []);
  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const key = keyless ? null : draft.trim();
      if (key === '') return;
      setLog(l => append(l, key, partitions));
    },
    [draft, keyless, partitions],
  );

  const rows = useMemo(
    () =>
      Array.from({length: partitions}, (_, p) => {
        const all = log.filter(m => m.partition === p);
        return {hidden: Math.max(0, all.length - MAX_CELLS), visible: all.slice(-MAX_CELLS)};
      }),
    [log, partitions],
  );
  const newest = log[log.length - 1];

  const controls = useMemo(
    () => (
      <>
        <form className="flex items-center gap-1.5" onSubmit={onSubmit}>
          <input
            aria-label="message key"
            className={INPUT_CLASS}
            disabled={keyless}
            onChange={onDraft}
            placeholder="key"
            spellCheck={false}
            type="text"
            value={draft}
          />
          <button className={BUTTON_CLASS} type="submit">
            Append
          </button>
        </form>
        <div className="flex items-center gap-1">
          {SUGGESTED.map(k => (
            <button
              className={tabClass(!keyless && k === draft)}
              disabled={keyless}
              key={k}
              onClick={onChip}
              type="button"
              value={k}>
              {k}
            </button>
          ))}
        </div>
        <button className={tabClass(keyless)} onClick={toggleKeyless} type="button">
          no key (round-robin)
        </button>
        <button className={BUTTON_CLASS} onClick={onClear} type="button">
          clear
        </button>
      </>
    ),
    [draft, keyless, onChip, onClear, onDraft, onSubmit, toggleKeyless],
  );

  const readout = useMemo(() => {
    if (newest === undefined) return 'Empty topic. Type a key (or pick a chip) and append a message.';
    if (newest.key === null) {
      return `no key → partition ${newest.partition} (round-robin), offset ${newest.offset}. Keyless records are spread across partitions for throughput; nothing orders them relative to each other. (Modern clients use a sticky partitioner: fill one batch, then switch.)`;
    }
    const h = fnv1a(newest.key);
    return (
      <>
        key <code className="font-code text-candy-200">&quot;{newest.key}&quot;</code> → hash {hex(h)} → {hex(h)} %{' '}
        {partitions} = <b className="text-cream">partition {newest.partition}</b>, offset {newest.offset}. All messages
        with key {newest.key} are on partition {newest.partition} in send order; there is no order across partitions.
        (Kafka&apos;s default partitioner uses murmur2; FNV-1a here for brevity — same idea.)
      </>
    );
  }, [newest, partitions]);

  const height = partitions * ROW + 16;
  return (
    <WidgetFrame controls={controls} readout={readout} title="Kafka partitions: key → partition, append at next offset">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>{`A topic with ${partitions} partitions; each row is one partition's append-only log`}</title>
        <text fill="#a78bfa" fontFamily={MONO} fontSize={8} x={LEFT} y={9}>
          offset →
        </text>
        {rows.map((row, p) => {
          const y = 14 + p * ROW;
          return (
            <g key={p}>
              <text fill="#d6c6f5" fontFamily={MONO} fontSize={10} x={4} y={y + 17}>
                p{p}
              </text>
              <rect fill="rgba(58,29,104,0.5)" height={CELL_H} rx={4} width={MAX_CELLS * CELL_W} x={LEFT} y={y} />
              {row.hidden > 0 ? (
                <text fill="#a78bfa" fontFamily={MONO} fontSize={7} x={LEFT + 3} y={y - 2}>
                  … {row.hidden} older
                </text>
              ) : null}
              {row.visible.map((m, i) => {
                const isNew = m === newest;
                const fill = m.key === null ? '#2b144d' : PALETTE[fnv1a(m.key) % PALETTE.length];
                const x = LEFT + i * CELL_W + 2;
                return (
                  <g key={m.offset}>
                    <rect
                      fill={fill}
                      height={CELL_H - 4}
                      rx={3}
                      stroke={isNew ? '#fbf6ff' : m.key === null ? '#5b3a8c' : 'none'}
                      strokeWidth={isNew ? 1.5 : 0.75}
                      width={CELL_W - 4}
                      x={x}
                      y={y + 2}
                    />
                    <text
                      fill={m.key === null ? '#d6c6f5' : '#1a0b33'}
                      fontFamily={MONO}
                      fontSize={8}
                      fontWeight={isNew ? 700 : 400}
                      textAnchor="middle"
                      x={x + (CELL_W - 4) / 2}
                      y={y + 11}>
                      {m.key === null ? '∅' : m.key.length > 7 ? `${m.key.slice(0, 6)}…` : m.key}
                    </text>
                    <text
                      fill={m.key === null ? '#a78bfa' : '#1a0b33'}
                      fontFamily={MONO}
                      fontSize={7}
                      textAnchor="middle"
                      x={x + (CELL_W - 4) / 2}
                      y={y + 20}>
                      @{m.offset}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
KafkaPartitions.displayName = 'KafkaPartitions';

export default KafkaPartitions;
