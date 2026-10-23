import type {Step} from '@/lib/types';

export const normsStep: Step = {
  id: 'norms',
  title: 'LayerNorm and RMSNorm: centre, scale, upcast',
  concept: 'pytorch',
  file: 'norms',
  focus: ['ln-mean', 'ln-var', 'ln-scale', 'ln-affine', 'rms-up', 'rms-ms', 'rms-scale', 'rms-cast', 'rms-weight'],
  task: `## Task

Implement the two normalisations a transformer block applies to its residual stream, as \`nn.Module\`s
written from scratch, in \`norms.py\`.

- \`LayerNorm(normalized_shape, eps=1e-5)\`: \`normalized_shape\` is an \`int\` or a tuple; the module
  normalises over the **trailing** \`len(normalized_shape)\` dimensions of \`x\` and owns two parameters of
  that shape, \`weight\` (ones) and \`bias\` (zeros). \`forward(x)\` runs four lines:
  1. \`dims\`: the trailing dimensions, \`(-1,)\` for an int, \`(-2, -1)\` for a 2-tuple;
  2. \`mean\` over \`dims\` with \`keepdim=True\`;
  3. \`var\` over \`dims\`, **biased** (\`unbiased=False\`, divide by N, not N − 1), \`keepdim=True\`;
  4. return \`(x − mean) · torch.rsqrt(var + eps) · weight + bias\`, \`eps\` **inside** the root.
- \`RMSNorm(dim, eps=1e-6)\`: the Llama form. No mean is subtracted and there is no bias: \`forward(x)\`
  returns \`x · rsqrt(mean(x²) + eps) · weight\` over the last dimension, with one parameter \`weight\` of
  shape \`(dim,)\` initialised to ones.
- A hand check: on the row \`[1, 2, 3, 6]\`, \`LayerNorm(4)\` gives \`[−1.069, −0.535, 0, 1.604]\` and
  \`RMSNorm(4)\` gives \`[0.283, 0.566, 0.849, 1.697]\` (the guide works both out step by step).

Push the offset slider: LayerNorm's output stays centred, RMSNorm's carries the offset through, scaled.

:::widget norm-compare

- **The upcast rule**: a \`float16\` or \`bfloat16\` \`x\` is normalised in **float32** (\`x.float()\`,
  statistic and division in float32) and the result is cast back to \`x\`'s dtype (\`.type_as(x)\`)
  *before* the multiplication by \`weight\`. A \`float32\` or \`float64\` \`x\` stays in its dtype, so
  \`gradcheck\` in float64 sees the real Jacobian.
- Forbidden inside the modules: \`nn.LayerNorm\`, \`nn.RMSNorm\`, \`F.layer_norm\`, \`F.rms_norm\`,
  \`torch.layer_norm\`. They are allowed in the self-test as the reference.
- The file ends with \`if __name__ == "__main__":\`: \`torch.manual_seed(0)\`, \`x\` of shape
  \`(2, 5, 64)\`, a \`LayerNorm\` with random \`weight\`/\`bias\` against \`F.layer_norm\` over \`(64,)\` and over
  \`(5, 64)\`, an \`RMSNorm\` against \`F.rms_norm\` (\`atol=rtol=1e-5\` in float32), a \`bfloat16\` input
  whose output is \`bfloat16\` and within \`2e-2\` of the float32 statistic, a \`float16\` input of scale
  200 whose entries above 256 square past float16's largest value (65 504), \`torch.autograd.gradcheck\`
  of both modules in float64, then \`print("PASS")\`.

> A normalisation layer is a statistic over the feature axis, a per-row scale and an affine map.
> Everything that matters (biased variance, eps under the root, the float32 statistic) is about where
> rounding and overflow are allowed to happen.`,
  hints: [
    'LayerNorm: `dims = tuple(range(-len(self.normalized_shape), 0))`, then `mean = x.mean(dim=dims, keepdim=True)` and `var = x.var(dim=dims, unbiased=False, keepdim=True)`; `keepdim` is what lets `(x - mean)` broadcast. Return `(x - mean) * torch.rsqrt(var + self.eps) * self.weight + self.bias`.',
    'RMSNorm has no centring step and no bias: `x * torch.rsqrt(x.pow(2).mean(dim=-1, keepdim=True) + self.eps) * self.weight`, one `nn.Parameter(torch.ones(dim))`, default `eps=1e-6`.',
    'Upcast only what is below float32: `xf = x.float() if x.dtype in (torch.float16, torch.bfloat16) else x`, normalise `xf`, `.type_as(x)`, and multiply by `weight` last. A float16 square of 300 is `inf`; a float64 input left as float64 is what makes `gradcheck` pass.',
  ],
  checks: [
    {
      id: 'layernorm-params',
      title: 'LayerNorm owns weight (ones) and bias (zeros) as parameters',
      detail:
        '`class LayerNorm(nn.Module)` registers `self.weight = nn.Parameter(torch.ones(...))` and `self.bias = nn.Parameter(torch.zeros(...))` of `normalized_shape`: the identity affine map at initialisation, trainable afterwards, found by `parameters()` and the optimizer.',
      match: {
        python: {
          all: [
            /class LayerNorm\(nn\.Module\)/,
            /self\.weight\s*=\s*nn\.Parameter\(\s*torch\.ones\(/,
            /self\.bias\s*=\s*nn\.Parameter\(\s*torch\.zeros\(/,
          ],
        },
      },
    },
    {
      id: 'biased-variance',
      title: 'Centres with the mean and scales with the biased variance, keepdim',
      detail:
        '`x.mean(..., keepdim=True)` and `x.var(..., unbiased=False, keepdim=True)` (or `correction=0`): `F.layer_norm` divides by N, not N − 1, and a reduced axis kept as size 1 is what broadcasts back over `x`.',
      match: {
        python: {
          all: [/\.mean\([^)]*keepdim\s*=\s*True/, /\.var\([^)]*(?:unbiased\s*=\s*False|correction\s*=\s*0)/],
        },
      },
    },
    {
      id: 'rsqrt-eps',
      title: 'Scales by torch.rsqrt(statistic + eps), eps inside the root',
      detail:
        'Both modules multiply by `torch.rsqrt(var + self.eps)` / `torch.rsqrt(mean(x²) + self.eps)`: one reciprocal square root per row, then a multiply per element instead of a division. `eps` goes under the root, as in `F.layer_norm`; without it a constant row gives `0 · rsqrt(0) = NaN`.',
      match: {python: {all: [/torch\.rsqrt\([^\n]*\+\s*self\.eps\s*\)/]}},
    },
    {
      id: 'rmsnorm-no-mean',
      title: 'RMSNorm drops the centring step and has no bias',
      detail:
        '`class RMSNorm(nn.Module)` divides by the root mean square, `x.pow(2).mean(dim=-1, keepdim=True)`, with a single `weight` of ones: no `mean` subtraction, no `.var(`, no `self.bias`. That is the Llama form `F.rms_norm` reproduces.',
      match: {
        python: {
          all: [/class RMSNorm\(nn\.Module\)/, /\.pow\(2\)\.mean\(|\.square\(\)\.mean\(|\*\s*x\s*\)\.mean\(/],
          none: [/class RMSNorm(?:(?!\nclass |\nif __name__)[\s\S])*?(?:self\.bias\b|\.var\(|x\s*-\s*mean)/],
        },
      },
    },
    {
      id: 'upcast',
      title: 'Half-precision inputs are normalised in float32 and cast back',
      detail:
        'RMSNorm computes its statistic on `x.float()` when `x` is `float16`/`bfloat16` and returns `.type_as(x)` (or `.to(x.dtype)`) before the `weight` multiply, so a float16 row of scale 200 does not square to `inf` and the output keeps the input dtype. The cast up comes before the cast back.',
      match: {
        python: {
          all: [/\bx\.float\(\)/, /\.type_as\(\s*x\s*\)|\.to\(\s*(?:dtype\s*=\s*)?x\.dtype\s*\)/],
          order: [/\bx\.float\(\)/, /\.type_as\(\s*x\s*\)|\.to\(\s*(?:dtype\s*=\s*)?x\.dtype\s*\)/],
        },
      },
    },
    {
      id: 'from-scratch',
      title: 'No nn.LayerNorm, nn.RMSNorm, F.layer_norm or F.rms_norm in the modules',
      detail:
        'The built-ins may only appear after `if __name__ == "__main__":`, as the reference the self-test compares against. The modules compute the statistics themselves.',
      match: {
        python: {
          none: [
            /nn\.(?:LayerNorm|RMSNorm)\(/,
            /(?:F|functional|torch)\.(?:layer_norm|rms_norm)\([\s\S]*\nif __name__/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""LayerNorm and RMSNorm from scratch: the two normalisations a transformer block runs before attention and the MLP."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class LayerNorm(nn.Module):
    """y = (x - mean) * rsqrt(var + eps) * weight + bias over the trailing \`normalized_shape\` dims (biased variance)."""

    def __init__(self, normalized_shape, eps: float = 1e-5):
        super().__init__()
        # TODO: normalized_shape as a tuple, eps, weight (ones) and bias (zeros) as nn.Parameter
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: mean and biased variance over the trailing dims (keepdim), torch.rsqrt(var + eps), affine
        raise NotImplementedError("TODO")


class RMSNorm(nn.Module):
    """y = x * rsqrt(mean(x^2) + eps) * weight over the last dim, the statistic computed in float32 (Llama)."""

    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        # TODO: eps and weight (ones), no bias
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: upcast float16/bfloat16 to float32, x * rsqrt(mean(x^2) + eps), cast back, then * weight
        raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    B, T, D = 2, 5, 64

    # LayerNorm vs F.layer_norm, float32, with non-trivial affine parameters.
    ln = LayerNorm(D)
    with torch.no_grad():
        ln.weight.copy_(torch.randn(D))
        ln.bias.copy_(torch.randn(D))
    x = torch.randn(B, T, D) * 3 + 1
    ref = F.layer_norm(x, (D,), ln.weight, ln.bias, ln.eps)
    assert torch.allclose(ln(x), ref, atol=1e-5, rtol=1e-5), "LayerNorm != F.layer_norm"

    # Two trailing dims normalised together.
    ln2 = LayerNorm((T, D))
    ref2 = F.layer_norm(x, (T, D), ln2.weight, ln2.bias, ln2.eps)
    assert torch.allclose(ln2(x), ref2, atol=1e-5, rtol=1e-5), "LayerNorm over (T, D) != F.layer_norm"

    # RMSNorm vs F.rms_norm, float32.
    rms = RMSNorm(D)
    with torch.no_grad():
        rms.weight.copy_(torch.rand(D) + 0.5)
    ref_rms = F.rms_norm(x, (D,), rms.weight, rms.eps)
    assert torch.allclose(rms(x), ref_rms, atol=1e-5, rtol=1e-5), "RMSNorm != F.rms_norm"

    # The upcast rule, part 1: a bfloat16 input gives a bfloat16 output whose statistic was taken in float32.
    rms16 = RMSNorm(D).to(torch.bfloat16)
    with torch.no_grad():
        rms16.weight.copy_(rms.weight)
    x16 = (torch.randn(B, T, D) * 50).to(torch.bfloat16)
    y16 = rms16(x16)
    assert y16.dtype == torch.bfloat16, f"expected bfloat16 out, got {y16.dtype}"
    exact = F.rms_norm(x16.float(), (D,), rms16.weight.float(), rms16.eps)
    assert torch.allclose(y16.float(), exact, atol=2e-2, rtol=2e-2), "bf16 RMSNorm drifts from the float32 statistic"
    assert torch.allclose(y16, F.rms_norm(x16, (D,), rms16.weight, rms16.eps), atol=2e-2, rtol=2e-2), "bf16 != F.rms_norm"

    # The upcast rule, part 2: a scale-200 row has entries above 256, whose float16 squares overflow (256^2 > 65504) unless taken in float32.
    rms_h = RMSNorm(D).to(torch.float16)
    x_h = (torch.randn(B, T, D) * 200).to(torch.float16)
    y_h = rms_h(x_h)
    exact_h = F.rms_norm(x_h.float(), (D,), rms_h.weight.float(), rms_h.eps)
    assert y_h.dtype == torch.float16 and torch.isfinite(y_h).all(), "fp16 RMSNorm overflowed"
    assert torch.allclose(y_h.float(), exact_h, atol=1e-2, rtol=1e-2), "fp16 RMSNorm lost the row (squares overflowed)"

    # Gradients through both, in float64.
    ln64 = LayerNorm(D).double()
    x64 = torch.randn(3, D, dtype=torch.float64, requires_grad=True)
    assert torch.autograd.gradcheck(lambda t: ln64(t), (x64,)), "LayerNorm gradcheck"
    rms64 = RMSNorm(D).double()
    assert torch.autograd.gradcheck(lambda t: rms64(t), (x64,)), "RMSNorm gradcheck"

    print("PASS")
`,
      solution: `"""LayerNorm and RMSNorm from scratch: the two normalisations a transformer block runs before attention and the MLP."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class LayerNorm(nn.Module):
    """y = (x - mean) * rsqrt(var + eps) * weight + bias over the trailing \`normalized_shape\` dims (biased variance)."""

    def __init__(self, normalized_shape, eps: float = 1e-5):
        super().__init__()
        if isinstance(normalized_shape, int):
            normalized_shape = (normalized_shape,)
        self.normalized_shape = tuple(normalized_shape)
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(self.normalized_shape))
        self.bias = nn.Parameter(torch.zeros(self.normalized_shape))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        dims = tuple(range(-len(self.normalized_shape), 0))
        mean = x.mean(dim=dims, keepdim=True)
        var = x.var(dim=dims, unbiased=False, keepdim=True)
        return (x - mean) * torch.rsqrt(var + self.eps) * self.weight + self.bias


class RMSNorm(nn.Module):
    """y = x * rsqrt(mean(x^2) + eps) * weight over the last dim, the statistic computed in float32 (Llama)."""

    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        xf = x.float() if x.dtype in (torch.float16, torch.bfloat16) else x
        normed = xf * torch.rsqrt(xf.pow(2).mean(dim=-1, keepdim=True) + self.eps)
        return normed.type_as(x) * self.weight


if __name__ == "__main__":
    torch.manual_seed(0)
    B, T, D = 2, 5, 64

    # LayerNorm vs F.layer_norm, float32, with non-trivial affine parameters.
    ln = LayerNorm(D)
    with torch.no_grad():
        ln.weight.copy_(torch.randn(D))
        ln.bias.copy_(torch.randn(D))
    x = torch.randn(B, T, D) * 3 + 1
    ref = F.layer_norm(x, (D,), ln.weight, ln.bias, ln.eps)
    assert torch.allclose(ln(x), ref, atol=1e-5, rtol=1e-5), "LayerNorm != F.layer_norm"

    # Two trailing dims normalised together.
    ln2 = LayerNorm((T, D))
    ref2 = F.layer_norm(x, (T, D), ln2.weight, ln2.bias, ln2.eps)
    assert torch.allclose(ln2(x), ref2, atol=1e-5, rtol=1e-5), "LayerNorm over (T, D) != F.layer_norm"

    # RMSNorm vs F.rms_norm, float32.
    rms = RMSNorm(D)
    with torch.no_grad():
        rms.weight.copy_(torch.rand(D) + 0.5)
    ref_rms = F.rms_norm(x, (D,), rms.weight, rms.eps)
    assert torch.allclose(rms(x), ref_rms, atol=1e-5, rtol=1e-5), "RMSNorm != F.rms_norm"

    # The upcast rule, part 1: a bfloat16 input gives a bfloat16 output whose statistic was taken in float32.
    rms16 = RMSNorm(D).to(torch.bfloat16)
    with torch.no_grad():
        rms16.weight.copy_(rms.weight)
    x16 = (torch.randn(B, T, D) * 50).to(torch.bfloat16)
    y16 = rms16(x16)
    assert y16.dtype == torch.bfloat16, f"expected bfloat16 out, got {y16.dtype}"
    exact = F.rms_norm(x16.float(), (D,), rms16.weight.float(), rms16.eps)
    assert torch.allclose(y16.float(), exact, atol=2e-2, rtol=2e-2), "bf16 RMSNorm drifts from the float32 statistic"
    assert torch.allclose(y16, F.rms_norm(x16, (D,), rms16.weight, rms16.eps), atol=2e-2, rtol=2e-2), "bf16 != F.rms_norm"

    # The upcast rule, part 2: a scale-200 row has entries above 256, whose float16 squares overflow (256^2 > 65504) unless taken in float32.
    rms_h = RMSNorm(D).to(torch.float16)
    x_h = (torch.randn(B, T, D) * 200).to(torch.float16)
    y_h = rms_h(x_h)
    exact_h = F.rms_norm(x_h.float(), (D,), rms_h.weight.float(), rms_h.eps)
    assert y_h.dtype == torch.float16 and torch.isfinite(y_h).all(), "fp16 RMSNorm overflowed"
    assert torch.allclose(y_h.float(), exact_h, atol=1e-2, rtol=1e-2), "fp16 RMSNorm lost the row (squares overflowed)"

    # Gradients through both, in float64.
    ln64 = LayerNorm(D).double()
    x64 = torch.randn(3, D, dtype=torch.float64, requires_grad=True)
    assert torch.autograd.gradcheck(lambda t: ln64(t), (x64,)), "LayerNorm gradcheck"
    rms64 = RMSNorm(D).double()
    assert torch.autograd.gradcheck(lambda t: rms64(t), (x64,)), "RMSNorm gradcheck"

    print("PASS")
`,
    },
  },
  debrief: `Both modules are a statistic over the feature axis, a per-row scale broadcast back over the row, and a per-feature affine map; every detail is about numerics. The variance is **biased** because \`F.layer_norm\` and every framework kernel divide by N: with N − 1 the normalised row comes out a factor \`sqrt(N / (N − 1))\` too small (0.8% at D = 64, 0.01% at D = 4096), close enough to pass a loose tolerance and wrong in every layer. \`eps\` keeps a constant row (variance 0) finite, normalising it to \`bias\` instead of \`0 · rsqrt(0) = NaN\`, and it sits **inside** the root because that is where the reference puts it. The root is \`torch.rsqrt\`: one reciprocal square root per row, then a multiply per element instead of a division. RMSNorm drops the centring and the bias because Zhang & Sennrich found the re-scaling, not the re-centring, is what stabilises training; the saving is one reduction and one subtraction per row, which is why Llama, Mistral, Gemma and Qwen all use it. **The upcast rule** is the part most hand-written norms get wrong: a model running in \`float16\` feeds the norm rows whose squares overflow at \`|x| ≥ 256\`, the mean becomes \`inf\`, \`rsqrt\` gives 0, and the whole row silently becomes zeros (\`bfloat16\` has float32's range, so there the upcast buys precision rather than range). Llama's \`RMSNorm\` therefore does \`x.float()\`, normalises, casts back with \`.type_as(x)\` and only then multiplies by \`weight\`, so the output and the parameter stay in the model's dtype while the statistic was taken in float32. The module leaves float32 and float64 alone, which is what lets \`gradcheck\` in float64 see the true Jacobian instead of a float32 one. Frameworks fuse the whole thing: \`F.layer_norm\` runs one kernel that reads each row once and keeps the statistic in registers, \`F.rms_norm\` has had a fused CUDA kernel since mid-2025 (it ran as separate ops when it arrived in PyTorch 2.4), apex's \`FusedLayerNorm\`, Triton's layer-norm tutorial and \`torch.compile\` fuse the backward too, and inference engines fold the norm into the residual add before it so the sum is written once and never read back.`,
};
