import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {specDraftStep} from './steps/1-spec-draft';
import {specVerifyStep} from './steps/2-spec-verify';
import {specDecodeStep} from './steps/3-spec-decode';

/**
 * Deep-learning project: speculative decoding with exact acceptance, after Leviathan et al. and Chen et
 * al. A small draft proposes γ tokens through a rewindable KV cache, one target forward scores them,
 * the min(1, p/q) test and the residual resample keep the output distributed exactly as the target's,
 * and both caches roll back to the accepted length.
 */
export const ptSpeculativeDecodingProblem: Problem = {
  id: 'pt-speculative-decoding',
  title: 'Speculative decoding from scratch',
  tagline:
    'A small draft model proposes γ tokens, one target forward checks them all, and the min(1, p/q) test with a residual resample keeps the output exactly the target’s, with both KV caches rolled back to what was accepted.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 90,
  statement: `# Speculative decoding from scratch

Decoding a large model is memory-bound: every token reads all the weights once, and the arithmetic units
mostly wait. Speculative decoding, published at the same time by Leviathan, Kalman and Matias at Google
(ICML 2023) and by Chen et al. at DeepMind (2023), spends that idle compute. A small **draft** model
guesses the next γ tokens one by one; the large **target** model scores all of them in **one** forward
pass; a rejection-sampling rule keeps the longest acceptable prefix and replaces the first rejected
token. The output is distributed **exactly** as if the target had sampled every token itself, and each
target forward now emits between 1 and γ + 1 tokens. Hugging Face ships it as assisted generation,
vLLM, SGLang and TensorRT-LLM as speculative decoding, and Medusa and EAGLE replace the separate draft
with heads on the target. It sits in the serving stack between the sampler and the KV cache.

You write three files, each importing the previous one:

- \`spec_draft.py\`: \`LMConfig\`, \`KVCache(config, batch_size=1, dtype)\` with \`k\`, \`v\` of shape
  \`(n_layer, B, n_head, block_size, head_dim)\`, \`pos\` and \`truncate(n)\`; \`TinyLM.forward(idx (B, T) long,
  cache=None) -> logits (B, T, V)\` continuing from \`cache.pos\`; \`to_probs(logits, temperature)\`
  (one-hot at 0); and \`draft_tokens(draft, cache, last_token, gamma, temperature, generator) ->
  (tokens (γ,) long, q (γ, V))\`.
- \`spec_verify.py\`: \`verify_batch(target_probs (N, γ+1, V), draft_probs (N, γ, V), draft_tokens (N, γ),
  generator, greedy) -> (n_accepted (N,), next_token (N,))\` and \`verify(…)\` for one round, returning
  \`(n_accepted: int, next_token: int)\`.
- \`spec_decode.py\`: \`SpecStats\` with \`acceptance_rate\` and \`tokens_per_target_forward\`, and
  \`speculative_generate(target, draft, prompt (T,) long, max_new_tokens, gamma=4, temperature=1.0,
  generator=None) -> (tokens (T + max_new_tokens,) long, SpecStats)\`.

## What you build here

1. **The draft side.** A tiny GPT whose KV cache is a preallocated buffer with a length, so
   \`truncate(n)\` rewinds it for free; an offset causal mask so one forward serves prefill, decode and
   verification; and the draft loop that records every proposal's distribution \`q_i\`.
2. **Exact acceptance.** Keep \`x_i\` when \`u < min(1, p_i(x_i)/q_i(x_i))\`, stop at the first rejection and
   sample from \`norm(max(0, p − q))\`, or take a bonus token from \`p_γ\` when all γ pass; a greedy mode;
   and a vectorised test over 200,000 rounds that the emitted tokens follow \`p\` and the mean accepted
   length matches α's formula.
3. **The decoder.** Draft γ, one target forward over γ + 1 positions, verify, roll both caches back to the
   accepted length, repeat; greedy output identical to the target alone, sampled output following the
   target's distribution, and fewer target forwards than tokens.

## Run it on your machine

Put the three files in one directory and run \`python spec_draft.py\`, \`python spec_verify.py\` and
\`python spec_decode.py\` (PyTorch 2.x on CPU). The first two take a second or two; the third trains a
target and a draft on a synthetic Markov chain and runs 3,000 short decodes, about 15 s on a laptop.
Each prints \`PASS\`: the cache by matching full forwards to 1e-10 before and after a rollback, the
acceptance rule by matching \`p\` within a stated total-variation bound at every output position and the
accepted length within 0.02 of the formula, and the decoder by reproducing greedy target output token
for token and the target's sampling distribution four tokens out.

## Left out on purpose

Wall-clock speedup (tiny models on a CPU are not memory-bound, so the counters stand in for it), batched
speculation with ragged acceptance across sequences, adaptive γ, tree-structured drafts verified with a
tree attention mask (SpecInfer, [EAGLE](https://arxiv.org/abs/2401.15077)), draft heads on the target
itself ([Medusa](https://arxiv.org/abs/2401.10774)) and its typical acceptance, prompt-lookup and n-gram
drafts, top-k and top-p applied to both distributions, and paged KV caches.`,
  figures: [
    {
      title: 'One speculative round',
      architecture: {
        input: 'out = x_1 … x_t · caches hold t − 1',
        output: 'x_1 … x_(t+n+1) · caches hold t + n',
        items: [
          {
            id: 'context',
            label: 'Context and two caches',
            kind: 'io',
            sub: 'x_t = out[-1] not yet fed',
            detail:
              'Both KV caches hold every position but the last: the last token is fed at the start of the round, by the draft loop and by the target pass.',
          },
          {
            tone: 'block',
            repeat: 'γ ×',
            label: 'Draft loop',
            items: [
              {
                id: 'draft-fwd',
                label: 'Draft forward',
                sub: 'draft(token, dcache) · 1 position',
                shape: 'q_i · (V,)',
                detail:
                  'The small model, one token per call through its own KV cache. `q_i = to_probs(logits, temperature)`: the distribution the proposal is drawn from, kept for verification.',
              },
              {
                id: 'draft-sample',
                label: 'Sample a proposal',
                sub: 'x̃_i ~ q_i · multinomial',
                detail:
                  '`torch.multinomial(q_i, 1, generator=generator)`; at temperature 0, `q_i` is a one-hot and this is the argmax. The proposal is fed to the next draft forward.',
              },
            ],
          },
          {
            id: 'target-pass',
            label: 'One target forward',
            kind: 'attention',
            sub: '[x_t, x̃_1 … x̃_γ] · γ + 1 positions',
            shape: 'p_0 … p_γ · (γ + 1, V)',
            detail:
              'The large model scores the last token and all γ proposals in a single call: row `i` is the target after `out` plus the first `i` drafts. Memory-bound decoding makes this cost about as much as a one-token step.',
          },
          {
            id: 'accept',
            label: 'Accept while u < p / q',
            sub: 'u_i < min(1, p_i(x̃_i) / q_i(x̃_i))',
            side: {label: 'q_0 … q_(γ−1)', sub: 'from the draft loop'},
            detail:
              'One uniform per position. `n` is the number of accepts before the first rejection; a draft the target likes at least as much as the draft did is always kept.',
          },
          {
            columns: [
              [
                {
                  id: 'residual',
                  label: 'Residual resample',
                  sub: 'n < γ: norm(max(0, p_n − q_n))',
                  detail:
                    'At the first rejection, the replacement comes from the mass the target has and the draft lacks. Together with the accepts this gives exactly `p_n`.',
                },
              ],
              [
                {
                  id: 'bonus',
                  label: 'Bonus token',
                  sub: 'n = γ: x ~ p_γ',
                  detail:
                    'All γ drafts survived: the target pass already computed `p_γ`, so one more token comes for free.',
                },
              ],
            ],
          },
          {
            id: 'emit',
            label: 'Emit n + 1 tokens',
            kind: 'io',
            sub: 'x̃_1 … x̃_n, then the extra token',
            detail: 'Between 1 and γ + 1 tokens per target forward; the expectation is `(1 − α^(γ+1)) / (1 − α)`.',
          },
          {
            id: 'rollback',
            label: 'Roll both caches back',
            sub: 'truncate(len(out) − 1)',
            detail:
              'The target cache drops the positions of rejected drafts; the draft cache is cut to `min(dcache.pos, len(out) − 1)` and, after a full accept, is one short and catches up next round.',
          },
        ],
        notes: [
          {at: 'draft-fwd', text: '**γ** small forwards at cost **c** each'},
          {at: 'target-pass', text: '**One** big forward scores **γ + 1** positions'},
          {at: 'accept', text: 'Kept with probability **min(1, p/q)**'},
          {at: 'residual', text: '**min(p, q) + max(0, p − q) = p**: exact'},
          {at: 'rollback', text: 'A rewind is **one** integer per cache', side: 'left'},
        ],
      },
    },
    {
      title: 'The caches across a round',
      gpu: {
        items: [
          {
            id: 'tcache',
            label: 'Target KV cache',
            sub: 'positions 0 … 13 of block_size',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'tcache-before',
                array: 'before · pos = 8',
                cols: 14,
                cells: 'index',
                marks: [{cols: [8, 13], tone: 'muted', label: 'free'}],
                detail: 'Nine tokens of output, eight positions cached: `x_t` at position 8 is fed this round.',
              },
              {
                id: 'tcache-scored',
                array: 'after the γ + 1 pass · pos = 13',
                cols: 14,
                cells: 'index',
                marks: [
                  {cols: [8, 12], tone: 'global', label: 'x_t, x̃1 … x̃4'},
                  {cols: [13, 13], tone: 'muted'},
                ],
                detail:
                  'One target forward wrote keys and values for `x_t` and all four drafts (γ = 4), at positions 8 to 12.',
              },
              {
                id: 'tcache-rolled',
                array: 'after truncate(11) · n = 2',
                cols: 14,
                cells: 'index',
                marks: [
                  {cols: [8, 10], tone: 'global', label: 'kept'},
                  {cols: [11, 12], tone: 'bad', label: 'stale'},
                  {cols: [13, 13], tone: 'muted'},
                ],
                detail:
                  'Two drafts accepted, the third rejected and resampled: 12 tokens of output, 11 positions valid. Rows 11 and 12 still hold `x̃3`, `x̃4`; nothing reads them, the next forward overwrites them.',
              },
            ],
          },
          {
            id: 'dcache',
            label: 'Draft KV cache',
            sub: 'its own, smaller model',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'dcache-before',
                array: 'before · pos = 8',
                cols: 14,
                cells: 'index',
                marks: [{cols: [8, 13], tone: 'muted', label: 'free'}],
              },
              {
                id: 'dcache-drafted',
                array: 'after γ drafts · pos = 12',
                cols: 14,
                cells: 'index',
                marks: [
                  {cols: [8, 11], tone: 'global', label: 'x_t, x̃1 … x̃3'},
                  {cols: [12, 13], tone: 'muted'},
                ],
                detail:
                  'γ draft forwards feed `x_t` and the first three proposals; the fourth proposal is sampled but never fed, so a full accept leaves this cache one position short.',
              },
              {
                id: 'dcache-rolled',
                array: 'after truncate(11)',
                cols: 14,
                cells: 'index',
                marks: [
                  {cols: [8, 10], tone: 'global', label: 'kept'},
                  {cols: [11, 11], tone: 'bad', label: 'stale'},
                  {cols: [12, 13], tone: 'muted'},
                ],
                detail: '`min(dcache.pos, len(out) − 1)` = `min(12, 11)`: the same length as the target cache.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'tcache-before', to: 'tcache-scored', label: 'target(5 tokens)'},
          {from: 'tcache-scored', to: 'tcache-rolled', label: 'verify, truncate'},
          {from: 'dcache-before', to: 'dcache-drafted', label: 'draft × 4'},
          {from: 'dcache-drafted', to: 'dcache-rolled', label: 'truncate'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Fast Inference from Transformers via Speculative Decoding',
      url: 'https://arxiv.org/abs/2211.17192',
      by: 'Yaniv Leviathan, Matan Kalman and Yossi Matias',
      date: '2022-11-30',
      venue: 'ICML 2023',
      takes:
        'The `min(1, p/q)` acceptance, the residual `norm(max(0, p − q))`, the bonus token and the expected `(1 − α^(γ+1)) / (1 − α)` tokens per target call that `verify_batch` implements and tests.',
    },
    {
      kind: 'paper',
      title: 'Accelerating Large Language Model Decoding with Speculative Sampling',
      url: 'https://arxiv.org/abs/2302.01318',
      by: 'Charlie Chen et al.',
      date: '2023-02-02',
      venue: 'arXiv',
      takes:
        'The same modified rejection sampling, proved exact, and the draft-then-score loop around it that `speculative_generate` runs.',
    },
    {
      kind: 'paper',
      title: 'Blockwise Parallel Decoding for Deep Autoregressive Models',
      url: 'https://arxiv.org/abs/1811.03115',
      by: 'Mitchell Stern, Noam Shazeer and Jakob Uszkoreit',
      date: '2018-11-07',
      venue: 'NeurIPS 2018',
      takes:
        'The predecessor for greedy decoding: propose a block, verify it in one parallel pass, keep the longest prefix the model agrees with, which is the `greedy=True` path.',
    },
    {
      kind: 'code',
      title: 'transformers/generation/utils.py',
      url: 'https://github.com/huggingface/transformers/blob/v4.46.0/src/transformers/generation/utils.py',
      by: 'Hugging Face',
      date: '2024-10-24',
      venue: 'GitHub',
      takes:
        'The reference `_speculative_sampling`: the ratio test, `cumsum` to the first rejection and the clamped residual, the shape `verify` follows.',
    },
    {
      kind: 'post',
      title: 'Assisted Generation: a new direction toward low-latency text generation',
      url: 'https://huggingface.co/blog/assisted-generation',
      by: 'Joao Gante',
      date: '2023-05-11',
      venue: 'Hugging Face blog',
      takes:
        'Why decoding is memory-bound, so a γ + 1-token target pass costs about one step, and greedy assisted generation, whose output must equal the target’s: the identity `spec_decode.py` asserts.',
    },
  ],
  steps: [specDraftStep, specVerifyStep, specDecodeStep],
  learn,
};
