import {type FC, type ReactElement, memo, useMemo} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
const PROMPT = ['Once', 'upon', 'a', 'time'] as const;
const GENERATED = ['there', 'was', 'a', 'small', 'cat', 'who', 'sat', '.'] as const;
const TOKENS = [...PROMPT, ...GENERATED];
const P = PROMPT.length;
/** One forward pass per generated token: pass k reads positions 0 … P + k − 1 and emits token P + k. */
const STEPS = GENERATED.length;
const MAX_LEN = P + STEPS - 1;

/** GPT-2 small: 12 layers, 12 heads of 64 dims, K and V stored in fp16/bf16. */
const LAYERS = 12;
const HEADS = 12;
const HEAD_DIM = 64;
const BYTES = 2;
const BYTES_PER_TOKEN = 2 * LAYERS * HEADS * HEAD_DIM * BYTES;
const CONTEXT = 1024;

const WIDTH = 600;
const LEFT = 92;
const CELL = 42;
const TOKEN_Y = 14;
const LANE_A = 34;
const LANE_B = 94;
const ROW_H = 16;
const COUNT_Y = 164;
const COUNT_X = 150;
const COUNT_W = WIDTH - COUNT_X - 120;
const HEIGHT = COUNT_Y + 62;

const COMPUTE_FILL = alpha(warning[400], 0.55);
const CACHE_FILL = alpha(success[400], 0.25);
const NEXT_FILL = alpha(iris[400], 0.1);

/** Rows computed in pass k (sequence length P + k): the cache computes the prompt once, then one row; without it, all rows. */
const uncachedTotal = (k: number): number => (k + 1) * P + (k * (k + 1)) / 2;
const FINAL_UNCACHED = uncachedTotal(STEPS - 1);

const kib = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;

const KvCache: FC<WidgetProps> = memo(() => {
  const playback = usePlayback(STEPS, 1200);
  const k = Math.min(playback.step, STEPS - 1);
  const len = P + k;
  const cachedStep = k === 0 ? P : 1;
  const cachedTotal = len;
  const uncachedStep = len;
  const uncached = uncachedTotal(k);
  const cacheBytes = len * BYTES_PER_TOKEN;

  const controls = useMemo(() => <PlaybackControls label="pass" playback={playback} />, [playback]);

  const readout = useMemo(
    () =>
      `Pass ${k + 1} reads ${len} tokens and emits “${
        GENERATED[k]
      }”: with the cache it projects ${cachedStep} new K/V row${
        cachedStep > 1 ? 's' : ''
      } (total ${cachedTotal}, linear), without it ${uncachedStep} (total ${uncached}, quadratic). Cache for GPT-2 small at ${len} tokens: ${len} × ${BYTES_PER_TOKEN.toLocaleString(
        'en-US',
      )} B = ${kib(cacheBytes)}; at ${CONTEXT} tokens ${kib(CONTEXT * BYTES_PER_TOKEN)}.`,
    [cacheBytes, cachedStep, cachedTotal, k, len, uncached, uncachedStep],
  );

  const lane = (y: number, cached: boolean, label: string): ReactElement => (
    <g>
      <text fill={ink[200]} fontFamily={MONO} fontSize={10} x={4} y={y - 4}>
        {label}
      </text>
      {(['K', 'V'] as const).map((kv, r) => (
        <g key={kv}>
          <text
            fill={ink[300]}
            fontFamily={MONO}
            fontSize={9}
            textAnchor="end"
            x={LEFT - 8}
            y={y + r * (ROW_H + 2) + 12}>
            {kv} rows
          </text>
          {TOKENS.slice(0, MAX_LEN).map((_, i) => {
            const x = LEFT + i * CELL;
            const present = i < len;
            const computed = present && (!cached || k === 0 || i === len - 1);
            return (
              <rect
                className="transition-all duration-300"
                fill={!present ? 'transparent' : computed ? COMPUTE_FILL : CACHE_FILL}
                height={ROW_H}
                key={i}
                rx={2}
                stroke={!present ? ink[700] : computed ? warning[400] : success[400]}
                strokeDasharray={present ? undefined : '2 2'}
                strokeWidth={1}
                width={CELL - 4}
                x={x + 2}
                y={y + r * (ROW_H + 2)}
              />
            );
          })}
        </g>
      ))}
    </g>
  );

  const counter = (y: number, value: number, step: number, label: string, color: string): ReactElement => (
    <g>
      <text fill={ink[200]} fontFamily={MONO} fontSize={10} textAnchor="end" x={COUNT_X - 8} y={y + 10}>
        {label}
      </text>
      <rect fill={ink[800]} height={12} rx={3} width={COUNT_W} x={COUNT_X} y={y} />
      <rect
        className="transition-all duration-300"
        fill={color}
        height={12}
        rx={3}
        width={(value / FINAL_UNCACHED) * COUNT_W}
        x={COUNT_X}
        y={y}
      />
      <text fill={ink[100]} fontFamily={MONO} fontSize={10} x={COUNT_X + COUNT_W + 8} y={y + 10}>
        {value} (+{step})
      </text>
    </g>
  );

  return (
    <WidgetFrame controls={controls} readout={readout} title="kv cache · decoding with and without">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Decoding pass ${
          k + 1
        } of ${STEPS}: ${len} tokens in context, cached vs uncached K/V projections`}</title>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={TOKEN_Y}>
          tokens
        </text>
        {TOKENS.map((tok, i) => {
          const x = LEFT + i * CELL + CELL / 2;
          const emitted = i === len;
          const visible = i <= len;
          return (
            <g key={i}>
              {emitted ? (
                <rect
                  fill={NEXT_FILL}
                  height={16}
                  rx={3}
                  stroke={iris[400]}
                  strokeDasharray="3 2"
                  width={CELL - 4}
                  x={x - CELL / 2 + 2}
                  y={TOKEN_Y - 12}
                />
              ) : null}
              <text
                fill={!visible ? ink[600] : emitted ? iris[300] : i < P ? ink[100] : iris[200]}
                fontFamily={MONO}
                fontSize={10}
                fontWeight={i < P ? 700 : 400}
                textAnchor="middle"
                x={x}
                y={TOKEN_Y}>
                {visible ? tok : '·'}
              </text>
            </g>
          );
        })}
        {lane(LANE_A, true, `with KV cache · computes ${cachedStep}, reads ${len - cachedStep} from cache`)}
        {lane(LANE_B, false, `without cache · recomputes all ${len} rows`)}
        <g fontFamily={MONO} fontSize={9}>
          <rect fill={COMPUTE_FILL} height={9} rx={2} stroke={warning[400]} width={14} x={4} y={COUNT_Y - 24} />
          <text fill={ink[300]} x={22} y={COUNT_Y - 16}>
            projected this pass
          </text>
          <rect fill={CACHE_FILL} height={9} rx={2} stroke={success[400]} width={14} x={150} y={COUNT_Y - 24} />
          <text fill={ink[300]} x={168} y={COUNT_Y - 16}>
            read from cache
          </text>
          <text fill={ink[300]} textAnchor="end" x={WIDTH - 4} y={COUNT_Y - 16}>
            K/V rows projected (per layer)
          </text>
        </g>
        {counter(COUNT_Y, cachedTotal, cachedStep, 'with cache', success[400])}
        {counter(COUNT_Y + 18, uncached, uncachedStep, 'without cache', warning[400])}
        <text fill={ink[200]} fontFamily={MONO} fontSize={10} x={4} y={COUNT_Y + 50}>
          cache · GPT-2 small: 2·{LAYERS}·{HEADS}·{HEAD_DIM}·{BYTES} B = {BYTES_PER_TOKEN.toLocaleString('en-US')}{' '}
          B/token × {len} = {kib(cacheBytes)}
        </text>
      </svg>
    </WidgetFrame>
  );
});
KvCache.displayName = 'KvCache';

export default KvCache;
