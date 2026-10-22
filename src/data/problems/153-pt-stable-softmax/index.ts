import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {stableSoftmaxStep} from './steps/1-stable-softmax';

/**
 * Drill: log-softmax with the max subtracted (log-sum-exp), softmax as its exponential, and a
 * cross-entropy that gathers the target column, smooths labels and skips ignored positions — the
 * three tensor functions every LLM's output head and loss are made of, written without
 * torch.nn.functional and checked against it.
 */
export const ptStableSoftmaxProblem: Problem = {
  id: 'pt-stable-softmax',
  title: 'Numerically stable softmax and cross-entropy',
  tagline:
    'log_softmax by log-sum-exp with the max shifted out, softmax as its exp, cross_entropy as a gather with label smoothing and ignore_index — matching torch.nn.functional on logits near 1e4, gradients checked.',
  difficulty: 'easy',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 25,
  statement: `# Numerically stable softmax and cross-entropy

Softmax turns a row of scores into a distribution, \`p_i = exp(x_i) / Σ_j exp(x_j)\`, and cross-entropy is
\`-log p_target\`. An LLM runs the pair twice on every token: over the \`(seq, seq)\` attention scores in each
head, and over the \`(tokens, vocab)\` logits of the output head, where the pre-training loss is the mean
\`-log p\` of the next token across a vocabulary of 32k–150k entries. Written as the formula, softmax breaks
on real logits: \`exp(89)\` is already \`inf\` in float32, and \`inf / inf\` is \`nan\`. The fix is one line —
subtract the row max before exponentiating — and the right place for it is \`log_softmax\`, from which
softmax (its \`exp\`) and cross-entropy (one gathered column of it) follow without a second formula.

The surface is three functions over tensors, in float32 or float64, with gradients through autograd:

- \`log_softmax(x, dim=-1)\` — \`x - m - log(Σ exp(x - m))\` with \`m\` the max along \`dim\`, any shape.
- \`softmax(x, dim=-1)\` — \`log_softmax(x, dim).exp()\`.
- \`cross_entropy(logits, targets, label_smoothing=0.0, ignore_index=-100)\` — \`logits\` \`(N, C)\`,
  \`targets\` \`(N,)\` int64; the mean over rows whose target is not \`ignore_index\` of
  \`(1 - ε) · (-logp[target]) + ε · (-mean_c logp[c])\`.

## What you build here

1. \`log_softmax\` by max shift and log-sum-exp; \`softmax\` as its exponential; \`cross_entropy\` as a
   \`gather\` on the log-probabilities with label smoothing as a mixture term and \`ignore_index\` rows
   masked out of both the sum and the count — matching \`torch.nn.functional\` to \`1e-5\` (float32) and
   \`1e-10\` (float64) on a batch with a row near \`1e4\`, and \`torch.autograd.gradcheck\` in float64.

## Run it on your machine

\`\`\`bash
python stable_softmax.py
\`\`\`

The file ends with a self-test: deterministic logits (\`torch.manual_seed(0)\`) with one row around \`1e4\`
and one logit at \`-1e4\`, two ignored targets, \`label_smoothing\` \`0.0\` and \`0.1\`, compared with
\`F.log_softmax\`, \`F.softmax\` and \`F.cross_entropy\` by \`torch.allclose\` in both dtypes, then \`gradcheck\`
on \`log_softmax\` and \`cross_entropy\`. A passing run prints \`PASS\`; the starter raises
\`NotImplementedError: TODO\`.

## Left out on purpose

Class weights, \`reduction="sum"\` / \`"none"\`, soft (probability) targets, the fused and chunked kernels
that never materialise the \`(tokens, vocab)\` tensor, bf16 → float32 upcasting of the logits, and the
online (tiled, running-max) softmax that FlashAttention uses inside attention.`,
  architecture: {
    input: 'logits x · (N, C) · one row near 1e4',
    items: [
      {
        id: 'logits',
        label: 'Logits',
        sub: '(N, C) · float32 or float64',
        kind: 'io',
        shape: '[N, C]',
        detail:
          'One row per token, one column per class. The self-test puts its first row around `1e4` and one logit at `-1e4`: `exp` of either end is out of range in both dtypes.',
      },
      {
        tone: 'dotted',
        label: 'log_softmax(x, dim=-1)',
        items: [
          {
            id: 'shift',
            label: 'Subtract the row max',
            sub: 's = x − m ≤ 0',
            shape: '[N, C]',
            side: {
              label: 'Row max m',
              sub: 'x.amax(-1, keepdim)',
              detail:
                '`m` has shape `(N, 1)` and broadcasts back over the row. Its gradient cancels exactly (`-1 + Σ p = 0`), so `m.detach()` is safe.',
            },
            detail:
              'Softmax is a ratio of exponentials, unchanged when every term is multiplied by `exp(-m)`. After the shift the largest exponent is exactly `0`.',
          },
          {
            id: 'exp',
            label: 'Exponentiate',
            sub: 'exp(s) ∈ (0, 1]',
            detail:
              'Every exponent is `≤ 0`, so nothing overflows. Terms far below the max underflow to `0`, which is the right probability.',
          },
          {
            id: 'sum',
            label: 'Sum over the row',
            sub: 'Σ exp(s) ∈ [1, C]',
            shape: '[N, 1]',
            detail: 'The max term contributes exactly `1`, so the sum is never `0` and never above `C`.',
          },
          {
            id: 'log',
            label: 'Log, negated',
            sub: '−log Σ exp(s) ∈ [−log C, 0]',
            detail: 'Minus the log-sum-exp of the shifted row: a small finite number, `lse(x) − m`.',
          },
          {
            id: 'logp',
            op: '+',
            from: 'exp',
            detail:
              '`log p = s − log Σ exp(s)`: the shifted row comes around and the log-sum-exp is subtracted. `(N, C)`, finite, the one full-width tensor.',
          },
        ],
      },
      {
        columns: [
          [
            {
              id: 'softmax',
              label: 'softmax',
              sub: 'p = exp(log p)',
              kind: 'io',
              shape: '[N, C]',
              detail: 'Not a second formula: one more `exp` over the log-probabilities, which inherits the shift.',
            },
          ],
          [
            {
              columns: [
                [
                  {
                    id: 'gather',
                    label: 'Gather the target',
                    sub: '(1 − ε) · −logp[t]',
                    shape: '[N]',
                    detail:
                      '`logp.gather(1, t.unsqueeze(1)).squeeze(1)`: one entry per row, no one-hot. Ignored rows gather a stand-in index `0`.',
                  },
                ],
                [
                  {
                    id: 'smooth',
                    label: 'Uniform term',
                    sub: 'ε · −logp.mean(-1)',
                    shape: '[N]',
                    detail:
                      'Label smoothing puts `ε / C` on every class; because cross-entropy is linear in the target this is `ε` times minus the row mean of `logp`.',
                  },
                ],
              ],
            },
            {id: 'mix', op: '+', detail: 'Per row: `(1 − ε) · nll + ε · smooth`. With `ε = 0` it is the plain NLL.'},
            {
              id: 'mask',
              label: 'Mask ignored rows',
              sub: 'loss = 0 where target is −100',
              detail: '`masked_fill(~valid, 0)` after the mixture: an ignored row contributes neither term.',
            },
            {
              id: 'loss',
              label: 'cross_entropy',
              sub: 'Σ loss / count of kept rows',
              kind: 'loss',
              shape: 'scalar',
              detail:
                '`loss.sum() / valid.sum().clamp(min=1)`: `reduction="mean"` with ignored targets divides by the kept rows, not `N`.',
            },
          ],
        ],
      },
    ],
    notes: [
      {at: 'shift', text: 'exp(1e4) is **inf**; exp(x − m) is at most **1**'},
      {at: 'sum', text: 'Never **0**, so its log is finite'},
      {at: 'logp', text: '**log p**: the one (N, C) tensor, no one-hot'},
      {at: 'loss', text: 'Divide by **kept rows**, not N'},
    ],
  },
  steps: [stableSoftmaxStep],
  learn,
};
