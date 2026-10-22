import type {Step} from '@/lib/types';

export const grpoLossStep: Step = {
  id: 'grpo-loss',
  title: 'The loss: clipped surrogate, k3 KL penalty, two aggregations',
  concept: 'pytorch',
  file: 'grpo_loss',
  focus: ['new-logp', 'ratio', 'surrogate', 'kl', 'loss'],
  task: `## Task

Write the GRPO objective as a loss to minimise (\`from grpo_advantage import group_advantages\` for the
self-test). No \`F.kl_div\`, no \`torch.distributions\`: the KL is estimated from the sampled tokens only.

\`grpo_loss(logp, old_logp, ref_logp, advantages, mask, clip_eps=0.2, beta=0.04, agg="seq-mean") ->
(loss, metrics)\`, with \`logp\`, \`old_logp\`, \`ref_logp\` and \`mask\` all \`(N, L)\` float32 and
\`advantages\` \`(N,)\`:

- \`ratio = exp(logp − old_logp)\` per token; \`logp\` carries the graph, \`old_logp\` and \`ref_logp\` are
  constants.
- The clipped surrogate with the completion's advantage \`A\` broadcast over its tokens:
  \`min(ratio · A, clamp(ratio, 1 − clip_eps, 1 + clip_eps) · A)\`, negated (a loss).
- The KL penalty with the **k3** estimator, \`exp(ref_logp − logp) − (ref_logp − logp) − 1\` per token,
  added as \`+ beta · k3\`.

Aggregation over the mask:

- \`"seq-mean"\`: each completion's mean over its own tokens (\`mask.sum(1)\`), then the mean over
  completions (the GRPO paper);
- \`"token-mean"\`: the sum over every completion token of the batch divided by their count (DAPO);
- anything else raises \`ValueError\`.

\`metrics\`, plain floats computed without a graph:

- \`"clip_frac"\`: the share of completion tokens where the clipped term wins (\`A > 0\` and \`ratio > 1 +
  ε\`, or \`A < 0\` and \`ratio < 1 − ε\`);
- \`"kl"\`: the mean k3 over completion tokens.

The self-test checks:
- at \`ratio = 1\` with \`beta = 0\`, the gradient is the policy gradient: \`−A_i / |o_i| / N\` per token
  for \`seq-mean\`, \`−A_i / T\` for \`token-mean\`, and the two differ when lengths differ;
- at \`ratio = 1.5\` the gradient is zero for \`A > 0\` and \`−ratio · A / N\` for \`A < 0\`, and the other way
  round at \`ratio = 0.5\`, with \`clip_frac = 0.5\` both times;
- k3 is never negative, its gradient is \`1 − exp(ref − logp)\`, and its mean over 400,000 tokens drawn
  from a 5-way categorical matches the exact \`KL(π ‖ π_ref)\` to 1%;
- masked positions change nothing.

It prints \`PASS\`.

> Clipping is one-sided: it removes the gradient only where the update has already gone far enough in
> the direction the advantage wants. A token that moved the wrong way is always pulled back.`,
  hints: [
    'Broadcast first: `adv = advantages.unsqueeze(1)` is `(N, 1)`. Then `per_token = -torch.min(ratio * adv, torch.clamp(ratio, 1 - clip_eps, 1 + clip_eps) * adv)`.',
    'k3 with `d = ref_logp - logp`: `torch.exp(d) - d - 1`. It is `≥ 0` because `e^d ≥ 1 + d`, and its expectation under the policy is `KL(π ‖ π_ref)` because `E_π[e^d] = Σ π_ref = 1`.',
    '`seq-mean`: `((per_token * mask).sum(1) / mask.sum(1).clamp(min=1)).mean()`. `token-mean`: `(per_token * mask).sum() / mask.sum()`. Compute the metrics under `torch.no_grad()` and return them with `.item()`.',
  ],
  checks: [
    {
      id: 'ratio',
      title: 'Importance ratio from log-probs',
      detail:
        '`torch.exp(logp - old_logp)`: the probability ratio `π_θ / π_old` per token, computed in log space. Dividing probabilities underflows for long completions.',
      match: {
        python: {
          all: [/exp\(\s*logp\s*-\s*old_logp\s*\)|\(\s*logp\s*-\s*old_logp\s*\)\.exp\(\)/],
        },
      },
    },
    {
      id: 'clipped-min',
      title: 'Clipped surrogate takes the minimum',
      detail:
        '`clamp(ratio, 1 - clip_eps, 1 + clip_eps)` and `torch.min` of the clipped and unclipped terms (or `torch.max` of their negations): the pessimistic bound is what makes clipping one-sided.',
      match: {
        python: {
          all: [
            /clamp\(\s*ratio\s*,\s*1(?:\.0)?\s*-\s*clip_eps\s*,\s*1(?:\.0)?\s*\+\s*clip_eps|ratio\.clamp\(\s*1(?:\.0)?\s*-\s*clip_eps\s*,\s*1(?:\.0)?\s*\+\s*clip_eps|clip\(\s*ratio\s*,\s*1(?:\.0)?\s*-\s*clip_eps/,
            /torch\.min(?:imum)?\(|torch\.max(?:imum)?\(\s*-/,
          ],
        },
      },
    },
    {
      id: 'k3',
      title: 'KL to the reference with the k3 estimator',
      detail:
        '`exp(ref_logp - logp) - (ref_logp - logp) - 1` per token, from the sampled tokens alone: unbiased and never negative. `F.kl_div` would need the full distributions over the vocabulary.',
      match: {
        python: {
          all: [/ref_logp\s*-\s*logp|logp\s*-\s*ref_logp/, /exp\(/],
          none: [/kl_div\(/, /kl_divergence\(/],
        },
      },
    },
    {
      id: 'beta',
      title: 'Penalty weighted by beta',
      detail:
        'The per-token loss adds `beta * kl`: with `beta = 0` the reference does not matter, as in DAPO and Dr. GRPO.',
      match: {python: {all: [/beta\s*\*|\*\s*beta\b/]}},
    },
    {
      id: 'seq-mean',
      title: 'seq-mean: per completion, then over completions',
      detail:
        'Masked sum per row divided by `mask.sum(1)`, then the mean over rows: each completion weighs the same however long it is, which is the GRPO paper’s `1/G Σ 1/|o_i| Σ_t`.',
      match: {
        python: {all: [/["']seq-mean["']/, /mask\.sum\(\s*(?:dim\s*=\s*)?-?1\s*(?:,\s*keepdim\s*=\s*True\s*)?\)/]},
      },
    },
    {
      id: 'token-mean',
      title: 'token-mean: over every token of the batch',
      detail:
        'The masked sum over the whole batch divided by `mask.sum()`: each token weighs the same, DAPO’s fix for long completions being under-weighted per token.',
      match: {python: {all: [/["']token-mean["']/, /\.sum\(\)\s*\/\s*mask\.sum\(\)/]}},
    },
    {
      id: 'metrics',
      title: 'Clip fraction and mean KL reported',
      detail:
        '`{"clip_frac": …, "kl": …}`: the two numbers that say whether the inner steps are moving too far from `π_old` and how far the policy has drifted from `π_ref`.',
      match: {python: {all: [/["']clip_frac["']\s*:/, /["']kl["']\s*:/]}},
    },
  ],
  code: {
    python: {
      starter: `"""The GRPO objective: PPO's clipped surrogate on group advantages, plus a k3 KL penalty to the reference."""

import torch

from grpo_advantage import group_advantages


def grpo_loss(
    logp: torch.Tensor,
    old_logp: torch.Tensor,
    ref_logp: torch.Tensor,
    advantages: torch.Tensor,
    mask: torch.Tensor,
    clip_eps: float = 0.2,
    beta: float = 0.04,
    agg: str = "seq-mean",
) -> tuple[torch.Tensor, dict[str, float]]:
    """GRPO loss to minimise, and its metrics.

    logp (N, L) carries the graph; old_logp and ref_logp (N, L) are constants; advantages (N,) is one value
    per completion, broadcast to its tokens; mask (N, L) float32 marks the completion tokens.
    agg="seq-mean" averages each completion over its own tokens, then over completions (GRPO);
    agg="token-mean" averages over every completion token of the batch (DAPO).
    """
    # TODO: ratio = exp(logp - old_logp); per-token loss = -min(ratio * A, clamp(ratio) * A)
    # + beta * k3(ref_logp - logp); aggregate over the mask with agg; metrics clip_frac and kl.
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    N, L, G = 6, 5, 3
    lengths = torch.tensor([5.0, 2.0, 4.0, 1.0, 5.0, 3.0])
    mask = (torch.arange(L) < lengths[:, None]).float()
    adv = group_advantages(torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 1.0]), G)
    old = -torch.rand(N, L) * 3

    # At ratio 1 the gradient is the policy gradient: -A_i / |o_i| / N per token (seq-mean), -A_i / T (token-mean).
    for agg, scale in (("seq-mean", lengths[:, None] * N), ("token-mean", mask.sum())):
        logp = old.clone().requires_grad_(True)
        loss, metrics = grpo_loss(logp, old, old, adv, mask, beta=0.0, agg=agg)
        loss.backward()
        assert torch.allclose(logp.grad, -adv[:, None] * mask / scale, atol=1e-6), agg
        assert abs(loss.item() - (-(adv[:, None] * mask) / scale).sum().item()) < 1e-6
        assert metrics["clip_frac"] == 0.0 and metrics["kl"] == 0.0

    # The two aggregations weigh tokens differently once lengths differ.
    a, _ = grpo_loss(old.clone(), old, old, adv, mask, beta=0.0, agg="seq-mean")
    b, _ = grpo_loss(old.clone(), old, old, adv, mask, beta=0.0, agg="token-mean")
    assert abs(a.item() - b.item()) > 1e-3

    # Clipping: outside [1 - eps, 1 + eps] on the side the advantage pushes towards, no gradient.
    one = torch.ones(4, 1)
    A = torch.tensor([1.0, 1.0, -1.0, -1.0])
    for ratio, live in ((1.5, [False, False, True, True]), (0.5, [True, True, False, False])):
        logp = torch.full((4, 1), torch.tensor(ratio).log().item()).requires_grad_(True)
        loss, metrics = grpo_loss(logp, torch.zeros(4, 1), logp.detach(), A, one, clip_eps=0.2, beta=0.0)
        loss.backward()
        # Where the unclipped term is the minimum, d(-ratio * A / 4) / dlogp = -ratio * A / 4; elsewhere 0.
        want = torch.where(torch.tensor(live), -ratio * A / 4, torch.zeros(4))
        assert torch.allclose(logp.grad.squeeze(1), want, atol=1e-6), (ratio, logp.grad)
        assert metrics["clip_frac"] == 0.5
    # Inside the trust region nothing is clipped.
    logp = torch.full((4, 1), torch.tensor(1.1).log().item()).requires_grad_(True)
    _, metrics = grpo_loss(logp, torch.zeros(4, 1), logp.detach(), A, one, clip_eps=0.2, beta=0.0)
    assert metrics["clip_frac"] == 0.0

    # k3 = exp(ref - logp) - (ref - logp) - 1 is never negative, and is zero only where ref == logp.
    lp, rp = -torch.rand(N, L) * 4, -torch.rand(N, L) * 4
    _, m = grpo_loss(lp, lp, rp, adv, torch.ones(N, L), beta=0.04)
    d = rp - lp
    assert abs(m["kl"] - (torch.exp(d) - d - 1).mean().item()) < 1e-6 and m["kl"] > 0
    assert bool(((torch.exp(d) - d - 1) >= 0).all())

    # Sampled from pi, k3 averages to the exact KL(pi || ref) of a small categorical.
    pi = torch.softmax(torch.tensor([1.0, 0.2, -0.5, 2.0, 0.0]), 0)
    ref = torch.softmax(torch.tensor([0.5, 0.5, 0.0, 1.0, -1.0]), 0)
    exact = (pi * (pi.log() - ref.log())).sum().item()
    x = torch.multinomial(pi, 400_000, replacement=True, generator=torch.Generator().manual_seed(0))
    lpx, rpx = pi.log()[x][None], ref.log()[x][None]
    _, m = grpo_loss(lpx, lpx, rpx, torch.zeros(1), torch.ones_like(lpx), beta=1.0)
    assert abs(m["kl"] - exact) < 0.01 * exact + 1e-3, (m["kl"], exact)

    # The penalty's gradient pulls logp towards ref: d k3 / d logp = 1 - exp(ref - logp).
    logp = lp.clone().requires_grad_(True)
    loss, _ = grpo_loss(logp, logp.detach(), rp, torch.zeros(N), torch.ones(N, L), beta=1.0, agg="token-mean")
    loss.backward()
    assert torch.allclose(logp.grad, (1 - torch.exp(rp - lp)) / (N * L), atol=1e-6)

    # Masked tokens change nothing.
    noisy = torch.where(mask.bool(), old, torch.randn(N, L))
    x1, _ = grpo_loss(old.clone(), old, old - 0.1, adv, mask)
    x2, _ = grpo_loss(noisy, old, torch.where(mask.bool(), old - 0.1, torch.randn(N, L)), adv, mask)
    assert torch.allclose(x1, x2, atol=1e-6)
    print(f"exact KL {exact:.4f}, k3 estimate {m['kl']:.4f}")
    print("PASS")
`,
      solution: `"""The GRPO objective: PPO's clipped surrogate on group advantages, plus a k3 KL penalty to the reference."""

import torch

from grpo_advantage import group_advantages


def grpo_loss(
    logp: torch.Tensor,
    old_logp: torch.Tensor,
    ref_logp: torch.Tensor,
    advantages: torch.Tensor,
    mask: torch.Tensor,
    clip_eps: float = 0.2,
    beta: float = 0.04,
    agg: str = "seq-mean",
) -> tuple[torch.Tensor, dict[str, float]]:
    """GRPO loss to minimise, and its metrics.

    logp (N, L) carries the graph; old_logp and ref_logp (N, L) are constants; advantages (N,) is one value
    per completion, broadcast to its tokens; mask (N, L) float32 marks the completion tokens.
    agg="seq-mean" averages each completion over its own tokens, then over completions (GRPO);
    agg="token-mean" averages over every completion token of the batch (DAPO).
    """
    ratio = torch.exp(logp - old_logp)
    adv = advantages.unsqueeze(1)
    surr = ratio * adv
    surr_clipped = torch.clamp(ratio, 1.0 - clip_eps, 1.0 + clip_eps) * adv
    per_token = -torch.min(surr, surr_clipped)

    log_r = ref_logp - logp
    kl = torch.exp(log_r) - log_r - 1.0  # k3: unbiased for KL(pi || ref), never negative
    if beta != 0.0:
        per_token = per_token + beta * kl

    if agg == "seq-mean":
        loss = ((per_token * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1.0)).mean()
    elif agg == "token-mean":
        loss = (per_token * mask).sum() / mask.sum().clamp(min=1.0)
    else:
        raise ValueError(f"unknown aggregation {agg!r}")

    with torch.no_grad():
        n_tokens = mask.sum().clamp(min=1.0)
        clipped = ((adv > 0) & (ratio > 1.0 + clip_eps)) | ((adv < 0) & (ratio < 1.0 - clip_eps))
        metrics = {
            "clip_frac": ((clipped.float() * mask).sum() / n_tokens).item(),
            "kl": ((kl * mask).sum() / n_tokens).item(),
        }
    return loss, metrics


if __name__ == "__main__":
    torch.manual_seed(0)
    N, L, G = 6, 5, 3
    lengths = torch.tensor([5.0, 2.0, 4.0, 1.0, 5.0, 3.0])
    mask = (torch.arange(L) < lengths[:, None]).float()
    adv = group_advantages(torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 1.0]), G)
    old = -torch.rand(N, L) * 3

    # At ratio 1 the gradient is the policy gradient: -A_i / |o_i| / N per token (seq-mean), -A_i / T (token-mean).
    for agg, scale in (("seq-mean", lengths[:, None] * N), ("token-mean", mask.sum())):
        logp = old.clone().requires_grad_(True)
        loss, metrics = grpo_loss(logp, old, old, adv, mask, beta=0.0, agg=agg)
        loss.backward()
        assert torch.allclose(logp.grad, -adv[:, None] * mask / scale, atol=1e-6), agg
        assert abs(loss.item() - (-(adv[:, None] * mask) / scale).sum().item()) < 1e-6
        assert metrics["clip_frac"] == 0.0 and metrics["kl"] == 0.0

    # The two aggregations weigh tokens differently once lengths differ.
    a, _ = grpo_loss(old.clone(), old, old, adv, mask, beta=0.0, agg="seq-mean")
    b, _ = grpo_loss(old.clone(), old, old, adv, mask, beta=0.0, agg="token-mean")
    assert abs(a.item() - b.item()) > 1e-3

    # Clipping: outside [1 - eps, 1 + eps] on the side the advantage pushes towards, no gradient.
    one = torch.ones(4, 1)
    A = torch.tensor([1.0, 1.0, -1.0, -1.0])
    for ratio, live in ((1.5, [False, False, True, True]), (0.5, [True, True, False, False])):
        logp = torch.full((4, 1), torch.tensor(ratio).log().item()).requires_grad_(True)
        loss, metrics = grpo_loss(logp, torch.zeros(4, 1), logp.detach(), A, one, clip_eps=0.2, beta=0.0)
        loss.backward()
        # Where the unclipped term is the minimum, d(-ratio * A / 4) / dlogp = -ratio * A / 4; elsewhere 0.
        want = torch.where(torch.tensor(live), -ratio * A / 4, torch.zeros(4))
        assert torch.allclose(logp.grad.squeeze(1), want, atol=1e-6), (ratio, logp.grad)
        assert metrics["clip_frac"] == 0.5
    # Inside the trust region nothing is clipped.
    logp = torch.full((4, 1), torch.tensor(1.1).log().item()).requires_grad_(True)
    _, metrics = grpo_loss(logp, torch.zeros(4, 1), logp.detach(), A, one, clip_eps=0.2, beta=0.0)
    assert metrics["clip_frac"] == 0.0

    # k3 = exp(ref - logp) - (ref - logp) - 1 is never negative, and is zero only where ref == logp.
    lp, rp = -torch.rand(N, L) * 4, -torch.rand(N, L) * 4
    _, m = grpo_loss(lp, lp, rp, adv, torch.ones(N, L), beta=0.04)
    d = rp - lp
    assert abs(m["kl"] - (torch.exp(d) - d - 1).mean().item()) < 1e-6 and m["kl"] > 0
    assert bool(((torch.exp(d) - d - 1) >= 0).all())

    # Sampled from pi, k3 averages to the exact KL(pi || ref) of a small categorical.
    pi = torch.softmax(torch.tensor([1.0, 0.2, -0.5, 2.0, 0.0]), 0)
    ref = torch.softmax(torch.tensor([0.5, 0.5, 0.0, 1.0, -1.0]), 0)
    exact = (pi * (pi.log() - ref.log())).sum().item()
    x = torch.multinomial(pi, 400_000, replacement=True, generator=torch.Generator().manual_seed(0))
    lpx, rpx = pi.log()[x][None], ref.log()[x][None]
    _, m = grpo_loss(lpx, lpx, rpx, torch.zeros(1), torch.ones_like(lpx), beta=1.0)
    assert abs(m["kl"] - exact) < 0.01 * exact + 1e-3, (m["kl"], exact)

    # The penalty's gradient pulls logp towards ref: d k3 / d logp = 1 - exp(ref - logp).
    logp = lp.clone().requires_grad_(True)
    loss, _ = grpo_loss(logp, logp.detach(), rp, torch.zeros(N), torch.ones(N, L), beta=1.0, agg="token-mean")
    loss.backward()
    assert torch.allclose(logp.grad, (1 - torch.exp(rp - lp)) / (N * L), atol=1e-6)

    # Masked tokens change nothing.
    noisy = torch.where(mask.bool(), old, torch.randn(N, L))
    x1, _ = grpo_loss(old.clone(), old, old - 0.1, adv, mask)
    x2, _ = grpo_loss(noisy, old, torch.where(mask.bool(), old - 0.1, torch.randn(N, L)), adv, mask)
    assert torch.allclose(x1, x2, atol=1e-6)
    print(f"exact KL {exact:.4f}, k3 estimate {m['kl']:.4f}")
    print("PASS")
`,
    },
  },
  debrief: `The surrogate is PPO's, unchanged: maximise \`ratio · A\`, but take the pessimistic minimum with a clipped copy, so the objective stops rewarding a token once its probability has moved by more than \`ε\` in the direction its advantage asks for. Where it moved the other way, the unclipped term is the smaller one and the gradient stays, so a mistake is always corrected. **The KL term** is where GRPO departs from InstructGPT-style PPO, which subtracts the KL from the reward; DeepSeekMath adds it to the loss directly, estimated per token with Schulman's k3, \`r − log r − 1\` with \`r = π_ref / π_θ\`: unbiased like \`log(π_θ/π_ref)\` but never negative, with lower variance. **Aggregation** is where the variants differ. The paper's \`seq-mean\` gives each completion equal weight, so a token in a 1,000-token answer counts 1/1,000 as much as one in a 1-token answer; Dr. GRPO showed this biases the policy towards long wrong answers (a long wrong answer is penalised less per token), and DAPO's \`token-mean\` weighs every token equally. TRL exposes the same choice as \`loss_type\` (\`grpo\`, \`dapo\`, \`dr_grpo\`, which divides by a constant instead). What production adds: asymmetric clipping (\`ε_low = 0.2\`, \`ε_high = 0.28\`, DAPO's clip-higher, which leaves room for low-probability tokens to grow), \`beta = 0\` (no reference model in memory at all), importance-sampling corrections when the rollout engine's log-probs differ from the trainer's, and the loss computed in chunks so the \`(N, L, V)\` logits never exist at once.`,
};
