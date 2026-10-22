import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {concept, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WIDTH = 560;
const HEIGHT = 250;
const BAR_X = 16;
const BAR_W = WIDTH - 32;
const BAR_Y = 22;
const BAR_H = 26;
const TABLE_Y = 72;
const ROW_H = 16;
const MEM_Y = 190;
const SLIDER_CLASS = `${RANGE_CLASS} min-w-0 flex-1`;

const PRESET_IDS = ['gpt2', 'gpt2-medium', 'gpt2-xl', 'llama-3-8b'] as const;
type PresetId = (typeof PRESET_IDS)[number];

/** GPT-2 style: LayerNorm with biases, biased linears, GELU MLP of 4d, learned positions, head tied to the token embedding. Llama style: RMSNorm, no biases, SwiGLU of 3.5d, RoPE, untied head. */
type Arch = 'gpt' | 'llama';

interface Config {
  layers: number;
  width: number;
  heads: number;
  kvHeads: number;
  vocab: number;
  ctx: number;
}

const PRESETS: Record<PresetId, {arch: Arch; config: Config}> = {
  gpt2: {arch: 'gpt', config: {layers: 12, width: 768, heads: 12, kvHeads: 12, vocab: 50257, ctx: 1024}},
  'gpt2-medium': {arch: 'gpt', config: {layers: 24, width: 1024, heads: 16, kvHeads: 16, vocab: 50257, ctx: 1024}},
  'gpt2-xl': {arch: 'gpt', config: {layers: 48, width: 1600, heads: 25, kvHeads: 25, vocab: 50257, ctx: 1024}},
  'llama-3-8b': {
    arch: 'llama',
    config: {layers: 32, width: 4096, heads: 32, kvHeads: 8, vocab: 128256, ctx: 8192},
  },
};

const ctxOptions = Array.from({length: 11}, (_, i) => 128 * 2 ** i);

/** Head counts that divide the width with a head dimension of at least 32, up to 128 heads. */
const headOptions = (width: number): number[] => {
  const out: number[] = [];
  for (let h = 1; h <= 128 && width / h >= 32; h += 1) if (width % h === 0) out.push(h);
  return out.length === 0 ? [1] : out;
};

const divisors = (n: number): number[] => {
  const out: number[] = [];
  for (let k = 1; k <= n; k += 1) if (n % k === 0) out.push(k);
  return out;
};

const closest = (options: number[], target: number): number =>
  options.reduce((best, o) => (Math.abs(Math.log(o / target)) < Math.abs(Math.log(best / target)) ? o : best));

interface Breakdown {
  embeddings: number;
  attention: number;
  mlp: number;
  norms: number;
  head: number;
  total: number;
  ffn: number;
  headDim: number;
}

const countParams = (arch: Arch, c: Config): Breakdown => {
  const d = c.width;
  const headDim = d / c.heads;
  const kvDim = c.kvHeads * headDim;
  const gpt = arch === 'gpt';
  const bias = gpt ? 1 : 0;
  const ffn = gpt ? 4 * d : Math.round(3.5 * d);
  const embeddings = c.vocab * d + (gpt ? c.ctx * d : 0);
  // q and out projections are d×d, k and v are d×(n_kv·hd); GPT-2 adds a bias to each.
  const attention = c.layers * (2 * (d * d + d * bias) + 2 * (d * kvDim + kvDim * bias));
  // GPT-2: up d→4d and down 4d→d with biases. Llama: gate, up and down, no biases.
  const mlp = c.layers * (gpt ? 2 * d * ffn + ffn + d : 3 * d * ffn);
  // Two norms per block plus the final one; LayerNorm has weight and bias, RMSNorm only a weight.
  const norms = (2 * c.layers + 1) * d * (gpt ? 2 : 1);
  const head = gpt ? 0 : c.vocab * d;
  return {embeddings, attention, mlp, norms, head, total: embeddings + attention + mlp + norms + head, ffn, headDim};
};

const group = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const short = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${(n / 1e3).toFixed(1)} K`;

const bytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(1)} KB`;

const PRECISIONS = [
  {name: 'fp32', bytes: 4},
  {name: 'bf16', bytes: 2},
  {name: 'int8', bytes: 1},
  {name: 'int4', bytes: 0.5},
] as const;

const ModelSize: FC<WidgetProps> = memo(({params}) => {
  const initial = stringParam(params, 'preset', PRESET_IDS, 'gpt2');
  const [arch, setArch] = useState<Arch>(PRESETS[initial].arch);
  const [config, setConfig] = useState<Config>(PRESETS[initial].config);

  const onPreset = useCallback((id: PresetId) => {
    setArch(PRESETS[id].arch);
    setConfig(PRESETS[id].config);
  }, []);
  const presetHandlers = useMemo(
    () => Object.fromEntries(PRESET_IDS.map(id => [id, () => onPreset(id)])) as Record<PresetId, () => void>,
    [onPreset],
  );

  const heads = useMemo(() => headOptions(config.width), [config.width]);
  const kvOptions = useMemo(() => divisors(config.heads), [config.heads]);

  const onLayers = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setConfig(c => ({...c, layers: Number(e.target.value)})),
    [],
  );
  const onWidth = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      setConfig(c => {
        const width = Number(e.target.value);
        const h = closest(headOptions(width), c.heads);
        const kvHeads = c.kvHeads === c.heads ? h : closest(divisors(h), c.kvHeads);
        return {...c, width, heads: h, kvHeads};
      }),
    [],
  );
  const onHeads = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      setConfig(c => {
        const h = headOptions(c.width)[Number(e.target.value)] ?? c.heads;
        const kvHeads = c.kvHeads === c.heads ? h : closest(divisors(h), c.kvHeads);
        return {...c, heads: h, kvHeads};
      }),
    [],
  );
  const onKv = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      setConfig(c => ({...c, kvHeads: divisors(c.heads)[Number(e.target.value)] ?? c.kvHeads})),
    [],
  );
  const onVocab = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setConfig(c => ({...c, vocab: Number(e.target.value)})),
    [],
  );
  const onCtx = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setConfig(c => ({...c, ctx: ctxOptions[Number(e.target.value)] ?? c.ctx})),
    [],
  );

  const matched = PRESET_IDS.find(
    id =>
      PRESETS[id].arch === arch &&
      (Object.keys(config) as Array<keyof Config>).every(k => PRESETS[id].config[k] === config[k]),
  );

  const counts = useMemo(() => countParams(arch, config), [arch, config]);
  const kvBytes = 2 * config.layers * config.kvHeads * counts.headDim * config.ctx * 2;
  const gpt = arch === 'gpt';

  const controls = useMemo(
    () => (
      <>
        {PRESET_IDS.map(id => (
          <button
            aria-pressed={matched === id}
            className={tabClass(matched === id)}
            key={id}
            onClick={presetHandlers[id]}
            type="button">
            {id}
          </button>
        ))}
      </>
    ),
    [matched, presetHandlers],
  );

  const sliders = useMemo(() => {
    const field = (
      label: string,
      aria: string,
      value: number,
      min: number,
      max: number,
      step: number,
      shown: string,
      onChange: (e: ChangeEvent<HTMLInputElement>) => void,
    ) => (
      <label className="flex items-center gap-1.5">
        <span className="text-ink-300 w-14 shrink-0 whitespace-nowrap">{label}</span>
        <input
          aria-label={aria}
          className={SLIDER_CLASS}
          max={max}
          min={min}
          onChange={onChange}
          step={step}
          type="range"
          value={value}
        />
        <span className="font-code text-ink-100 whitespace-nowrap tabular-nums">{shown}</span>
      </label>
    );
    return (
      <div className="text-ink-200 mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        {field('layers', 'layers', config.layers, 1, 96, 1, String(config.layers), onLayers)}
        {field('width', 'model width d', config.width, 128, 8192, 64, `d ${group(config.width)}`, onWidth)}
        {field(
          'heads',
          'query heads',
          heads.indexOf(config.heads),
          0,
          heads.length - 1,
          1,
          `${config.heads} · hd ${counts.headDim}`,
          onHeads,
        )}
        {field(
          'KV heads',
          'key and value heads',
          kvOptions.indexOf(config.kvHeads),
          0,
          kvOptions.length - 1,
          1,
          config.kvHeads === config.heads ? `${config.kvHeads} (MHA)` : `${config.kvHeads} (GQA)`,
          onKv,
        )}
        {field('vocab', 'vocabulary size', config.vocab, 1000, 262144, 1, group(config.vocab), onVocab)}
        {field(
          'context',
          'context length in tokens',
          ctxOptions.indexOf(config.ctx),
          0,
          ctxOptions.length - 1,
          1,
          `${group(config.ctx)} tok`,
          onCtx,
        )}
      </div>
    );
  }, [config, counts.headDim, heads, kvOptions, onCtx, onHeads, onKv, onLayers, onVocab, onWidth]);

  const rows = useMemo(
    () => [
      {
        name: 'embeddings',
        color: concept.http,
        n: counts.embeddings,
        formula: gpt ? 'V·d + ctx·d (learned positions)' : 'V·d (RoPE has no weights)',
      },
      {
        name: 'attention',
        color: iris[400],
        n: counts.attention,
        formula: gpt ? 'L·(2d² + 2d·n_kv·hd + biases)' : 'L·(2d² + 2d·n_kv·hd)',
      },
      {
        name: 'MLP',
        color: concept.pytorch,
        n: counts.mlp,
        formula: gpt
          ? `L·(2·d·ffn + biases), GELU, ffn ${group(counts.ffn)}`
          : `L·3·d·ffn, SwiGLU, ffn ${group(counts.ffn)}`,
      },
      {
        name: 'norms',
        color: success[400],
        n: counts.norms,
        formula: gpt ? '(2L + 1)·2d, LayerNorm γ and β' : '(2L + 1)·d, RMSNorm γ',
      },
      {
        name: 'head',
        color: warning[300],
        n: counts.head,
        formula: gpt ? '0, tied to the token embedding' : 'V·d, untied',
      },
    ],
    [counts, gpt],
  );

  const readout = useMemo(
    () => (
      <>
        <b className="text-ink-100">{group(counts.total)} parameters</b> ({short(counts.total)}):{' '}
        {bytes(counts.total * 2)} of weights in bf16, {bytes(counts.total / 2)} in int4. The KV cache for one{' '}
        {group(config.ctx)}-token sequence is 2·{config.layers}·{config.kvHeads}·{counts.headDim}·{group(config.ctx)}·2
        B = <b className="text-ink-100">{bytes(kvBytes)}</b>
        {config.kvHeads < config.heads
          ? `, ${config.heads / config.kvHeads}× smaller than with ${config.heads} KV heads.`
          : '.'}
      </>
    ),
    [config, counts, kvBytes],
  );

  let x = BAR_X;
  const segments = rows.map(r => {
    const w = (r.n / counts.total) * BAR_W;
    const seg = {...r, x, w};
    x += w;
    return seg;
  });
  const boxW = (BAR_W - 4 * 8) / 5;

  return (
    <WidgetFrame controls={controls} readout={readout} title="model size calculator">
      {sliders}
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Parameters by component, weight memory per precision and KV-cache memory per sequence</title>
        <text fill={ink[300]} fontFamily={MONO} fontSize={10} x={BAR_X} y={14}>
          {gpt ? 'GPT-2 style' : 'Llama style'} · {config.layers} layers · d {group(config.width)} · {config.heads}{' '}
          heads · {config.kvHeads} KV heads
        </text>
        <rect fill={ink[800]} height={BAR_H} rx={4} width={BAR_W} x={BAR_X} y={BAR_Y} />
        {segments.map(s =>
          s.w > 0 ? (
            <rect
              fill={s.color}
              height={BAR_H}
              key={s.name}
              stroke={ink[850]}
              strokeWidth={1}
              width={s.w}
              x={s.x}
              y={BAR_Y}
            />
          ) : null,
        )}
        {segments.map(s =>
          s.w > 44 ? (
            <text
              fill={ink[950]}
              fontFamily={MONO}
              fontSize={10}
              fontWeight={600}
              key={s.name}
              textAnchor="middle"
              x={s.x + s.w / 2}
              y={BAR_Y + BAR_H / 2 + 3.5}>
              {((s.n / counts.total) * 100).toFixed(0)}%
            </text>
          ) : null,
        )}
        <g fontFamily={MONO} fontSize={10}>
          {rows.map((r, i) => {
            const y = TABLE_Y + i * ROW_H;
            return (
              <g key={r.name}>
                <rect fill={r.color} height={9} rx={2} width={9} x={BAR_X} y={y - 8} />
                <text fill={ink[100]} x={BAR_X + 15}>
                  <tspan y={y}>{r.name}</tspan>
                </text>
                <text fill={ink[50]} textAnchor="end" x={BAR_X + 172} y={y}>
                  {group(r.n)}
                </text>
                <text fill={ink[300]} textAnchor="end" x={BAR_X + 220} y={y}>
                  {((r.n / counts.total) * 100).toFixed(1)}%
                </text>
                <text fill={ink[300]} x={BAR_X + 234} y={y}>
                  {r.formula}
                </text>
              </g>
            );
          })}
          <line
            stroke={ink[600]}
            strokeWidth={0.75}
            x1={BAR_X}
            x2={BAR_X + 220}
            y1={TABLE_Y + 5 * ROW_H - 9}
            y2={TABLE_Y + 5 * ROW_H - 9}
          />
          <text fill={ink[50]} fontWeight={600} x={BAR_X + 15} y={TABLE_Y + 5 * ROW_H + 3}>
            total
          </text>
          <text fill={ink[50]} fontWeight={600} textAnchor="end" x={BAR_X + 172} y={TABLE_Y + 5 * ROW_H + 3}>
            {group(counts.total)}
          </text>
          <text fill={ink[300]} x={BAR_X + 234} y={TABLE_Y + 5 * ROW_H + 3}>
            {short(counts.total)} parameters
          </text>
        </g>
        <text fill={ink[300]} fontFamily={MONO} fontSize={10} x={BAR_X} y={MEM_Y - 8}>
          weight memory per precision · KV cache per sequence at full context, bf16
        </text>
        {PRECISIONS.map((p, i) => {
          const bx = BAR_X + i * (boxW + 8);
          return (
            <g fontFamily={MONO} key={p.name}>
              <rect
                fill={ink[800]}
                height={46}
                rx={6}
                stroke={p.name === 'bf16' ? iris[400] : ink[600]}
                strokeWidth={p.name === 'bf16' ? 1.25 : 0.75}
                width={boxW}
                x={bx}
                y={MEM_Y}
              />
              <text fill={ink[300]} fontSize={9.5} textAnchor="middle" x={bx + boxW / 2} y={MEM_Y + 17}>
                {p.name} · {p.bytes} B
              </text>
              <text fill={ink[50]} fontSize={11} fontWeight={600} textAnchor="middle" x={bx + boxW / 2} y={MEM_Y + 35}>
                {bytes(counts.total * p.bytes)}
              </text>
            </g>
          );
        })}
        <g fontFamily={MONO}>
          <rect
            fill={ink[800]}
            height={46}
            rx={6}
            stroke={warning[300]}
            strokeWidth={1.25}
            width={boxW}
            x={BAR_X + 4 * (boxW + 8)}
            y={MEM_Y}
          />
          <text fill={ink[300]} fontSize={9.5} textAnchor="middle" x={BAR_X + 4 * (boxW + 8) + boxW / 2} y={MEM_Y + 17}>
            KV · {config.ctx >= 1024 ? `${config.ctx / 1024}K` : config.ctx} tok
          </text>
          <text
            fill={ink[50]}
            fontSize={11}
            fontWeight={600}
            textAnchor="middle"
            x={BAR_X + 4 * (boxW + 8) + boxW / 2}
            y={MEM_Y + 35}>
            {bytes(kvBytes)}
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
ModelSize.displayName = 'ModelSize';

export default ModelSize;
