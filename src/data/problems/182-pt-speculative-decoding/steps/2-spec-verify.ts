import type {Step} from '@/lib/types';

export const specVerifyStep: Step = {
  id: 'spec-verify',
  title: 'Exact acceptance: accept, reject, resample',
  concept: 'pytorch',
  file: 'spec_verify',
  focus: ['accept', 'residual', 'bonus', 'emit'],
  task: `## Task

Decide which drafted tokens to keep so that the output is distributed **exactly** as if the target had
sampled every token itself (Leviathan et al., Algorithm 1; Chen et al., Algorithm 2). Then prove it
empirically. Pure tensor code; \`from spec_draft import to_probs\` is the only import from step 1.

- \`verify_batch(target_probs (N, γ+1, V), draft_probs (N, γ, V), draft_tokens (N, γ) long, generator=None,
  greedy=False) -> (n_accepted (N,) long, next_token (N,) long)\`, \`N\` independent rounds with no Python
  loop over them:
  - read \`p_i(x_i)\` and \`q_i(x_i)\` at the drafted tokens (\`gather\`);
  - one uniform per position, \`u = torch.rand(N, γ, generator=generator, dtype=…)\`, and accept \`x_i\`
    when \`u_i < min(1, p_i(x_i) / q_i(x_i))\`;
  - \`n_accepted\` is the run of accepts before the first rejection (\`cumprod\` of the accept mask, summed);
  - at the first rejection \`n\`, draw \`next_token\` from the residual \`norm(max(0, p_n − q_n))\`; if all γ were
    accepted, draw a **bonus** token from \`p_γ\`. Both with \`torch.multinomial(…, generator=generator)\`.
    Padding \`q\` with a zero row (\`F.pad\`) makes the bonus the residual of \`p_γ − 0\`: one code path.
  - \`greedy=True\`: accept while \`x_i == argmax p_i\`, then emit \`argmax p_n\`. No randomness.
- \`verify(target_probs (γ+1, V), draft_probs (γ, V), draft_tokens (γ,), generator=None, greedy=False) ->
  (n_accepted: int, next_token: int)\`: one round, as a batch of one. The caller emits
  \`draft_tokens[:n_accepted]\` and then \`next_token\`, so every round emits between 1 and γ + 1 tokens.
- \`expected_tokens_per_call(alpha, gamma)\` and \`tv\` are given.

The self-test (float64, V = 8, γ = 4, N = 200,000 rounds, fixed per-position \`p_i\` and \`q_i\`):
- \`q = p\` accepts all γ; a draft the target gives probability 0 is always rejected and never re-emitted;
  greedy mode accepts the matching prefix and emits the target's argmax.
- **Exactness.** For every output position \`k\`, among the rounds that reached it, the emitted token's
  empirical distribution is within total variation \`1.2 · √(V / count)\` of \`p_k\` (about three times
  the sampling noise), while \`q_k\`, and the wrong fix of resampling a rejection from \`p_k\`, are not.
- **Length.** The mean of \`n_accepted\` is \`Σ_k α_0 ⋯ α_(k−1)\` within 0.02, where
  \`α_i = Σ_x min(p_i(x), q_i(x))\`; with the same \`p\` and \`q\` at every position, tokens per round match
  \`(1 − α^(γ+1)) / (1 − α)\` within 0.02 and the first draft is accepted with probability α within 0.01.
- It prints the measured and predicted tokens per call, then \`PASS\`.

> Accept with probability min(1, p/q), and on rejection sample from what p has and q lacks. The two
> pieces add up to exactly p, whatever the draft is.`,
  hints: [
    '`gather` on the vocabulary axis with `draft_tokens[..., None]` reads `p_i(x_i)` and `q_i(x_i)` in one call each. `q_i(x_i) > 0` needs no guard: the token was drawn from `q_i`.',
    'A `cumprod` of the accept mask along the draft axis, summed, is the run before the first `False`. Index `p_n` per round with `[torch.arange(N), n]`; padding `draft_probs` with one zero row along γ lets the same index give `q_n`, or zeros when `n == gamma`.',
    'The residual is `(p_n - q_n).clamp(min=0)`, divided by its sum along the vocabulary. Rejection at position `n` happens only if `q_n(x) > p_n(x)` for the drafted `x`, so the sum is positive whenever it is needed.',
  ],
  checks: [
    {
      id: 'ratio-test',
      title: 'Accept while u < p(x) / q(x)',
      detail:
        'One uniform per drafted position, compared with `p_i(x_i) / q_i(x_i)` (or `u · q < p`, the same test): a draft the target likes at least as much is always kept, one it likes half as much is kept half the time.',
      match: {
        python: {
          all: [/torch\.rand\(/, /<=?\s*\(?\s*\w+\s*\/\s*\w+|\w+\s*\*\s*\w+\s*<=?\s*\w+/],
          none: [/\btransformers\b/],
        },
      },
    },
    {
      id: 'gather',
      title: 'p and q read at the drafted tokens',
      detail:
        '`p_i(x_i)` and `q_i(x_i)` come from indexing both distributions at `draft_tokens` (`gather`, or advanced indexing with the token ids).',
      match: {python: {all: [/\.gather\(|\[[^\]\n]*,\s*draft_tokens\s*\]/]}},
    },
    {
      id: 'first-rejection',
      title: 'Stops at the first rejection',
      detail:
        'Only the accepts before the first rejection count: `cumprod` of the accept mask (or a loop that breaks). A later accept follows a token that was never emitted, so it means nothing.',
      match: {python: {all: [/cumprod\(|\bbreak\b|cummin\(/]}},
    },
    {
      id: 'residual',
      title: 'Rejection resamples from norm(max(0, p − q))',
      detail:
        'The replacement token comes from `max(0, p_n − q_n)` normalised: the probability mass the target has and the draft lacks. Resampling from `p_n` would count the overlap twice.',
      match: {
        python: {
          all: [
            /clamp\(\s*min\s*=\s*0|clamp_min\(\s*0|relu\(|torch\.maximum\(|clamp\([^\n]*,\s*min\s*=\s*0/,
            /\/\s*\w+\.sum\(|\.div_?\(/,
          ],
        },
      },
    },
    {
      id: 'bonus',
      title: 'All accepted: a bonus token from p_γ',
      detail:
        'The target pass scored γ + 1 positions, so when every draft survives the last row `p_γ` still gives one more token for free (here: `q` padded with a zero row, or `target_probs[…, gamma]` directly).',
      match: {python: {all: [/F\.pad\(|target_probs\[\s*(?:[^\]\n]*,\s*)?(?:gamma|-1|n\w*)\s*\]/]}},
    },
    {
      id: 'generator',
      title: 'All randomness from the caller’s generator',
      detail:
        '`torch.rand(…, generator=generator)` for the uniforms and `torch.multinomial(…, generator=generator)` for the extra token: reproducible runs, and the self-test controls its own stream.',
      match: {
        python: {
          all: [/torch\.rand\([^\n]*generator\s*=\s*generator/, /torch\.multinomial\([^\n]*generator\s*=\s*generator/],
        },
      },
    },
    {
      id: 'greedy',
      title: 'Greedy mode matches the target’s argmax',
      detail:
        '`greedy=True` accepts while the draft equals `argmax p_i` and emits `argmax p_n`: exact for greedy decoding, with no random draw.',
      match: {python: {all: [/if\s+greedy\b/, /argmax\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""Speculative decoding, part 2: verify gamma drafted tokens against the target so the output is exactly the target's."""

import math

import torch
import torch.nn.functional as F

from spec_draft import to_probs


def verify_batch(
    target_probs: torch.Tensor,
    draft_probs: torch.Tensor,
    draft_tokens: torch.Tensor,
    generator: torch.Generator | None = None,
    greedy: bool = False,
) -> tuple[torch.Tensor, torch.Tensor]:
    """N independent verifications at once.

    target_probs (N, gamma + 1, V): p_0 .. p_gamma, the target after each drafted prefix.
    draft_probs (N, gamma, V): q_0 .. q_(gamma-1); draft_tokens (N, gamma) long, token i drawn from q_i.
    Returns n_accepted (N,) long in [0, gamma] and next_token (N,) long: the residual sample at the
    first rejection, or the bonus token from p_gamma when all gamma are accepted.
    """
    # TODO: greedy: accept while the draft equals the target's argmax, then emit the target's argmax.
    # Sampled: read p_i and q_i at the drafted tokens, one uniform per position, accept with
    # probability min(1, p_i / q_i), count the accepts before the first rejection, then sample the
    # next token from the normalised residual (or from p_gamma when nothing was rejected).
    raise NotImplementedError("TODO: the acceptance rule")


def verify(
    target_probs: torch.Tensor,
    draft_probs: torch.Tensor,
    draft_tokens: torch.Tensor,
    generator: torch.Generator | None = None,
    greedy: bool = False,
) -> tuple[int, int]:
    """One sequence: target_probs (gamma + 1, V), draft_probs (gamma, V), draft_tokens (gamma,).

    Returns (n_accepted, next_token): emit draft_tokens[:n_accepted], then next_token.
    """
    raise NotImplementedError("TODO: one sequence, as a batch of one")


def expected_tokens_per_call(alpha: float, gamma: int) -> float:
    """Leviathan et al., eq. 1: E[tokens emitted per target call] = (1 - alpha^(gamma+1)) / (1 - alpha)."""
    return gamma + 1.0 if alpha == 1.0 else (1 - alpha ** (gamma + 1)) / (1 - alpha)


def tv(a: torch.Tensor, b: torch.Tensor) -> float:
    """Total variation distance between two distributions over the same support."""
    return 0.5 * float((a - b).abs().sum())


if __name__ == "__main__":
    V, gamma, N = 8, 4, 200_000
    gen = torch.Generator().manual_seed(0)
    dt = torch.float64

    # Deterministic cases. q == p: every draft is accepted.
    p = F.softmax(torch.randn(gamma + 1, V, generator=gen, dtype=dt), dim=-1)
    tokens = torch.tensor([3, 1, 4, 1])
    n, _ = verify(p, p[:gamma], tokens, gen)
    assert n == gamma
    # p gives the first draft probability 0: it is always rejected, and never re-emitted.
    p0 = p.clone()
    p0[0, 3] = 0
    p0[0] /= p0[0].sum()
    for _ in range(50):
        n, token = verify(p0, p[:gamma], tokens, gen)
        assert n == 0 and token != 3
    # Greedy: accept while the draft equals the target's argmax, then emit the target's argmax.
    g = to_probs(torch.randn(gamma + 1, V, generator=gen, dtype=dt), 0.0)
    best = g.argmax(dim=-1)
    assert verify(g, g[:gamma], best[:gamma], greedy=True) == (gamma, int(best[gamma]))
    wrong = best[:gamma].clone()
    wrong[2] = (wrong[2] + 1) % V
    assert verify(g, g[:gamma], wrong, greedy=True) == (2, int(best[2]))

    def trials(p: torch.Tensor, q: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """N rounds with fixed per-position p_i, q_i: draft from q, verify against p."""
        drafted = torch.stack([torch.multinomial(q[i], N, replacement=True, generator=gen) for i in range(gamma)], dim=1)
        n, token = verify_batch(p.expand(N, -1, -1), q.expand(N, -1, -1), drafted, gen)
        return drafted, n, token

    # Exactness: every emitted position k follows p_k, although the drafts follow q_k.
    p = F.softmax(1.5 * torch.randn(gamma + 1, V, generator=gen, dtype=dt), dim=-1)
    q = F.softmax(p[:gamma].log() + torch.randn(gamma, V, generator=gen, dtype=dt), dim=-1)  # a draft that is roughly right
    drafted, n, token = trials(p, q)
    for k in range(gamma + 1):
        alive = n >= k  # the round emitted a token at position k
        count = int(alive.sum())
        at_k = torch.where(n[alive] > k, drafted[alive, min(k, gamma - 1)], token[alive])
        empirical = torch.bincount(at_k, minlength=V).to(dt) / count
        bound = 1.2 * math.sqrt(V / count)  # about 3x the expected TV of this many samples
        assert tv(empirical, p[k]) < bound, (k, tv(empirical, p[k]), bound)
        if k < gamma:
            # The test can tell: emitting drafts unchecked gives q_k, and resampling a rejection from p_k
            # instead of the residual gives min(p_k, q_k) + (1 - alpha_k) p_k.
            a_k = torch.minimum(p[k], q[k]).sum()
            assert tv(q[k], p[k]) > 3 * bound and tv(torch.minimum(p[k], q[k]) + (1 - a_k) * p[k], p[k]) > 2 * bound
    # Mean accepted length: E[n] = sum over k of alpha_0 ... alpha_(k-1), alpha_i = sum_x min(p_i, q_i).
    alpha = torch.minimum(p[:gamma], q).sum(dim=-1)
    expected = sum(float(alpha[:k].prod()) for k in range(1, gamma + 1))
    assert abs(float(n.to(dt).mean()) - expected) < 0.02, (float(n.to(dt).mean()), expected)

    # The same p and q at every position: the closed form (1 - alpha^(gamma+1)) / (1 - alpha).
    p1 = p[0].expand(gamma + 1, V)
    q1 = q[0].expand(gamma, V)
    a = float(torch.minimum(p1[0], q1[0]).sum())
    _, n, _ = trials(p1, q1)
    per_call = float((n + 1).to(dt).mean())
    assert abs(per_call - expected_tokens_per_call(a, gamma)) < 0.02, (per_call, a)
    assert abs(float((n > 0).to(dt).mean()) - a) < 0.01  # the first draft is accepted with probability alpha
    print(f"alpha = {a:.3f}: {per_call:.3f} tokens per target call, formula {expected_tokens_per_call(a, gamma):.3f}")
    print("PASS")
`,
      solution: `"""Speculative decoding, part 2: verify gamma drafted tokens against the target so the output is exactly the target's."""

import math

import torch
import torch.nn.functional as F

from spec_draft import to_probs


def verify_batch(
    target_probs: torch.Tensor,
    draft_probs: torch.Tensor,
    draft_tokens: torch.Tensor,
    generator: torch.Generator | None = None,
    greedy: bool = False,
) -> tuple[torch.Tensor, torch.Tensor]:
    """N independent verifications at once.

    target_probs (N, gamma + 1, V): p_0 .. p_gamma, the target after each drafted prefix.
    draft_probs (N, gamma, V): q_0 .. q_(gamma-1); draft_tokens (N, gamma) long, token i drawn from q_i.
    Returns n_accepted (N,) long in [0, gamma] and next_token (N,) long: the residual sample at the
    first rejection, or the bonus token from p_gamma when all gamma are accepted.
    """
    N, gamma = draft_tokens.shape
    rows = torch.arange(N)
    if greedy:
        accept = draft_tokens == target_probs[:, :gamma].argmax(dim=-1)
        n = accept.long().cumprod(dim=1).sum(dim=1)
        return n, target_probs[rows, n].argmax(dim=-1)
    p_x = target_probs[:, :gamma].gather(-1, draft_tokens[..., None]).squeeze(-1)
    q_x = draft_probs.gather(-1, draft_tokens[..., None]).squeeze(-1)
    u = torch.rand(N, gamma, generator=generator, dtype=target_probs.dtype)
    accept = u < (p_x / q_x).clamp(max=1.0)
    # n = the index of the first rejection, or gamma: the run of accepts before it.
    n = accept.long().cumprod(dim=1).sum(dim=1)
    # q padded with a zero row: at n == gamma the residual max(0, p - 0) is p_gamma itself, the bonus.
    q_n = F.pad(draft_probs, (0, 0, 0, 1))[rows, n]
    residual = (target_probs[rows, n] - q_n).clamp(min=0)
    residual = residual / residual.sum(dim=-1, keepdim=True)
    return n, torch.multinomial(residual, 1, generator=generator).squeeze(-1)


def verify(
    target_probs: torch.Tensor,
    draft_probs: torch.Tensor,
    draft_tokens: torch.Tensor,
    generator: torch.Generator | None = None,
    greedy: bool = False,
) -> tuple[int, int]:
    """One sequence: target_probs (gamma + 1, V), draft_probs (gamma, V), draft_tokens (gamma,).

    Returns (n_accepted, next_token): emit draft_tokens[:n_accepted], then next_token.
    """
    n, token = verify_batch(target_probs[None], draft_probs[None], draft_tokens[None], generator, greedy)
    return int(n[0]), int(token[0])


def expected_tokens_per_call(alpha: float, gamma: int) -> float:
    """Leviathan et al., eq. 1: E[tokens emitted per target call] = (1 - alpha^(gamma+1)) / (1 - alpha)."""
    return gamma + 1.0 if alpha == 1.0 else (1 - alpha ** (gamma + 1)) / (1 - alpha)


def tv(a: torch.Tensor, b: torch.Tensor) -> float:
    """Total variation distance between two distributions over the same support."""
    return 0.5 * float((a - b).abs().sum())


if __name__ == "__main__":
    V, gamma, N = 8, 4, 200_000
    gen = torch.Generator().manual_seed(0)
    dt = torch.float64

    # Deterministic cases. q == p: every draft is accepted.
    p = F.softmax(torch.randn(gamma + 1, V, generator=gen, dtype=dt), dim=-1)
    tokens = torch.tensor([3, 1, 4, 1])
    n, _ = verify(p, p[:gamma], tokens, gen)
    assert n == gamma
    # p gives the first draft probability 0: it is always rejected, and never re-emitted.
    p0 = p.clone()
    p0[0, 3] = 0
    p0[0] /= p0[0].sum()
    for _ in range(50):
        n, token = verify(p0, p[:gamma], tokens, gen)
        assert n == 0 and token != 3
    # Greedy: accept while the draft equals the target's argmax, then emit the target's argmax.
    g = to_probs(torch.randn(gamma + 1, V, generator=gen, dtype=dt), 0.0)
    best = g.argmax(dim=-1)
    assert verify(g, g[:gamma], best[:gamma], greedy=True) == (gamma, int(best[gamma]))
    wrong = best[:gamma].clone()
    wrong[2] = (wrong[2] + 1) % V
    assert verify(g, g[:gamma], wrong, greedy=True) == (2, int(best[2]))

    def trials(p: torch.Tensor, q: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """N rounds with fixed per-position p_i, q_i: draft from q, verify against p."""
        drafted = torch.stack([torch.multinomial(q[i], N, replacement=True, generator=gen) for i in range(gamma)], dim=1)
        n, token = verify_batch(p.expand(N, -1, -1), q.expand(N, -1, -1), drafted, gen)
        return drafted, n, token

    # Exactness: every emitted position k follows p_k, although the drafts follow q_k.
    p = F.softmax(1.5 * torch.randn(gamma + 1, V, generator=gen, dtype=dt), dim=-1)
    q = F.softmax(p[:gamma].log() + torch.randn(gamma, V, generator=gen, dtype=dt), dim=-1)  # a draft that is roughly right
    drafted, n, token = trials(p, q)
    for k in range(gamma + 1):
        alive = n >= k  # the round emitted a token at position k
        count = int(alive.sum())
        at_k = torch.where(n[alive] > k, drafted[alive, min(k, gamma - 1)], token[alive])
        empirical = torch.bincount(at_k, minlength=V).to(dt) / count
        bound = 1.2 * math.sqrt(V / count)  # about 3x the expected TV of this many samples
        assert tv(empirical, p[k]) < bound, (k, tv(empirical, p[k]), bound)
        if k < gamma:
            # The test can tell: emitting drafts unchecked gives q_k, and resampling a rejection from p_k
            # instead of the residual gives min(p_k, q_k) + (1 - alpha_k) p_k.
            a_k = torch.minimum(p[k], q[k]).sum()
            assert tv(q[k], p[k]) > 3 * bound and tv(torch.minimum(p[k], q[k]) + (1 - a_k) * p[k], p[k]) > 2 * bound
    # Mean accepted length: E[n] = sum over k of alpha_0 ... alpha_(k-1), alpha_i = sum_x min(p_i, q_i).
    alpha = torch.minimum(p[:gamma], q).sum(dim=-1)
    expected = sum(float(alpha[:k].prod()) for k in range(1, gamma + 1))
    assert abs(float(n.to(dt).mean()) - expected) < 0.02, (float(n.to(dt).mean()), expected)

    # The same p and q at every position: the closed form (1 - alpha^(gamma+1)) / (1 - alpha).
    p1 = p[0].expand(gamma + 1, V)
    q1 = q[0].expand(gamma, V)
    a = float(torch.minimum(p1[0], q1[0]).sum())
    _, n, _ = trials(p1, q1)
    per_call = float((n + 1).to(dt).mean())
    assert abs(per_call - expected_tokens_per_call(a, gamma)) < 0.02, (per_call, a)
    assert abs(float((n > 0).to(dt).mean()) - a) < 0.01  # the first draft is accepted with probability alpha
    print(f"alpha = {a:.3f}: {per_call:.3f} tokens per target call, formula {expected_tokens_per_call(a, gamma):.3f}")
    print("PASS")
`,
    },
  },
  debrief: `Why it is exact, in one line per case: token \`x\` is emitted at position \`i\` either because it was drafted and kept, with probability \`q(x) · min(1, p(x)/q(x)) = min(p(x), q(x))\`, or because some draft was rejected, with total probability \`1 − α = Σ max(0, p − q)\`, and then \`x\` was drawn from the residual with probability \`max(0, p(x) − q(x)) / (1 − α)\`. The sum is \`min(p, q) + max(0, p − q) = p\`. The draft's quality changes only how often the first branch fires: α is \`Σ min(p, q) = 1 − TV(p, q)\`, and with an i.i.d. α per position a round emits \`(1 − α^(γ+1)) / (1 − α)\` tokens on average. That is why the self-test can check exactness with any \`q\` at all, and why a bad draft costs speed, never quality. The vectorised form is how batched servers verify too: one \`gather\`, one comparison, one \`cumprod\`, one residual per sequence. Production adds the variants this step leaves out: typical acceptance (Medusa) trades exactness for longer runs, tree verification (SpecInfer, EAGLE) checks several drafted branches in one pass with a tree attention mask, and top-k or top-p go into \`p\`, the law the output must follow, while \`q\` must stay the distribution the draft really sampled from.`,
};
