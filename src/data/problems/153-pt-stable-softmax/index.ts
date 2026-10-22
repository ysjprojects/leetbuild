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
  diagram: {
    nodes: [
      {id: 'logits', kind: 'client', label: 'logits', sub: '(N, C) · float32 / float64 · a row near 1e4', x: 10, y: 50},
      {id: 'logsoftmax', kind: 'service', label: 'log_softmax', sub: 'x − max · log-sum-exp', x: 35, y: 50},
      {id: 'softmax', kind: 'service', label: 'softmax', sub: 'exp(log p)', x: 60, y: 25},
      {
        id: 'ce',
        kind: 'service',
        label: 'cross_entropy',
        sub: 'gather · smoothing · ignore_index · mean',
        x: 60,
        y: 75,
      },
      {id: 'ref', kind: 'external', label: 'torch.nn.functional', sub: 'allclose · gradcheck', x: 90, y: 50},
    ],
    edges: [
      {from: 'logits', to: 'logsoftmax', kind: 'plain', label: 'x, dim'},
      {from: 'logsoftmax', to: 'softmax', kind: 'plain', label: 'log p'},
      {from: 'logsoftmax', to: 'ce', kind: 'plain', label: 'log p (N, C)'},
      {from: 'softmax', to: 'ref', kind: 'plain', label: 'F.softmax'},
      {from: 'ce', to: 'ref', kind: 'plain', label: 'F.cross_entropy'},
    ],
  },
  steps: [stableSoftmaxStep],
  learn,
};
