/**
 * The learning guide for speculative decoding: why decoding leaves compute idle, the exact acceptance
 * rule and its proof, the expected tokens per target call and the speedup, rewindable KV caches, and
 * what the self-tests prove. Rendered at `/pt-speculative-decoding/learn`.
 */
export const learn = `# The mechanism at a glance

Speculative decoding makes a large language model produce several tokens per forward pass without
changing what it produces. A small **draft** model guesses the next γ tokens one at a time; the large
**target** model scores all of them in one forward pass; a rejection-sampling rule keeps the longest
acceptable prefix and replaces the first rejected token with a sample from a corrected distribution. It
was published twice within weeks: by Leviathan, Kalman and Matias at Google as *speculative decoding*
(ICML 2023), and by Chen et al. at DeepMind as *speculative sampling*. Both prove the same thing: the
output is distributed **exactly** as the target's own samples.

The project builds it in three files. \`draft_tokens\` proposes γ tokens through a KV cache that can be
rewound; \`verify(target_probs, draft_probs, draft_tokens, generator)\` returns how many proposals to keep
and the one extra token; \`speculative_generate\` runs the rounds and rolls both caches back after each.

:::architecture
{
  "input": "out = x_1 … x_t",
  "output": "x_1 … x_(t+n+1)",
  "items": [
    {"id": "g-context", "label": "Context", "kind": "io", "sub": "both caches hold t − 1 positions"},
    {"tone": "block", "repeat": "γ ×", "label": "Draft loop", "items": [
      {"id": "g-draft", "label": "Draft forward", "sub": "1 position · q_i = softmax(z / T)", "detail": "The small model, one token per call, through its own KV cache."},
      {"id": "g-sample", "label": "Sample a proposal", "sub": "x̃_i ~ q_i"}
    ]},
    {"id": "g-target", "label": "One target forward", "kind": "attention", "sub": "γ + 1 positions → p_0 … p_γ", "detail": "Row i is the target's distribution after the context plus the first i proposals."},
    {"id": "g-accept", "label": "Accept while u < p / q", "sub": "n = accepts before the first reject", "side": {"label": "q_0 … q_(γ−1)", "sub": "from the draft"}},
    {"columns": [
      [{"id": "g-residual", "label": "Residual resample", "sub": "n < γ: norm(max(0, p_n − q_n))"}],
      [{"id": "g-bonus", "label": "Bonus token", "sub": "n = γ: x ~ p_γ"}]
    ]},
    {"id": "g-rollback", "label": "Roll both caches back", "sub": "truncate(len(out) − 1)"}
  ],
  "notes": [
    {"at": "g-target", "text": "**One** target call per round, not per token"},
    {"at": "g-accept", "text": "Kept with probability **min(1, p/q)**"},
    {"at": "g-residual", "text": "Output law is **exactly p**"},
    {"at": "g-rollback", "text": "A rewind moves **one** integer", "side": "left"}
  ]
}
:::

A round emits between 1 and γ + 1 tokens for one target call. How many, on average, depends on one
number, the **acceptance rate** α, the probability that the target accepts a drafted token. How much
faster the whole thing runs depends on two more: γ, and c, the cost of a draft forward relative to a
target forward.

| symbol | meaning | in the project |
|---|---|---|
| \`p_i\` | the target's next-token distribution after the context plus \`i\` drafts | rows of \`to_probs(target(…))\`, shape \`(γ + 1, V)\` |
| \`q_i\` | the draft's distribution that proposal \`i\` was drawn from | \`draft_tokens\`'s second output, \`(γ, V)\` |
| γ | proposals per round | \`gamma\`, clipped near the end |
| α | \`Σ_x min(p(x), q(x))\`, the chance one proposal is accepted | measured by \`acceptance_rate\` |
| c | draft forward time over target forward time | not measured on a CPU |

# Why decoding leaves compute idle

A decode step multiplies one token's activations by every weight matrix. Each weight is read from
memory once and used for one multiply-add per token in the batch. For a 70B-parameter model in bf16
that is 140 GB read for 140 GFLOP of work: one FLOP per byte. An H100 SXM moves about 3.35 TB/s and
computes about 990 TFLOP/s of dense bf16, so it needs roughly 300 FLOPs per byte to keep its arithmetic
busy. Decoding one token runs at a third of a percent of that.

The consequence is that scoring several positions in one forward costs almost nothing extra. The
weights are read once whatever the number of positions; only the arithmetic grows.

| positions in one forward | weights read | FLOPs | time at 3.35 TB/s | time at 990 TFLOP/s | bound |
|---|---|---|---|---|---|
| 1 (ordinary decode) | 140 GB | 140 G | 41.8 ms | 0.14 ms | memory |
| 5 (γ = 4) | 140 GB | 700 G | 41.8 ms | 0.71 ms | memory |
| 9 (γ = 8) | 140 GB | 1.26 T | 41.8 ms | 1.27 ms | memory |

The table ignores the KV cache reads and the attention itself, which grow with the context and do not
change the conclusion at these sizes. Training and prefill use this headroom by processing many tokens
at once. Decoding cannot, because token \`t + 1\` depends on token \`t\`: the target has to know what came
before. Speculative decoding breaks the dependency with a guess. If something cheap can propose the next
few tokens, the target can check them all in one memory-bound pass, at the price of one decode step.

Batching many requests is the other way to fill the idle compute, and it raises throughput rather than
cutting the latency of one sequence. The two combine poorly: at large batch sizes decoding approaches
the compute bound, and the extra positions speculation adds are no longer free. Speculative decoding is
a latency technique for the memory-bound regime: small batches, interactive use.

:::quiz
Q: Why does the target pass over γ + 1 positions cost about the same as a one-token decode step?
- [ ] The target only computes logits for the last position
- [x] Decoding is limited by reading the weights, which happens once per forward whatever the number of positions
- [ ] The draft model has already computed the target's hidden states
> At one token, a decode step does about one FLOP per byte of weights read, far below the hundreds a GPU
> needs to be compute-bound. Adding positions adds FLOPs but not weight reads, so the time stays at the
> memory bound until the positions number in the hundreds.
:::

# The acceptance rule, and why it is exact

The draft proposed \`x\` from \`q\`; the target says the right distribution is \`p\`. The rule:

\`\`\`text
accept x                        with probability min(1, p(x) / q(x))
otherwise sample a replacement  from  r(x) = max(0, p(x) − q(x)) / Σ_y max(0, p(y) − q(y))
\`\`\`

The probability that \`x\` comes out has two parts. Drafted and kept: \`q(x) · min(1, p(x)/q(x)) =
min(p(x), q(x))\`. Some draft rejected, then \`x\` drawn from the residual: the total rejection probability
is \`Σ_y q(y) (1 − min(1, p(y)/q(y))) = Σ_y max(0, q(y) − p(y)) = Σ_y max(0, p(y) − q(y))\`, which is exactly
the residual's normaliser, so this part is \`max(0, p(x) − q(x))\`. Their sum is \`min(p, q) + max(0, p − q)
= p\`. Nothing in the argument depends on how good \`q\` is: a bad draft is rejected more often, so it costs
speed, never quality.

The same argument applies position by position. Position \`i\` is only reached if every earlier draft was
accepted, so its context is exactly what the target would have produced, and \`p_i\` is the right
distribution to test against. At the first rejection the round ends; the drafts after it were built on
a token that was never emitted. If all γ survive, the target pass has already computed \`p_γ\`, the
distribution after the last draft, and one more token is sampled from it: the **bonus**. The project
writes both cases as one: pad \`q\` with a zero row, and the residual of \`p_γ − 0\` is \`p_γ\` itself.

A worked example over three tokens, with \`p = (0.5, 0.3, 0.2)\` and \`q = (0.2, 0.6, 0.2)\`:

| token | p | q | kept: min(p, q) | residual max(0, p − q) | rejection mass × residual | emitted |
|---|---|---|---|---|---|---|
| A | 0.5 | 0.2 | 0.2 | 0.3 | 0.3 × 1.0 = 0.3 | **0.5** |
| B | 0.3 | 0.6 | 0.3 | 0 | 0 | **0.3** |
| C | 0.2 | 0.2 | 0.2 | 0 | 0 | **0.2** |
| | | | α = 0.7 | sum 0.3 | | = p |

The obvious shortcuts all produce fluent text and the wrong distribution, which is why the self-test in
\`spec_verify.py\` measures distributions rather than reading outputs. On the same example:

| rule | emitted (A, B, C) | total variation from p |
|---|---|---|
| exact: accept with min(1, p/q), resample from the residual | (0.50, 0.30, 0.20) | 0 |
| keep every draft | (0.20, 0.60, 0.20) | 0.30 |
| accept with min(1, p/q), resample from p | (0.35, 0.39, 0.26) | 0.15 |
| accept when p(x) ≥ q(x), no coin, resample from the residual | (0.80, 0, 0.20) | 0.30 |

Resampling from \`p\` is the subtle one: tokens the draft already proposes often get a second chance, and
A, the token the draft under-proposes, is starved. The residual hands the rejected mass only to tokens
where the target wants more than the draft gave.

:::quiz
Q: A draft proposes token x with q(x) = 0.4 while p(x) = 0.1. How often is x kept, and where does the rejected mass go?
- [ ] Never, and the replacement is drawn from p
- [x] A quarter of the time; on rejection the replacement is drawn from the tokens where p exceeds q
- [ ] Always, because the draft drew it, and the error is corrected at the next position
> min(1, 0.1 / 0.4) = 0.25, so x is emitted with probability 0.4 × 0.25 = 0.1, exactly p(x). The other
> three quarters of the time the round ends and the residual max(0, p − q) supplies the token; x has
> residual 0, so it cannot come back that way.
:::

# Tokens per target call: α, γ and the draft's cost

If each proposal is accepted independently with probability α, a round accepts the first \`k\` and stops
with probability \`α^k (1 − α)\`, and accepts all γ with probability \`α^γ\`. Counting the extra token, the
expected number of tokens a round emits is

\`\`\`text
E[tokens per target call] = 1 + α + α² + … + α^γ = (1 − α^(γ+1)) / (1 − α)
\`\`\`

and α itself is \`Σ_x min(p(x), q(x)) = 1 − TV(p, q)\`: one minus the total variation distance between the
two models' next-token distributions. A round also costs γ draft forwards. With c the time of a draft
forward over a target forward, Leviathan et al.'s walltime improvement is

\`\`\`text
speedup = (1 − α^(γ+1)) / ((1 − α)(γc + 1))
\`\`\`

| acceptance rate | 1 draft | 2 drafts | 4 drafts | 8 drafts | best draft length, c = 0.1 |
|---|---|---|---|---|---|
| 0.6 | 1.60 · 1.45× | 1.96 · 1.63× | 2.31 · 1.65× | 2.47 · 1.37× | 3 · 1.67× |
| 0.8 | 1.80 · 1.64× | 2.44 · 2.03× | 3.36 · 2.40× | 4.33 · 2.40× | 6 · 2.47× |
| 0.9 | 1.90 · 1.73× | 2.71 · 2.26× | 4.10 · 2.93× | 6.13 · 3.40× | 10 · 3.43× |

Each cell is tokens per target call, then the speedup at c = 0.1. Three things stand out. Tokens per call
saturate at \`1 / (1 − α)\`: at α = 0.6 no γ ever gives more than 2.5. Long drafts pay γc per round for
proposals that are almost never reached, so the speedup has a best γ, and it falls as c grows. And the
gain is far more sensitive to α than to γ, which is why so much later work goes into better drafts
rather than longer ones. Slide α, γ and c, and step through a run under the same independence
assumption:

:::widget speculative-decoding {"alpha": 0.8, "gamma": 4, "cost": 0.1}

The independence assumption is a simplification. Real acceptance varies with the text: boilerplate,
code and repeated spans are easy to draft, the first token of an answer is not. The self-test in
\`spec_verify.py\` checks both forms: with different \`p_i\` and \`q_i\` at every position, the mean accepted
length is \`Σ_k α_0 ⋯ α_(k−1)\`; with the same pair everywhere, tokens per round match the closed form
within 0.02 over 200,000 rounds.

:::quiz
Q: At α = 0.6 and c = 0.1, doubling γ from 4 to 8 does what to the speedup?
- [ ] Nearly doubles it, since twice as many tokens are proposed
- [ ] Leaves it unchanged, since tokens per call are capped
- [x] Lowers it, from about 1.65× to 1.37×: tokens per call barely rise while the draft cost per round grows
> Tokens per call go from 2.31 to 2.47, approaching the ceiling 1 / (1 − 0.6) = 2.5. The round's cost goes
> from 1.4 to 1.8 target-forward times, so the ratio drops.
:::

# Caches that rewind

Both models keep a KV cache, and every rejection leaves positions in them that the output never
contains. The target scored \`x_t\` and all γ drafts, so its cache holds γ + 1 new positions; the draft
fed \`x_t\` and the first γ − 1 proposals, so its cache holds γ. After \`n\` accepts, the output has grown
by \`n + 1\` and each cache must hold exactly \`len(out) − 1\` positions before the next round.

:::gpu
{
  "items": [
    {"id": "g-tcache", "label": "Target KV cache", "sub": "γ = 4, n = 2", "tone": "global", "layout": "column", "items": [
      {"id": "g-t0", "array": "before · pos = 8", "cols": 14, "cells": "index", "marks": [{"cols": [8, 13], "tone": "muted", "label": "free"}]},
      {"id": "g-t1", "array": "after the γ + 1 pass · pos = 13", "cols": 14, "cells": "index", "marks": [{"cols": [8, 12], "tone": "global", "label": "x_t, x̃1 … x̃4"}, {"cols": [13, 13], "tone": "muted"}]},
      {"id": "g-t2", "array": "after truncate(11)", "cols": 14, "cells": "index", "marks": [{"cols": [8, 10], "tone": "global", "label": "kept"}, {"cols": [11, 12], "tone": "bad", "label": "stale"}, {"cols": [13, 13], "tone": "muted"}]}
    ]},
    {"id": "g-dcache", "label": "Draft KV cache", "sub": "fed one token per draft", "tone": "global", "layout": "column", "items": [
      {"id": "g-d0", "array": "before · pos = 8", "cols": 14, "cells": "index", "marks": [{"cols": [8, 13], "tone": "muted", "label": "free"}]},
      {"id": "g-d1", "array": "after γ drafts · pos = 12", "cols": 14, "cells": "index", "marks": [{"cols": [8, 11], "tone": "global", "label": "x_t, x̃1 … x̃3"}, {"cols": [12, 13], "tone": "muted"}]},
      {"id": "g-d2", "array": "after truncate(11)", "cols": 14, "cells": "index", "marks": [{"cols": [8, 10], "tone": "global", "label": "kept"}, {"cols": [11, 11], "tone": "bad", "label": "stale"}, {"cols": [12, 13], "tone": "muted"}]}
    ]}
  ],
  "arrows": [
    {"from": "g-t0", "to": "g-t1", "label": "target(5 tokens)"},
    {"from": "g-t1", "to": "g-t2", "label": "truncate"},
    {"from": "g-d0", "to": "g-d1", "label": "draft × 4"},
    {"from": "g-d1", "to": "g-d2", "label": "truncate"}
  ]
}
:::

With a preallocated buffer and a length, rewinding is \`self.pos = n\`. The rows past \`n\` still hold the
rejected drafts' keys and values; that is harmless as long as attention reads \`k[…, : pos + T]\` and never
the whole buffer, and the next forward overwrites them. A cache grown with \`torch.cat\` would instead need
a slice-and-copy per rollback, and a cache that is never truncated silently attends to tokens the output
does not contain.

| after a round with n accepts | target cache | draft cache | next round |
|---|---|---|---|
| correct, n < γ | \`truncate(len(out) − 1)\` | \`truncate(min(pos, len(out) − 1))\` | both caches match the output |
| correct, n = γ | \`truncate(len(out) − 1)\`, a no-op | one short: \`x̃_γ\` was never fed | feed it, then draft |
| no truncation | keeps rejected keys | keeps rejected keys | positions shifted; tokens fluent, distribution wrong |
| attention over the whole buffer | reads stale rows | reads stale rows | the same, and only after the first rejection |
| full accept, no catch-up | correct | a gap at \`x̃_γ\` | every later \`q\` is wrong; still exact, only slower |

The last row is worth a second look. A wrong draft cache does not break exactness, because the
acceptance rule is exact for any \`q\` as long as \`q\` is the distribution the proposal was really drawn
from; it only lowers α. A wrong target cache does break it, since \`p\` is then not the target's
distribution. The greedy identity test in \`spec_decode.py\` catches the target-side bugs at once: greedy
verification is deterministic, so any drift shows up as a different token.

:::quiz
Q: A round accepts all γ drafts. Which cache is behind, and why?
- [ ] The target cache, because the bonus token was sampled after its forward
- [x] The draft cache, because the last proposal was sampled but never fed to the draft
- [ ] Neither: both caches hold the accepted drafts
> The draft loop feeds x_t and proposals 1 to γ − 1, drawing proposal γ from the last forward's output
> without feeding it. The target fed all γ, so after the round its cache holds len(out) − 1 positions and
> the draft's holds one fewer.
:::

# Greedy decoding and what the tests prove

At temperature 0 the target's distribution is a one-hot on its argmax. Put that into the rule:
\`min(1, p(x)/q(x))\` is 1 if the draft guessed the argmax and 0 otherwise, and the residual is the one-hot
itself. Speculative decoding reduces to: keep drafts while they equal the target's argmax, then emit the
target's argmax. That is exactly the earlier
[Blockwise Parallel Decoding](https://arxiv.org/abs/1811.03115) of Stern, Shazeer and Uszkoreit (2018),
which proposed blocks with extra heads and kept the longest prefix the model agreed with, and it is the
\`greedy=True\` path in \`verify\`.

The self-tests are designed so a wrong implementation cannot pass by producing plausible tokens:

- **Distribution at every position.** Over 200,000 vectorised rounds with fixed \`p_i\` and \`q_i\`, the token
  emitted at output position \`k\` is compared with \`p_k\` in total variation. The bound \`1.2 · √(V /
  count)\` is about three times the sampling noise of \`count\` draws over \`V\` outcomes, and the test also
  asserts that \`q_k\` and the resample-from-\`p\` mixture are well outside it, so the bound is tight enough
  to tell.
- **Accepted length.** The mean of \`n_accepted\` against \`Σ_k α_0 ⋯ α_(k−1)\`, and the closed form
  \`(1 − α^(γ+1)) / (1 − α)\` when all positions share \`p\` and \`q\`.
- **End to end.** \`spec_decode.py\` computes the trained target's exact distribution of each of the next
  four tokens by enumerating all 16³ prefixes in one batched forward, then checks 3,000 speculative runs
  against it with γ = 2, so most runs span two or three rounds and their rollbacks.

:::details Why compare marginals rather than whole sequences
The joint distribution of four tokens over a 16-token vocabulary has 65,536 outcomes; 3,000 samples say
almost nothing about it. Each position's marginal has 16 outcomes, so the same samples pin it to a few
hundredths. A bug in rollback or in the draft catch-up shifts the later positions' marginals, which is
where the test looks.
:::

:::quiz
Q: With temperature 0, what does the acceptance rule reduce to?
- [x] Keep drafts while each equals the target's argmax, then emit the target's argmax
- [ ] Keep every draft whose target probability exceeds 0.5
- [ ] Keep drafts with probability α and resample the rest uniformly
> A one-hot p makes min(1, p(x)/q(x)) either 1 (x is the argmax) or 0, and the residual max(0, p − q) is the
> one-hot on the argmax. The output is the target's greedy sequence, token for token.
:::

# What production systems add

The project's loop is the whole algorithm for one sequence. Serving engines change the parts around it.

- **Drafts without a second model.** [Medusa](https://arxiv.org/abs/2401.10774) adds extra decoding heads
  to the target that predict several tokens ahead from its last hidden state; [EAGLE](https://arxiv.org/abs/2401.15077)
  drafts at the feature level with a one-layer head. Prompt lookup drafts by copying an n-gram that already
  appeared in the context, which works well for editing and retrieval.
- **Trees instead of chains.** Several candidate continuations are verified in one target pass with an
  attention mask that lets each branch see only its own ancestors; the longest accepted path wins.
- **Batching.** Sequences in a batch accept different numbers of tokens, so cache lengths, positions and
  the next round's inputs become ragged, and paged caches free the blocks of rejected slots.
- **Sampling filters.** Top-k and top-p must be applied to both \`p\` and \`q\` before the test; the
  guarantee holds for whatever distributions go in. Medusa's typical acceptance relaxes exactness for
  longer accepted runs.
- **The reference implementation.** Hugging Face's
  [\`_speculative_sampling\`](https://github.com/huggingface/transformers/blob/v4.46.0/src/transformers/generation/utils.py)
  is the same ratio test, a \`cumsum\` to the first rejection and the clamped residual, and its
  [assisted generation post](https://huggingface.co/blog/assisted-generation) walks through the
  memory-bound argument and the greedy case.

:::quiz
Q: Why do serving engines use tree-structured drafts?
- [ ] Trees make the acceptance rule exact, which chains are not
- [x] One target pass can verify several candidate continuations, raising the expected accepted length per call
- [ ] Trees remove the need for a KV cache rollback
> A chain fails at its first wrong guess. With a tree, the target scores several alternatives at each
> depth in the same memory-bound pass, using a mask so each branch attends only to its ancestors, and the
> longest accepted path is kept.
:::

# What to take away

- Decoding is memory-bound: one forward over γ + 1 positions costs about one decode step, and
  speculative decoding spends that headroom on checking guesses.
- Accept with probability \`min(1, p/q)\`, resample a rejection from \`norm(max(0, p − q))\`, take a bonus
  from \`p_γ\` when all pass: the output is exactly the target's, for any draft.
- A round emits \`(1 − α^(γ+1)) / (1 − α)\` tokens on average, with α = 1 − TV(p, q); the speedup divides
  that by \`γc + 1\` and has a best γ.
- Rollbacks must be free and exact: a preallocated cache with a length, reads limited to \`[: pos + T]\`,
  both caches truncated every round, and the draft fed its last proposal after a full accept.
- Test it on distributions, not samples: greedy identity, per-position total variation, and the accepted
  length against the formula.

Primary references: Leviathan, Kalman and Matias, [Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192) (ICML 2023), and Chen et al., [Accelerating Large Language Model Decoding with Speculative Sampling](https://arxiv.org/abs/2302.01318) (2023).
`;
