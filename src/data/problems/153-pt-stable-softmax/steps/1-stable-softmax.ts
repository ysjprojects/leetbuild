import type {Step} from '@/lib/types';

/**
 * A library softmax / log-softmax / cross-entropy (or the log-sum-exp that makes them one line)
 * called anywhere between the first implementation `def` and the self-test's main guard. The
 * self-test below the guard is where the reference belongs.
 */
const LIBRARY_SHORTCUT =
  /def (log_softmax|softmax|cross_entropy)\b(?:(?!\nif __name__)[\s\S])*?\.(log_softmax|softmax|logsumexp|cross_entropy|nll_loss|CrossEntropyLoss|LogSoftmax|Softmax|NLLLoss)\(/;

export const stableSoftmaxStep: Step = {
  id: 'stable-softmax',
  title: 'log_softmax, softmax and cross_entropy, stable by construction',
  concept: 'pytorch',
  file: 'stable_softmax',
  focus: ['shift', 'exp', 'sum', 'log', 'logp', 'softmax', 'gather', 'smooth', 'mix', 'mask', 'loss'],
  task: `## Task

Implement three functions in \`stable_softmax.py\`, with plain tensor ops only — none of
\`torch.nn.functional.log_softmax\` / \`softmax\` / \`cross_entropy\` / \`nll_loss\`, no \`torch.logsumexp\`,
no \`nn.CrossEntropyLoss\`. They are what the self-test at the bottom compares you against.

- \`log_softmax(x, dim=-1)\`: \`x - m - log(sum(exp(x - m), dim))\` with \`m = x.amax(dim, keepdim=True)\`.
  Any shape, any \`dim\`, float32 or float64 in, same dtype out. A row of logits around \`1e4\` must come
  out finite: \`exp(1e4)\` is \`inf\` in both dtypes, \`exp(x - m)\` is in \`(0, 1]\`.
- \`softmax(x, dim=-1)\`: \`log_softmax(x, dim).exp()\`. Not a second formula — one place to get the
  numerics right.
- \`cross_entropy(logits, targets, label_smoothing=0.0, ignore_index=-100)\`: \`logits\` is \`(N, C)\`,
  \`targets\` is \`(N,)\` of \`int64\` class ids, or \`ignore_index\` for a position that must not count.
  One \`log_softmax\` over \`dim=-1\`, then **gather** the target column (\`logp.gather(1, …)\`): no one-hot,
  no \`.exp()\` of the whole \`(N, C)\` tensor. Per row,
  \`loss = (1 - label_smoothing) * nll + label_smoothing * (-logp.mean(dim=-1))\`. Ignored rows contribute
  \`0\` (mask them — replace the \`-100\` by a valid index for the gather, then \`masked_fill\` the loss) and
  the result is the **sum over kept rows divided by their count**: a plain \`.mean()\` over \`N\` is wrong.
- Everything differentiable: the self-test runs \`torch.autograd.gradcheck\` in float64 on both
  \`log_softmax\` and \`cross_entropy\` (with smoothing and an ignored row).
- Tolerances against \`torch.nn.functional\`: \`atol=1e-5\` in float32, \`1e-10\` in float64, on a batch whose
  first row sits near \`1e4\`, with \`label_smoothing\` \`0.0\` and \`0.1\`, and two ignored positions.

> Softmax is a ratio of exponentials, and a ratio is unchanged when every term is scaled by the same
> constant. Subtracting the row max picks the constant that makes the largest exponent exactly \`0\`:
> nothing overflows, and the sum is at least \`1\`, so its log is finite too.

The widget starts on four logits near \`1e4\`: every naive bar is NaN, the shifted bars are finite and sum
to \`1\`. Switch to small logits and the two agree.

:::widget softmax-stability {"preset": "huge"}`,
  hints: [
    'Write `log_softmax` first and make `softmax` and `cross_entropy` call it. `m = x.amax(dim=dim, keepdim=True)` broadcasts back over the row; `m.detach()` is fine — the gradient through the max cancels exactly — and saves autograd a node.',
    'For the gather, `targets` must be `(N, 1)` and `int64`: `logp.gather(1, targets.unsqueeze(1)).squeeze(1)`. Ignored rows hold `-100`, which is not a valid column: build `valid = targets != ignore_index`, gather with `targets.masked_fill(~valid, 0)`, and zero those rows afterwards.',
    'Label smoothing mixes two targets — the one-hot (`nll`) and the uniform distribution (`-logp.mean(dim=-1)`, i.e. `-logp.sum(-1) / C`). The reduction is `loss.sum() / valid.sum().clamp(min=1)`, which is what `reduction="mean"` does when rows are ignored.',
  ],
  checks: [
    {
      id: 'max-subtracted',
      title: 'Subtracts the row max before exponentiating',
      detail:
        'A `max` / `amax` along `dim` with `keepdim=True` so it broadcasts back over the row, subtracted from `x` before any `exp`. A row of logits around `1e4` then gives finite log-probabilities; without the shift `exp(1e4)` is `inf` and the result `nan`.',
      match: {
        python: {
          all: [/(amax|max)\([^)\n]*keepdim\s*=\s*True/],
          order: [/(amax|max)\([^)\n]*keepdim\s*=\s*True/, /\.exp\(\)|torch\.exp\(/],
        },
      },
    },
    {
      id: 'log-sum-exp',
      title: 'Builds log-sum-exp by hand: exp, sum, log',
      detail:
        '`log(sum(exp(x - m)))` written as those three ops in that order on the shifted values, not `torch.logsumexp`. The log-probability is `x - m - lse`, and because the shifted values are ≤ 0 the sum is in `[1, C]` and its log never overflows.',
      match: {
        python: {
          order: [/\.exp\(\)|torch\.exp\(/, /\.sum\(|torch\.sum\(/, /\.log\(\)|torch\.log\(/],
          none: [/logsumexp\(/],
        },
      },
    },
    {
      id: 'softmax-from-log',
      title: 'softmax is exp of log_softmax',
      detail:
        '`softmax` returns `log_softmax(x, dim).exp()` (or `torch.exp(log_softmax(...))`) rather than a second normalisation written by hand: one implementation of the shift and the sum, two outputs.',
      match: {
        python: {all: [/log_softmax\([^\n]*\)\.exp\(\)|torch\.exp\(\s*log_softmax\(/]},
      },
    },
    {
      id: 'no-library-shortcut',
      title: 'No torch.nn.functional softmax, log_softmax or cross_entropy in the implementation',
      detail:
        'Between the first implementation `def` and `if __name__ == "__main__":` there is no call to `.log_softmax(`, `.softmax(`, `.logsumexp(`, `.cross_entropy(`, `.nll_loss(` or the `nn` modules that wrap them. The self-test below the guard is where the reference belongs.',
      match: {python: {none: [LIBRARY_SHORTCUT]}},
    },
    {
      id: 'gather-target',
      title: 'Gathers the target log-probability instead of building a one-hot',
      detail:
        '`logp.gather(1, targets.unsqueeze(1))` (or `torch.gather` / `take_along_dim`) reads one value per row. No `one_hot`, no `torch.eye`, and no `.exp()` of the whole `(N, C)` tensor inside `cross_entropy`: the loss needs `C` log-probabilities per row only to average them.',
      match: {
        python: {
          all: [/\.gather\(|torch\.gather\(|take_along_dim\(/],
          none: [/one_hot\(|torch\.eye\(/, /def cross_entropy\b(?:(?!\ndef |\nif __name__)[\s\S])*?\.exp\(/],
        },
      },
    },
    {
      id: 'label-smoothing',
      title: 'Mixes the one-hot and the uniform target by label_smoothing',
      detail:
        'Per row `(1 - label_smoothing) * nll + label_smoothing * (-logp.mean(dim=-1))`: the cross-entropy against the target `(1 - ε) · onehot + ε / C`. With `label_smoothing=0.1` the self-test must match `F.cross_entropy(..., label_smoothing=0.1)`.',
      match: {
        python: {
          all: [
            /\(\s*1(?:\.0)?\s*-\s*label_smoothing\s*\)\s*\*/,
            /label_smoothing\s*\*/,
            /\.mean\(\s*(dim\s*=\s*)?-?1\s*\)|\.sum\(\s*(dim\s*=\s*)?-?1\s*\)\s*\//,
          ],
        },
      },
    },
    {
      id: 'ignore-index',
      title: 'Ignored positions contribute nothing and are left out of the mean',
      detail:
        'A mask `targets != ignore_index` (the `-100` PyTorch uses for padding labels) zeroes those rows with `masked_fill` / `torch.where` and the reduction divides by the number of kept rows, not `N`. A bare `.mean()` over the batch would scale the loss by `kept / N`.',
      match: {
        python: {
          all: [
            /!=\s*ignore_index|ignore_index\s*!=|\.ne\(\s*ignore_index|==\s*ignore_index|ignore_index\s*==|\.eq\(\s*ignore_index/,
            /masked_fill_?\(|torch\.where\(/,
            /\.sum\(\)\s*\/\s*\w+\.sum\(\)|\/\s*\w+\.sum\(\)\.clamp\(/,
          ],
          none: [/\.mean\(\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Numerically stable softmax, log-softmax and cross-entropy from tensor ops, checked against torch.nn.functional."""

import torch
import torch.nn.functional as F
from torch import Tensor

IGNORE_INDEX = -100


def log_softmax(x: Tensor, dim: int = -1) -> Tensor:
    """log p_i = x_i - m - log(sum_j exp(x_j - m)) along \`dim\`, with m the max along \`dim\`."""
    # TODO: m = x.amax(dim, keepdim=True); shifted = x - m; return shifted - log(sum(exp(shifted)))
    raise NotImplementedError("TODO")


def softmax(x: Tensor, dim: int = -1) -> Tensor:
    """p_i = exp(x_i) / sum_j exp(x_j) along \`dim\`, computed through log_softmax."""
    # TODO: exponentiate log_softmax
    raise NotImplementedError("TODO")


def cross_entropy(
    logits: Tensor, targets: Tensor, label_smoothing: float = 0.0, ignore_index: int = IGNORE_INDEX
) -> Tensor:
    """Mean over the non-ignored rows of -(1 - eps) * logp[target] - eps * mean_c logp[c]; logits (N, C), targets (N,)."""
    # TODO: logp = log_softmax(logits, -1); gather the target column (ignored rows need a valid stand-in index);
    # TODO: smooth with -logp.mean(-1); zero the ignored rows; divide by the number of kept rows
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    N, C = 8, 5
    for dtype, atol in ((torch.float32, 1e-5), (torch.float64, 1e-10)):
        x = torch.randn(N, C, dtype=dtype)
        x[0] = x[0] + 1e4  # a row a naive exp overflows on: exp(1e4) is inf in float32 and float64
        x[1, 2] = -1e4  # and a logit that underflows to probability 0 without going nan
        logp = log_softmax(x, dim=-1)
        assert torch.isfinite(logp).all(), "log_softmax overflowed"
        assert torch.allclose(logp, F.log_softmax(x, dim=-1), atol=atol), f"log_softmax mismatch ({dtype})"
        assert torch.allclose(softmax(x, dim=-1), F.softmax(x, dim=-1), atol=atol), f"softmax mismatch ({dtype})"
        y = torch.randn(2, 3, 4, dtype=dtype)
        assert torch.allclose(log_softmax(y, dim=1), F.log_softmax(y, dim=1), atol=atol), "dim=1 mismatch"
        targets = torch.randint(0, C, (N,))
        targets[3] = IGNORE_INDEX
        targets[6] = IGNORE_INDEX
        for eps in (0.0, 0.1):
            got = cross_entropy(x, targets, label_smoothing=eps)
            ref = F.cross_entropy(x, targets, label_smoothing=eps, ignore_index=IGNORE_INDEX)
            assert torch.allclose(got, ref, atol=atol), f"cross_entropy mismatch (eps={eps}, {dtype}): {got} vs {ref}"
    x64 = torch.randn(4, 6, dtype=torch.float64, requires_grad=True)
    t64 = torch.tensor([1, 5, IGNORE_INDEX, 0])
    assert torch.autograd.gradcheck(lambda a: log_softmax(a, dim=-1), (x64,)), "log_softmax gradient"
    assert torch.autograd.gradcheck(lambda a: cross_entropy(a, t64, label_smoothing=0.1), (x64,)), "cross_entropy gradient"
    print("PASS")
`,
      solution: `"""Numerically stable softmax, log-softmax and cross-entropy from tensor ops, checked against torch.nn.functional."""

import torch
import torch.nn.functional as F
from torch import Tensor

IGNORE_INDEX = -100


def log_softmax(x: Tensor, dim: int = -1) -> Tensor:
    """log p_i = x_i - m - log(sum_j exp(x_j - m)) along \`dim\`, with m the max along \`dim\`."""
    # The max is a constant for the gradient (its contribution cancels), so detach it: one node less.
    m = x.amax(dim=dim, keepdim=True).detach()
    shifted = x - m  # every entry <= 0: exp cannot overflow, and the sum below is in [1, C]
    lse = shifted.exp().sum(dim=dim, keepdim=True).log()
    return shifted - lse


def softmax(x: Tensor, dim: int = -1) -> Tensor:
    """p_i = exp(x_i) / sum_j exp(x_j) along \`dim\`, computed through log_softmax."""
    return log_softmax(x, dim).exp()


def cross_entropy(
    logits: Tensor, targets: Tensor, label_smoothing: float = 0.0, ignore_index: int = IGNORE_INDEX
) -> Tensor:
    """Mean over the non-ignored rows of -(1 - eps) * logp[target] - eps * mean_c logp[c]; logits (N, C), targets (N,)."""
    logp = log_softmax(logits, dim=-1)  # (N, C): the only full-width tensor the loss needs
    valid = targets != ignore_index  # (N,) bool
    safe = targets.masked_fill(~valid, 0)  # -100 is not a column; gather needs an index that exists
    nll = -logp.gather(1, safe.unsqueeze(1)).squeeze(1)  # (N,): -log p[target]
    smooth = -logp.mean(dim=-1)  # (N,): cross-entropy against the uniform distribution
    loss = (1.0 - label_smoothing) * nll + label_smoothing * smooth
    loss = loss.masked_fill(~valid, 0.0)
    return loss.sum() / valid.sum().clamp(min=1)


if __name__ == "__main__":
    torch.manual_seed(0)
    N, C = 8, 5
    for dtype, atol in ((torch.float32, 1e-5), (torch.float64, 1e-10)):
        x = torch.randn(N, C, dtype=dtype)
        x[0] = x[0] + 1e4  # a row a naive exp overflows on: exp(1e4) is inf in float32 and float64
        x[1, 2] = -1e4  # and a logit that underflows to probability 0 without going nan
        logp = log_softmax(x, dim=-1)
        assert torch.isfinite(logp).all(), "log_softmax overflowed"
        assert torch.allclose(logp, F.log_softmax(x, dim=-1), atol=atol), f"log_softmax mismatch ({dtype})"
        assert torch.allclose(softmax(x, dim=-1), F.softmax(x, dim=-1), atol=atol), f"softmax mismatch ({dtype})"
        y = torch.randn(2, 3, 4, dtype=dtype)
        assert torch.allclose(log_softmax(y, dim=1), F.log_softmax(y, dim=1), atol=atol), "dim=1 mismatch"
        targets = torch.randint(0, C, (N,))
        targets[3] = IGNORE_INDEX
        targets[6] = IGNORE_INDEX
        for eps in (0.0, 0.1):
            got = cross_entropy(x, targets, label_smoothing=eps)
            ref = F.cross_entropy(x, targets, label_smoothing=eps, ignore_index=IGNORE_INDEX)
            assert torch.allclose(got, ref, atol=atol), f"cross_entropy mismatch (eps={eps}, {dtype}): {got} vs {ref}"
    x64 = torch.randn(4, 6, dtype=torch.float64, requires_grad=True)
    t64 = torch.tensor([1, 5, IGNORE_INDEX, 0])
    assert torch.autograd.gradcheck(lambda a: log_softmax(a, dim=-1), (x64,)), "log_softmax gradient"
    assert torch.autograd.gradcheck(lambda a: cross_entropy(a, t64, label_smoothing=0.1), (x64,)), "cross_entropy gradient"
    print("PASS")
`,
    },
  },
  debrief: `Three functions, one formula. \`log_softmax\` is the primitive because it is the one whose numerics matter: \`x - m\` makes every exponent non-positive, so \`exp\` cannot overflow and the sum lies in \`[1, C]\`, whose log is small and finite. \`softmax\` is its exponential and \`cross_entropy\` reads one column of it — the probability tensor is never formed for the loss, which is what \`torch.nn.functional.cross_entropy\` does too (it is \`nll_loss(log_softmax(x))\`, fused). The max is detached because its gradient contribution is identically zero (\`-1 + Σ softmax = 0\`); \`gradcheck\` passes either way, the detached graph is just smaller. Label smoothing is a different target distribution, \`(1 - ε) · onehot + ε / C\`, and because cross-entropy is linear in the target the loss splits into the NLL term and \`-mean(logp)\`, which is why the whole \`logp\` row is still needed. \`ignore_index = -100\` is the convention padding tokens carry through every Hugging Face data collator; the rows are masked *after* the gather (the index is replaced, not the loss) and the mean is over the rows that remain, exactly \`reduction="mean"\` with ignored targets. Production code does not run these three ops: cuDNN and Triton fuse the max, the exp and the sum into one pass over the row, FlashAttention never materialises the softmax at all (it carries a running max and a rescaled running sum across tiles — "online softmax"), and because the vocabulary is 128k wide the \`(tokens, vocab)\` logit tensor in float32 is the largest activation in an LLM: chunked and fused cross-entropy kernels (Liger, \`torch.compile\`) compute the loss and its gradient per chunk and never allocate it whole. In bf16 training the logits are upcast to float32 before the softmax for the same reason this step shifts by the max: the mantissa is the scarce resource, and a sum of exponentials spends it fast.`,
};
