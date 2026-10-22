import type {Step} from '@/lib/types';

export const stochasticRoundingStep: Step = {
  id: 'stochastic-rounding',
  title: 'The quantizer for training: stochastic rounding and 16 × 16 blocks',
  concept: 'pytorch',
  file: 'nvfp4_sr',
  focus: ['q-x', 'q-w', 'q-dy'],
  task: `## Task

The canonical NVFP4 quantizer is given: \`e2m1_step\`, \`round_e2m1_nearest\` (ties to even, saturating
at ±6), \`e4m3\`, \`global_scale\`, and \`quantize_nvfp4\` for 1 × 16 blocks. Training needs two more
things from it, and you add them. Everything is fake quantization: the function returns the decoded
\`q · s_block · s_global\` in float32, so a plain FP32 matmul of two quantized operands computes what an
NVFP4 GEMM computes.

- \`quantize_nvfp4(x, rounding="nearest", generator=None, block=(1, 16)) -> Tensor\`, float32, the shape
  of \`x\`. Given: \`s_global = amax(|x|) / (6 · 448)\` (1 for an all-zero tensor), per block
  \`s_block = e4m3(amax_block / 6 / s_global)\`, \`v = x / (s_block · s_global)\`, round \`v\` to E2M1,
  multiply back; a block whose scale is 0 decodes to zeros.
- \`round_e2m1_stochastic(v, generator=None)\`: with \`a = min(|v|, 6)\`, \`step = e2m1_step(a)\` (0.5
  below 2, 1 below 4, 2 up to 6) and \`lo = floor(a / step) · step\`, return \`sign(v) · (lo + step)\`
  with probability \`(a - lo) / step\` and \`sign(v) · lo\` otherwise. One
  \`torch.rand(v.shape, generator=generator)\` draw per element, so a seeded generator replays the
  same roundings. Then \`E[q] = a\` for every \`|v| ≤ 6\`.
- \`block=(16, 16)\`: \`x\` is 2-D with both dims multiples of 16. View it as
  \`(R // 16, 16, C // 16, 16)\` and take one \`amax\` per tile over dims 1 and 3 (\`keepdim=True\`, so
  it broadcasts); the rest of the pipeline is unchanged. Then
  \`quantize_nvfp4(W, block=(16, 16)).T\` equals \`quantize_nvfp4(W.T, block=(16, 16))\` bit for bit,
  which 1 × 16 blocks do not give.
- Round with the grid arithmetic. No cast to \`torch.float4_e2m1fn_x2\`, no torchao or Transformer
  Engine quantizer.

:::widget stochastic-rounding {"mode": "rounding"}

The self-test checks the given round-to-nearest-even against a brute force over the grid, then:
every stochastic draw is one of the two grid neighbours with the sign of \`v\`; the mean of 4,096
draws of a heavy-tailed tensor lies within \`6 · gap / (2 √N)\` of \`sign(x) · min(|x|, 6 · scale)\` for
both block shapes (a block maximum can sit up to 1/16 above 6 because E4M3 rounds the scale to
nearest, and saturates: the one place SR is biased); round-to-nearest moves the values below half the
smallest code by less than −20 % of their magnitude (it measures −41 %, flushing 85 % of them to 0)
while 64 stochastic draws stay within 1 %; and 2-D blocks commute with the transpose while 1 × 16
blocks change more than 10 % of the elements. Then it prints \`PASS\`.

> Round-to-nearest is the best single guess and a biased average: a gradient whose values sit low in
> their grid interval is shrunk every step, the same way. Stochastic rounding is a worse single guess
> and an exact average, which is what an optimizer summing thousands of steps needs.`,
  hints: [
    'For stochastic rounding, compute `lo` with `torch.floor(a / step) * step`, the probability `p_up = (a - lo) / step`, a draw `u = torch.rand(v.shape, generator=generator)`, and return `torch.sign(v) * (lo + step * (u < p_up))`. At `a = 6` the probability is 0, so nothing goes past the top of the grid.',
    'For the 2-D branch, `R, C = x.shape`, `xb = x.reshape(R // 16, 16, C // 16, 16)` puts a tile at `xb[i, :, j, :]`. `xb.abs().amax(dim=(1, 3), keepdim=True)` has shape `(R // 16, 1, C // 16, 1)` and broadcasts back over the tile.',
    'The final `reshape(x.shape)` works for both branches because both views are reshapes of a contiguous `x`. Check the transpose property on a random matrix: the tile at `(i, j)` of `W` is the transposed tile at `(j, i)` of `W.T`, so it has the same amax and the same scale.',
  ],
  checks: [
    {
      id: 'sr-floor',
      title: 'Stochastic rounding starts from the grid point below',
      detail:
        '`lo = torch.floor(a / step) * step` with `step = e2m1_step(a)`: the lower of the two neighbouring E2M1 points, so a draw can only land on `lo` or `lo + step`.',
      match: {python: {all: [/torch\.floor\(/]}},
    },
    {
      id: 'sr-probability',
      title: 'Up with probability (a − lo) / step',
      detail:
        'The chance of rounding up is the distance from `lo` over the gap, so `E[q] = lo + step · (a − lo) / step = a`: the rounding is unbiased for every value inside the grid.',
      match: {python: {all: [/-\s*(?:lo|low)\b[^\n]*\/\s*(?:step|gap|spacing)\b/]}},
    },
    {
      id: 'sr-draw',
      title: 'One uniform draw per element from the generator',
      detail:
        '`torch.rand(v.shape, generator=generator)` (or `torch.bernoulli(p, generator=generator)`): seeded draws make a training run reproducible. A cast to `torch.float4_e2m1fn_x2` or a torchao / Transformer Engine quantizer replaces the mechanism this step writes.',
      match: {
        python: {
          all: [/torch\.(?:rand|bernoulli)\([^)]*generator\s*=\s*generator/],
          none: [/float4_e2m1fn/, /torchao/, /transformer_engine/],
        },
      },
    },
    {
      id: 'tile-view',
      title: '16 × 16 tiles: a (R/16, 16, C/16, 16) view',
      detail:
        '`x.reshape(R // 16, 16, C // 16, 16)` puts one weight tile at `[i, :, j, :]`, 16 input channels by 16 output channels, the block the paper scales weights with.',
      match: {
        python: {
          all: [/\.(?:reshape|view)\(\s*\w+\s*\/\/\s*16\s*,\s*16\s*,\s*\w+\s*\/\/\s*16\s*,\s*16\s*\)/],
        },
      },
    },
    {
      id: 'tile-amax',
      title: 'One amax per tile, over dims 1 and 3',
      detail:
        '`amax(dim=(1, 3), keepdim=True)`: one E4M3 scale per 16 × 16 tile, kept broadcastable. A tile and its transpose share that scale, so the forward and the backward see one quantized weight.',
      match: {python: {all: [/amax\(\s*(?:dim\s*=\s*)?\(\s*1\s*,\s*3\s*\)/]}},
    },
  ],
  code: {
    python: {
      starter: `"""NVFP4 for training: the canonical quantizer, plus stochastic rounding and 16x16 weight blocks."""

import torch

FP4_MAX = 6.0  # largest E2M1 magnitude
FP8_MAX = 448.0  # largest E4M3 magnitude: the block scale's format


def e2m1_step(a: torch.Tensor) -> torch.Tensor:
    """Spacing of the E2M1 grid {0, 0.5, 1, 1.5, 2, 3, 4, 6} at magnitude a in [0, 6]."""
    return 0.5 * (1.0 + (a >= 2.0).float() + 2.0 * (a >= 4.0).float())


def round_e2m1_nearest(v: torch.Tensor) -> torch.Tensor:
    """Round scaled values to E2M1: nearest, ties to even, saturating at +-6."""
    a = v.abs().clamp(max=FP4_MAX)
    step = e2m1_step(a)
    return torch.sign(v) * torch.round(a / step) * step  # torch.round: half to even


def round_e2m1_stochastic(v: torch.Tensor, generator: torch.Generator | None = None) -> torch.Tensor:
    """Round scaled values to one of their two neighbouring E2M1 points, each with probability falling with distance."""
    # TODO: a = |v| clamped at 6; step = e2m1_step(a); lo = the grid point at or below a (floor on the step);
    # round up to lo + step when a uniform draw from \`generator\` falls below (a - lo) / step; restore the sign.
    raise NotImplementedError("TODO: stochastic rounding")


def e4m3(s: torch.Tensor) -> torch.Tensor:
    """Round scales to FP8 E4M3 (nearest-even) and back to float32, clamped at 448 first."""
    return s.clamp(max=FP8_MAX).to(torch.float8_e4m3fn).to(torch.float32)


def global_scale(x: torch.Tensor) -> torch.Tensor:
    """Per-tensor FP32 decode scale amax / (6 * 448), or 1 for an all-zero tensor."""
    amax = x.abs().amax()
    return torch.where(amax > 0, amax / (FP4_MAX * FP8_MAX), torch.ones_like(amax))


def quantize_nvfp4(
    x: torch.Tensor,
    rounding: str = "nearest",
    generator: torch.Generator | None = None,
    block: tuple[int, int] = (1, 16),
) -> torch.Tensor:
    """Fake-quantize x to NVFP4: returns q * s_block * s_global in float32, the shape of x.

    block=(1, 16): 16 consecutive values along the last dim share one E4M3 scale (activations, gradients).
    block=(16, 16): a 16 x 16 tile of a 2-D tensor shares one scale (weights), so the transpose commutes.
    rounding: "nearest" (ties to even; weights and activations) or "stochastic" (gradients).
    """
    x = x.float()
    s_global = global_scale(x)
    if tuple(block) == (1, 16):
        assert x.shape[-1] % 16 == 0, "the last dim must be a multiple of 16"
        xb = x.reshape(*x.shape[:-1], x.shape[-1] // 16, 16)
        amax_b = xb.abs().amax(dim=-1, keepdim=True)
    elif tuple(block) == (16, 16):
        assert x.dim() == 2 and x.shape[0] % 16 == 0 and x.shape[1] % 16 == 0, "2-D, both dims multiples of 16"
        # TODO: view x as (R / 16, 16, C / 16, 16) and take one amax per 16 x 16 tile (keepdim, so it broadcasts).
        raise NotImplementedError("TODO: 16 x 16 blocks")
    else:
        raise ValueError(f"block must be (1, 16) or (16, 16), got {block}")
    s_block = e4m3(amax_b / FP4_MAX / s_global)
    denom = s_block * s_global  # what one E2M1 unit is worth in this block
    safe = torch.where(denom > 0, denom, torch.ones_like(denom))
    v = xb / safe
    if rounding == "nearest":
        q = round_e2m1_nearest(v)
    elif rounding == "stochastic":
        q = round_e2m1_stochastic(v, generator)
    else:
        raise ValueError(f"rounding must be 'nearest' or 'stochastic', got {rounding!r}")
    return (q * denom).reshape(x.shape)  # a zero-scale block decodes to zeros


if __name__ == "__main__":
    torch.manual_seed(0)
    GRID = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])

    def scales(x: torch.Tensor, block: tuple[int, int]) -> torch.Tensor:
        """Slow reference: each element's s_block * s_global, one block at a time."""
        s_global = global_scale(x)
        out = torch.empty_like(x)
        bh, bw = block
        for i in range(0, x.shape[0], bh):
            for j in range(0, x.shape[1], bw):
                tile = x[i : i + bh, j : j + bw]
                out[i : i + bh, j : j + bw] = e4m3(tile.abs().max() / FP4_MAX / s_global) * s_global
        return out

    # 0. The given round-to-nearest-even against a brute force over the grid (a tie goes to the even code).
    v = torch.linspace(-7, 7, 2801)
    ref = []
    for t in v.tolist():
        d = [abs(min(abs(t), FP4_MAX) - g) for g in GRID.tolist()]
        near = [i for i, di in enumerate(d) if abs(di - min(d)) < 1e-9]
        i = near[0] if len(near) == 1 else [j for j in near if j % 2 == 0][0]
        ref.append(GRID[i].item() * (1.0 if t > 0 else -1.0))
    assert torch.equal(round_e2m1_nearest(v), torch.tensor(ref)), "round to nearest, ties to even, saturate at 6"

    # 1. A stochastic draw is one of the two grid neighbours of |v|, with the sign of v.
    g = torch.Generator().manual_seed(1)
    v = torch.rand(20_000, generator=g) * 12 - 6
    q = round_e2m1_stochastic(v, g)
    a = v.abs()
    lo = GRID[(GRID.unsqueeze(0) <= a.unsqueeze(1)).sum(1) - 1]
    hi = GRID[(GRID.unsqueeze(0) < a.unsqueeze(1)).sum(1).clamp(max=7)]
    assert ((q.abs() == lo) | (q.abs() == hi)).all(), "SR lands on a neighbour"
    assert (q * v >= 0).all(), "SR keeps the sign"

    # 2. The mean of N draws is x. Repeating x along the rows keeps every block and the global amax the same,
    # so one call draws N independent roundings of every element. Each draw's standard deviation is at most
    # half the local grid gap, so the mean must lie within 6 * gap / (2 * sqrt(N)) of its expectation.
    N = 4096
    x = torch.randn(32, 64) * torch.exp(torch.randn(32, 64))  # heavy-tailed, like a gradient
    for block in [(1, 16), (16, 16)]:
        denom = scales(x, block)
        v = x / denom
        # E4M3 rounds the block scale to nearest, so a block maximum can land up to 1/16 above 6 and saturate:
        # the one place SR is not unbiased.
        assert v.abs().max() <= FP4_MAX * (1 + 2**-4) + 1e-5
        expect = torch.sign(x) * torch.minimum(x.abs(), FP4_MAX * denom)
        gap = e2m1_step(v.abs().clamp(max=FP4_MAX)) * denom
        draws = quantize_nvfp4(x.repeat(N, 1), "stochastic", torch.Generator().manual_seed(2), block)
        mean = draws.reshape(N, 32, 64).mean(0)
        assert ((mean - expect).abs() <= 6 * gap / (2 * N**0.5) + 1e-7).all(), f"SR mean, block {block}"
        sat = (v.abs() > FP4_MAX).float().mean().item()
        print(f"SR mean within 6 standard errors of x, block {block}; saturated elements: {sat:.2%}")

    # 3. Round-to-nearest is biased on small gradients: below half a grid step they flush to zero, and most of a
    # heavy-tailed block sits there.
    xg = torch.randn(256, 256) * torch.exp(2 * torch.randn(256, 256))
    small = (xg / scales(xg, (1, 16))).abs() < 0.5  # below the first non-zero code
    rne = quantize_nvfp4(xg, "nearest")
    sr = torch.stack([quantize_nvfp4(xg, "stochastic", torch.Generator().manual_seed(10 + i)) for i in range(64)])
    mag = xg.abs()[small].sum()
    bias_rne = ((rne - xg) * xg.sign())[small].sum() / mag
    bias_sr = ((sr.mean(0) - xg) * xg.sign())[small].sum() / mag
    flushed = (rne[small] == 0).float().mean()
    print(f"small values: {small.float().mean():.1%} of the tensor; RNE flushes {flushed:.1%} of them")
    print(f"relative bias on their magnitude: RNE {bias_rne:+.3f}, SR (64 draws) {bias_sr:+.4f}")
    assert bias_rne < -0.2, "RNE shrinks small gradients"
    assert bias_sr.abs() < 0.01, "SR does not"

    # 4. 16 x 16 blocks commute with the transpose, so fprop and dgrad can share one quantized weight; 1 x 16 do not.
    W = torch.randn(64, 128) * torch.exp(torch.randn(64, 128))
    assert torch.equal(quantize_nvfp4(W, block=(16, 16)).T, quantize_nvfp4(W.T, block=(16, 16)))
    differ = (quantize_nvfp4(W).T != quantize_nvfp4(W.T)).float().mean()
    assert differ > 0.1, "1 x 16 blocks give the transpose a different quantization"
    print(f"2-D blocks: quantize(W).T == quantize(W.T); 1 x 16 blocks: {differ:.1%} of the elements differ")
    print("PASS")
`,
      solution: `"""NVFP4 for training: the canonical quantizer, plus stochastic rounding and 16x16 weight blocks."""

import torch

FP4_MAX = 6.0  # largest E2M1 magnitude
FP8_MAX = 448.0  # largest E4M3 magnitude: the block scale's format


def e2m1_step(a: torch.Tensor) -> torch.Tensor:
    """Spacing of the E2M1 grid {0, 0.5, 1, 1.5, 2, 3, 4, 6} at magnitude a in [0, 6]."""
    return 0.5 * (1.0 + (a >= 2.0).float() + 2.0 * (a >= 4.0).float())


def round_e2m1_nearest(v: torch.Tensor) -> torch.Tensor:
    """Round scaled values to E2M1: nearest, ties to even, saturating at +-6."""
    a = v.abs().clamp(max=FP4_MAX)
    step = e2m1_step(a)
    return torch.sign(v) * torch.round(a / step) * step  # torch.round: half to even


def round_e2m1_stochastic(v: torch.Tensor, generator: torch.Generator | None = None) -> torch.Tensor:
    """Round scaled values to one of their two neighbouring E2M1 points, each with probability falling with distance."""
    a = v.abs().clamp(max=FP4_MAX)
    step = e2m1_step(a)
    lo = torch.floor(a / step) * step
    p_up = (a - lo) / step
    u = torch.rand(v.shape, generator=generator, dtype=torch.float32, device=v.device)
    return torch.sign(v) * (lo + step * (u < p_up))


def e4m3(s: torch.Tensor) -> torch.Tensor:
    """Round scales to FP8 E4M3 (nearest-even) and back to float32, clamped at 448 first."""
    return s.clamp(max=FP8_MAX).to(torch.float8_e4m3fn).to(torch.float32)


def global_scale(x: torch.Tensor) -> torch.Tensor:
    """Per-tensor FP32 decode scale amax / (6 * 448), or 1 for an all-zero tensor."""
    amax = x.abs().amax()
    return torch.where(amax > 0, amax / (FP4_MAX * FP8_MAX), torch.ones_like(amax))


def quantize_nvfp4(
    x: torch.Tensor,
    rounding: str = "nearest",
    generator: torch.Generator | None = None,
    block: tuple[int, int] = (1, 16),
) -> torch.Tensor:
    """Fake-quantize x to NVFP4: returns q * s_block * s_global in float32, the shape of x.

    block=(1, 16): 16 consecutive values along the last dim share one E4M3 scale (activations, gradients).
    block=(16, 16): a 16 x 16 tile of a 2-D tensor shares one scale (weights), so the transpose commutes.
    rounding: "nearest" (ties to even; weights and activations) or "stochastic" (gradients).
    """
    x = x.float()
    s_global = global_scale(x)
    if tuple(block) == (1, 16):
        assert x.shape[-1] % 16 == 0, "the last dim must be a multiple of 16"
        xb = x.reshape(*x.shape[:-1], x.shape[-1] // 16, 16)
        amax_b = xb.abs().amax(dim=-1, keepdim=True)
    elif tuple(block) == (16, 16):
        assert x.dim() == 2 and x.shape[0] % 16 == 0 and x.shape[1] % 16 == 0, "2-D, both dims multiples of 16"
        R, C = x.shape
        xb = x.reshape(R // 16, 16, C // 16, 16)
        amax_b = xb.abs().amax(dim=(1, 3), keepdim=True)
    else:
        raise ValueError(f"block must be (1, 16) or (16, 16), got {block}")
    s_block = e4m3(amax_b / FP4_MAX / s_global)
    denom = s_block * s_global  # what one E2M1 unit is worth in this block
    safe = torch.where(denom > 0, denom, torch.ones_like(denom))
    v = xb / safe
    if rounding == "nearest":
        q = round_e2m1_nearest(v)
    elif rounding == "stochastic":
        q = round_e2m1_stochastic(v, generator)
    else:
        raise ValueError(f"rounding must be 'nearest' or 'stochastic', got {rounding!r}")
    return (q * denom).reshape(x.shape)  # a zero-scale block decodes to zeros


if __name__ == "__main__":
    torch.manual_seed(0)
    GRID = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])

    def scales(x: torch.Tensor, block: tuple[int, int]) -> torch.Tensor:
        """Slow reference: each element's s_block * s_global, one block at a time."""
        s_global = global_scale(x)
        out = torch.empty_like(x)
        bh, bw = block
        for i in range(0, x.shape[0], bh):
            for j in range(0, x.shape[1], bw):
                tile = x[i : i + bh, j : j + bw]
                out[i : i + bh, j : j + bw] = e4m3(tile.abs().max() / FP4_MAX / s_global) * s_global
        return out

    # 0. The given round-to-nearest-even against a brute force over the grid (a tie goes to the even code).
    v = torch.linspace(-7, 7, 2801)
    ref = []
    for t in v.tolist():
        d = [abs(min(abs(t), FP4_MAX) - g) for g in GRID.tolist()]
        near = [i for i, di in enumerate(d) if abs(di - min(d)) < 1e-9]
        i = near[0] if len(near) == 1 else [j for j in near if j % 2 == 0][0]
        ref.append(GRID[i].item() * (1.0 if t > 0 else -1.0))
    assert torch.equal(round_e2m1_nearest(v), torch.tensor(ref)), "round to nearest, ties to even, saturate at 6"

    # 1. A stochastic draw is one of the two grid neighbours of |v|, with the sign of v.
    g = torch.Generator().manual_seed(1)
    v = torch.rand(20_000, generator=g) * 12 - 6
    q = round_e2m1_stochastic(v, g)
    a = v.abs()
    lo = GRID[(GRID.unsqueeze(0) <= a.unsqueeze(1)).sum(1) - 1]
    hi = GRID[(GRID.unsqueeze(0) < a.unsqueeze(1)).sum(1).clamp(max=7)]
    assert ((q.abs() == lo) | (q.abs() == hi)).all(), "SR lands on a neighbour"
    assert (q * v >= 0).all(), "SR keeps the sign"

    # 2. The mean of N draws is x. Repeating x along the rows keeps every block and the global amax the same,
    # so one call draws N independent roundings of every element. Each draw's standard deviation is at most
    # half the local grid gap, so the mean must lie within 6 * gap / (2 * sqrt(N)) of its expectation.
    N = 4096
    x = torch.randn(32, 64) * torch.exp(torch.randn(32, 64))  # heavy-tailed, like a gradient
    for block in [(1, 16), (16, 16)]:
        denom = scales(x, block)
        v = x / denom
        # E4M3 rounds the block scale to nearest, so a block maximum can land up to 1/16 above 6 and saturate:
        # the one place SR is not unbiased.
        assert v.abs().max() <= FP4_MAX * (1 + 2**-4) + 1e-5
        expect = torch.sign(x) * torch.minimum(x.abs(), FP4_MAX * denom)
        gap = e2m1_step(v.abs().clamp(max=FP4_MAX)) * denom
        draws = quantize_nvfp4(x.repeat(N, 1), "stochastic", torch.Generator().manual_seed(2), block)
        mean = draws.reshape(N, 32, 64).mean(0)
        assert ((mean - expect).abs() <= 6 * gap / (2 * N**0.5) + 1e-7).all(), f"SR mean, block {block}"
        sat = (v.abs() > FP4_MAX).float().mean().item()
        print(f"SR mean within 6 standard errors of x, block {block}; saturated elements: {sat:.2%}")

    # 3. Round-to-nearest is biased on small gradients: below half a grid step they flush to zero, and most of a
    # heavy-tailed block sits there.
    xg = torch.randn(256, 256) * torch.exp(2 * torch.randn(256, 256))
    small = (xg / scales(xg, (1, 16))).abs() < 0.5  # below the first non-zero code
    rne = quantize_nvfp4(xg, "nearest")
    sr = torch.stack([quantize_nvfp4(xg, "stochastic", torch.Generator().manual_seed(10 + i)) for i in range(64)])
    mag = xg.abs()[small].sum()
    bias_rne = ((rne - xg) * xg.sign())[small].sum() / mag
    bias_sr = ((sr.mean(0) - xg) * xg.sign())[small].sum() / mag
    flushed = (rne[small] == 0).float().mean()
    print(f"small values: {small.float().mean():.1%} of the tensor; RNE flushes {flushed:.1%} of them")
    print(f"relative bias on their magnitude: RNE {bias_rne:+.3f}, SR (64 draws) {bias_sr:+.4f}")
    assert bias_rne < -0.2, "RNE shrinks small gradients"
    assert bias_sr.abs() < 0.01, "SR does not"

    # 4. 16 x 16 blocks commute with the transpose, so fprop and dgrad can share one quantized weight; 1 x 16 do not.
    W = torch.randn(64, 128) * torch.exp(torch.randn(64, 128))
    assert torch.equal(quantize_nvfp4(W, block=(16, 16)).T, quantize_nvfp4(W.T, block=(16, 16)))
    differ = (quantize_nvfp4(W).T != quantize_nvfp4(W.T)).float().mean()
    assert differ > 0.1, "1 x 16 blocks give the transpose a different quantization"
    print(f"2-D blocks: quantize(W).T == quantize(W.T); 1 x 16 blocks: {differ:.1%} of the elements differ")
    print("PASS")
`,
    },
  },
  debrief: `The quantizer has one job in training that it does not have in inference: its errors are summed.
An optimizer adds thousands of quantized gradients into the same weights, so what matters is not the
error of one rounding but its mean. Round-to-nearest-even has the smallest error per value and a mean
that depends on where values sit inside their grid interval; gradients are heavy-tailed, most of a
block sits far below its maximum, and below a quarter of the block scale everything rounds to 0. The
self-test measures that: on a log-normal tensor 70 % of the values sit below half the smallest code,
RNE flushes 85 % of them and shrinks their total magnitude by 41 %. Stochastic rounding (Gupta et al.,
2015) makes each rounding a coin weighted by distance, so the expectation is exact and the bias
averages away; the price is variance (on a log-normal tensor one draw's RMS error is 0.41 of a grid gap against
0.27 for RNE), which is why the NVFP4 recipe applies it to gradients only and keeps weights and
activations on round-to-nearest. It is not perfectly unbiased: E4M3 rounds the block scale to nearest,
so a block maximum can land up to 1/16 above 6 and saturate. 16 × 16 weight tiles solve a different
problem: fprop blocks the weight along \`in_features\`, dgrad along \`out_features\`, and with 1 × 16
blocks those are two different quantized matrices, so the backward differentiates a function the
forward never computed. One scale per square tile makes both views the same tensor at the cost of a
coarser block. On Blackwell both are cheap: the FP4 conversion instructions have a stochastic
rounding mode, and a 2-D tile's scale is replicated into the 1 × 16 scale layout the tensor cores read,
so the GEMM never knows the weight was scaled in tiles.`,
};
