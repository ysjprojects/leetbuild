import type {Step} from '@/lib/types';

export const randomHadamardStep: Step = {
  id: 'random-hadamard',
  title: 'The random Hadamard transform, 16 × 16 tiles',
  concept: 'pytorch',
  file: 'nvfp4_rht',
  focus: ['rht'],
  task: `## Task

Write the transform the NVFP4 recipe applies to both inputs of the weight-gradient GEMM: a 16 × 16
Hadamard matrix with a random sign per row, applied tile by tile along the last dimension. It is
orthogonal, so a GEMM whose two operands are both transformed along the reduction dimension gives the
same product.

- \`sylvester_hadamard(d=16) -> (d, d)\` float32: \`H_1 = [[1]]\`, \`H_2n = [[H, H], [H, -H]]\` (two
  \`torch.cat\`s per doubling), divided by \`sqrt(d)\` so \`H Hᵀ = I\`. Entry \`(i, j)\` is
  \`(-1)^popcount(i & j) / 4\` for \`d = 16\`. \`d\` must be a power of two.
- \`random_signs(d=16, generator=None) -> (d,)\`: each entry \`+1\` or \`-1\` with probability 1/2, drawn
  from \`generator=generator\`.
- \`rht_matrix(signs) -> (d, d)\`: \`H = S · H_d / sqrt(d)\` with \`S = diag(signs)\`: sign \`i\` flips row
  \`i\` (\`signs.unsqueeze(1) * sylvester_hadamard(d)\`). The paper shares one sign vector across every
  layer for the whole run.
- \`rht(x, H) -> x'\`, the shape of \`x\`: reshape \`(..., K)\` to \`(..., K // 16, 16)\`, multiply every
  tile by \`H\` on the right, reshape back. \`K\` must be a multiple of 16.
- \`inverse_rht(y, H)\`: the same tiling, multiplied by \`Hᵀ\`.
- No \`scipy.linalg.hadamard\` and no fast-Hadamard-transform package: two \`torch.cat\`s are the
  construction.

:::widget stochastic-rounding {"mode": "hadamard", "outlier": 12}

The self-test checks the matrix against the closed form \`(-1)^popcount(i & j) / 4\`, \`H Hᵀ = I\` to
1e-6, \`H\` against row \`i\` of \`H_16\` times sign \`i\`; the blockwise GEMM identity
\`rht(x, H) @ rht(w, H).T = x @ w.T\` to 1e-4, the inverse and the norm; and that one outlier of 8 in a
16-block becomes 16 entries of magnitude 2. Then it quantizes a Gaussian and a Student-t(2) tensor
(1,024 × 256) with and without the transform and asserts what the transform really does at block
size 16: on Gaussian data nothing changes (a rotated Gaussian is Gaussian); on the heavy-tailed data the
mean crest factor (block max over block rms) falls by more than 0.5 (2.73 to 1.96) and the share of
values NVFP4 stores as 0 at least halves (17.3 % to 5.4 %), **while the relative quantization error
does not fall** (0.076 to 0.097). Then it prints \`PASS\`.

> A rotation does not make a tensor easier to round on average: it makes every block look like the
> same Gaussian. What that buys is that no block is dominated by one value and far fewer small values
> are flushed; the paper's evidence that this helps wgrad is the training loss, not the tensor's error norm.`,
  hints: [
    'Grow `H` from `torch.ones(1, 1)` until it is `d` wide: each doubling is one `torch.cat` of `[H, H]` and `[H, -H]` along `dim=1`, then one along `dim=0`. Divide by `math.sqrt(d)` once at the end, not per doubling.',
    '`torch.randint(0, 2, (d,), generator=generator).float() * 2 - 1` gives the signs. `signs.unsqueeze(1) * H` multiplies row `i` by `signs[i]`, which is `torch.diag(signs) @ H` without the matrix.',
    'For the tiling, `x.reshape(*x.shape[:-1], x.shape[-1] // d, d) @ H` multiplies every 16-wide tile at once (the matmul broadcasts over the leading dims); `.reshape(x.shape)` merges them back. A transposed input (`dy.T`) is not contiguous, which `reshape` handles and `view` does not.',
  ],
  checks: [
    {
      id: 'sylvester',
      title: 'Sylvester doubling builds the Hadamard matrix',
      detail:
        '`[[H, H], [H, -H]]` with `torch.cat` (or `torch.kron` with `[[1, 1], [1, -1]]`), from `[[1]]` up to 16 × 16. A library Hadamard (`scipy.linalg.hadamard`, `fast_hadamard_transform`) skips the construction.',
      match: {
        python: {
          all: [/torch\.(?:cat|kron|vstack|hstack)\(/],
          none: [/scipy/, /fast_hadamard/, /hadamard_transform/],
        },
      },
    },
    {
      id: 'normalised',
      title: 'Normalised by 1/√d, so H is orthogonal',
      detail:
        'Divide by `math.sqrt(d)` (or multiply by `d ** -0.5`): only then is `H Hᵀ = I`, the property that lets the two transformed GEMM operands cancel the transform.',
      match: {python: {all: [/sqrt\(\s*\w+\s*\)|\*\*\s*-?0\.5/]}},
    },
    {
      id: 'signs',
      title: 'Random ±1 signs drawn from the generator',
      detail:
        '`random_signs` draws from `generator=generator`, so one seeded generator fixes the one sign vector every layer shares.',
      match: {python: {all: [/generator\s*=\s*generator/]}},
    },
    {
      id: 'sign-rows',
      title: 'Sign i flips row i of the Hadamard matrix',
      detail:
        '`H = diag(signs) · H_d / sqrt(d)`: `signs.unsqueeze(1) * …`, `signs[:, None] * …` or `torch.diag(signs) @ …`, as the paper and Transformer Engine define the random Hadamard matrix.',
      match: {
        python: {all: [/unsqueeze\(\s*(?:1|-1)\s*\)\s*\*|\[\s*:\s*,\s*None\s*\]\s*\*|torch\.diag\(\s*\w+\s*\)\s*@/]},
      },
    },
    {
      id: 'tiles',
      title: 'Tiles of 16 along the last dim, each multiplied by H',
      detail:
        "The last dim is split into `shape[-1] // 16` tiles of 16 and every tile is multiplied by `H` on the right (`x' = x H`), the tiled transform of size 16 the recipe uses.",
      match: {
        python: {
          all: [/shape\[-1\]\s*\/\/\s*\w+/, /@\s*H\b(?!\.)|matmul\([^\n]*,\s*H\s*\)|einsum\(/],
        },
      },
    },
    {
      id: 'inverse',
      title: 'The inverse multiplies the tiles by Hᵀ',
      detail:
        '`H` is orthogonal, so `inverse_rht` multiplies each tile by `H.T`: no matrix inverse, and `inverse_rht(rht(x)) = x` to rounding.',
      match: {python: {all: [/\)\s*@\s*H\.(?:T|t\(\)|mT)\b/]}},
    },
  ],
  code: {
    python: {
      starter: `"""The random Hadamard transform NVFP4 training applies to the wgrad GEMM's inputs, 16 x 16 tiles."""

import math

import torch

from nvfp4_sr import quantize_nvfp4

D = 16  # transform size: one NVFP4 block


def sylvester_hadamard(d: int = D) -> torch.Tensor:
    """The d x d Sylvester Hadamard matrix scaled by 1 / sqrt(d): H_1 = [1], H_2n = [[H, H], [H, -H]]."""
    assert d > 0 and d & (d - 1) == 0, "d must be a power of two"
    raise NotImplementedError("TODO: Sylvester doubling from [[1]], then divide by sqrt(d)")


def random_signs(d: int = D, generator: torch.Generator | None = None) -> torch.Tensor:
    """A vector of d independent signs, each +1 or -1 with probability 1/2."""
    raise NotImplementedError("TODO: d draws of +1 or -1 from the generator")


def rht_matrix(signs: torch.Tensor) -> torch.Tensor:
    """H = S H_d / sqrt(d): the sign vector flips whole rows of the normalised Hadamard matrix."""
    raise NotImplementedError("TODO: sign i times row i of the normalised Hadamard matrix")


def rht(x: torch.Tensor, H: torch.Tensor) -> torch.Tensor:
    """x' = x H on every 16-wide tile of the last dim: (..., K) -> (..., K / 16, 16) @ H -> (..., K)."""
    raise NotImplementedError("TODO: split the last dim into 16-wide tiles, multiply each by H, merge back")


def inverse_rht(y: torch.Tensor, H: torch.Tensor) -> torch.Tensor:
    """Undo rht: H is orthogonal, so the inverse multiplies each tile by H^T."""
    raise NotImplementedError("TODO: the same tiling with H^T")


if __name__ == "__main__":
    torch.manual_seed(0)
    g = torch.Generator().manual_seed(0)

    # 1. Sylvester's construction against the closed form H[i, j] = (-1)^popcount(i & j) / 4, and orthogonality.
    ref = torch.tensor([[(-1.0) ** bin(i & j).count("1") for j in range(D)] for i in range(D)]) / 4
    assert torch.equal(sylvester_hadamard(D), ref), "Sylvester Hadamard, normalised"
    signs = random_signs(D, g)
    assert set(signs.tolist()) <= {-1.0, 1.0}
    H = rht_matrix(signs)
    assert torch.equal(H, torch.stack([signs[i] * ref[i] for i in range(D)])), "H = S H_16 / 4: sign i flips row i"
    assert torch.allclose(H @ H.T, torch.eye(D), atol=1e-6), "H is orthogonal"

    # 2. The blockwise GEMM identity (x H)(w H)^T = x w^T, the inverse, and the norm.
    x = torch.randn(64, 128, generator=g)
    w = torch.randn(32, 128, generator=g)
    assert torch.allclose(rht(x, H) @ rht(w, H).T, x @ w.T, atol=1e-4), "GEMM identity"
    assert torch.allclose(inverse_rht(rht(x, H), H), x, atol=1e-6), "inverse"
    assert torch.allclose(rht(x, H).norm(), x.norm(), rtol=1e-5), "norm preserved"

    # 3. One outlier in a 16-block is spread over all 16 entries at |o| / 4.
    blk = torch.zeros(1, 16)
    blk[0, 5] = 8.0
    assert torch.allclose(rht(blk, H).abs(), torch.full((1, 16), 2.0)), "outlier spread"

    # 4. Heavy tails: Student-t with 2 degrees of freedom, z / sqrt(chi2_2 / 2) with chi2_2 / 2 = -log(u).
    def crest(t: torch.Tensor) -> float:
        """Mean over 16-blocks of max / rms: how far the block maximum, which sets the scale, sits from the rest."""
        b = t.reshape(-1, 16)
        return (b.abs().amax(1) / b.pow(2).mean(1).sqrt()).mean().item()

    def flushed(t: torch.Tensor) -> float:
        """Fraction of the non-zero values NVFP4 stores as 0."""
        return ((quantize_nvfp4(t) == 0) & (t != 0)).float().mean().item()

    def rel_err(t: torch.Tensor, rotate: bool) -> float:
        back = inverse_rht(quantize_nvfp4(rht(t, H)), H) if rotate else quantize_nvfp4(t)
        return ((back - t).norm() / t.norm()).item()

    gauss = torch.randn(1024, 256, generator=g)
    heavy = torch.randn(1024, 256, generator=g) / torch.sqrt(-torch.log(torch.rand(1024, 256, generator=g)))
    rows = []
    for name, t in [("gaussian", gauss), ("student-t(2)", heavy)]:
        r = rht(t, H)
        rows.append((crest(t), crest(r), flushed(t), flushed(r), rel_err(t, False), rel_err(t, True)))
        c0, c1, f0, f1, e0, e1 = rows[-1]
        print(f"{name:13s} crest {c0:.2f} -> {c1:.2f}, flushed {f0:.1%} -> {f1:.1%}, rel. error {e0:.3f} -> {e1:.3f}")
    (gc0, gc1, gf0, gf1, _, _), (hc0, hc1, hf0, hf1, he0, he1) = rows
    assert abs(gc1 - gc0) < 0.05 and abs(gf1 - gf0) < 0.01, "a rotated Gaussian is a Gaussian: nothing changes"
    assert hc1 < hc0 - 0.5, "the transform pulls the heavy-tailed block maximum towards the rest"
    assert hf1 < hf0 / 2, "so far fewer values flush to zero"
    # What the transform does not buy at d = 16: the rotated block is Gaussian-like, and E2M1 with an E4M3 scale
    # already fits a heavy-tailed block's maximum well, so the relative MSE goes up, not down.
    assert he1 > he0, "relative MSE does not fall at block size 16"
    print("PASS")
`,
      solution: `"""The random Hadamard transform NVFP4 training applies to the wgrad GEMM's inputs, 16 x 16 tiles."""

import math

import torch

from nvfp4_sr import quantize_nvfp4

D = 16  # transform size: one NVFP4 block


def sylvester_hadamard(d: int = D) -> torch.Tensor:
    """The d x d Sylvester Hadamard matrix scaled by 1 / sqrt(d): H_1 = [1], H_2n = [[H, H], [H, -H]]."""
    assert d > 0 and d & (d - 1) == 0, "d must be a power of two"
    H = torch.ones(1, 1)
    while H.shape[0] < d:
        H = torch.cat([torch.cat([H, H], dim=1), torch.cat([H, -H], dim=1)], dim=0)
    return H / math.sqrt(d)


def random_signs(d: int = D, generator: torch.Generator | None = None) -> torch.Tensor:
    """A vector of d independent signs, each +1 or -1 with probability 1/2."""
    return torch.randint(0, 2, (d,), generator=generator).float() * 2 - 1


def rht_matrix(signs: torch.Tensor) -> torch.Tensor:
    """H = S H_d / sqrt(d): the sign vector flips whole rows of the normalised Hadamard matrix."""
    return signs.unsqueeze(1) * sylvester_hadamard(signs.numel())


def rht(x: torch.Tensor, H: torch.Tensor) -> torch.Tensor:
    """x' = x H on every 16-wide tile of the last dim: (..., K) -> (..., K / 16, 16) @ H -> (..., K)."""
    d = H.shape[0]
    assert x.shape[-1] % d == 0, "the last dim must be a multiple of the transform size"
    return (x.reshape(*x.shape[:-1], x.shape[-1] // d, d) @ H).reshape(x.shape)


def inverse_rht(y: torch.Tensor, H: torch.Tensor) -> torch.Tensor:
    """Undo rht: H is orthogonal, so the inverse multiplies each tile by H^T."""
    d = H.shape[0]
    return (y.reshape(*y.shape[:-1], y.shape[-1] // d, d) @ H.T).reshape(y.shape)


if __name__ == "__main__":
    torch.manual_seed(0)
    g = torch.Generator().manual_seed(0)

    # 1. Sylvester's construction against the closed form H[i, j] = (-1)^popcount(i & j) / 4, and orthogonality.
    ref = torch.tensor([[(-1.0) ** bin(i & j).count("1") for j in range(D)] for i in range(D)]) / 4
    assert torch.equal(sylvester_hadamard(D), ref), "Sylvester Hadamard, normalised"
    signs = random_signs(D, g)
    assert set(signs.tolist()) <= {-1.0, 1.0}
    H = rht_matrix(signs)
    assert torch.equal(H, torch.stack([signs[i] * ref[i] for i in range(D)])), "H = S H_16 / 4: sign i flips row i"
    assert torch.allclose(H @ H.T, torch.eye(D), atol=1e-6), "H is orthogonal"

    # 2. The blockwise GEMM identity (x H)(w H)^T = x w^T, the inverse, and the norm.
    x = torch.randn(64, 128, generator=g)
    w = torch.randn(32, 128, generator=g)
    assert torch.allclose(rht(x, H) @ rht(w, H).T, x @ w.T, atol=1e-4), "GEMM identity"
    assert torch.allclose(inverse_rht(rht(x, H), H), x, atol=1e-6), "inverse"
    assert torch.allclose(rht(x, H).norm(), x.norm(), rtol=1e-5), "norm preserved"

    # 3. One outlier in a 16-block is spread over all 16 entries at |o| / 4.
    blk = torch.zeros(1, 16)
    blk[0, 5] = 8.0
    assert torch.allclose(rht(blk, H).abs(), torch.full((1, 16), 2.0)), "outlier spread"

    # 4. Heavy tails: Student-t with 2 degrees of freedom, z / sqrt(chi2_2 / 2) with chi2_2 / 2 = -log(u).
    def crest(t: torch.Tensor) -> float:
        """Mean over 16-blocks of max / rms: how far the block maximum, which sets the scale, sits from the rest."""
        b = t.reshape(-1, 16)
        return (b.abs().amax(1) / b.pow(2).mean(1).sqrt()).mean().item()

    def flushed(t: torch.Tensor) -> float:
        """Fraction of the non-zero values NVFP4 stores as 0."""
        return ((quantize_nvfp4(t) == 0) & (t != 0)).float().mean().item()

    def rel_err(t: torch.Tensor, rotate: bool) -> float:
        back = inverse_rht(quantize_nvfp4(rht(t, H)), H) if rotate else quantize_nvfp4(t)
        return ((back - t).norm() / t.norm()).item()

    gauss = torch.randn(1024, 256, generator=g)
    heavy = torch.randn(1024, 256, generator=g) / torch.sqrt(-torch.log(torch.rand(1024, 256, generator=g)))
    rows = []
    for name, t in [("gaussian", gauss), ("student-t(2)", heavy)]:
        r = rht(t, H)
        rows.append((crest(t), crest(r), flushed(t), flushed(r), rel_err(t, False), rel_err(t, True)))
        c0, c1, f0, f1, e0, e1 = rows[-1]
        print(f"{name:13s} crest {c0:.2f} -> {c1:.2f}, flushed {f0:.1%} -> {f1:.1%}, rel. error {e0:.3f} -> {e1:.3f}")
    (gc0, gc1, gf0, gf1, _, _), (hc0, hc1, hf0, hf1, he0, he1) = rows
    assert abs(gc1 - gc0) < 0.05 and abs(gf1 - gf0) < 0.01, "a rotated Gaussian is a Gaussian: nothing changes"
    assert hc1 < hc0 - 0.5, "the transform pulls the heavy-tailed block maximum towards the rest"
    assert hf1 < hf0 / 2, "so far fewer values flush to zero"
    # What the transform does not buy at d = 16: the rotated block is Gaussian-like, and E2M1 with an E4M3 scale
    # already fits a heavy-tailed block's maximum well, so the relative MSE goes up, not down.
    assert he1 > he0, "relative MSE does not fall at block size 16"
    print("PASS")
`,
    },
  },
  debrief: `The construction is two lines because a Sylvester Hadamard matrix is its own recursion, and
the normalisation makes it orthogonal, so \`(x H)(w H)ᵀ = x H Hᵀ wᵀ = x wᵀ\`: rotating both operands
along the reduction dimension leaves a GEMM's result unchanged and changes only what the quantizer
sees. The random signs keep a structured pattern that happens to align with a Hadamard row from
surviving the transform. What it changes is the shape of every block: a single outlier becomes 16
entries of equal magnitude, a heavy-tailed block becomes close to Gaussian, its crest factor falls and
far fewer small values are flushed to 0. What it does **not** do at block size 16 is lower the
relative error: the self-test measures it rising from 0.076 to 0.097 on Student-t data. Egiazarian
et al. (2025) predict that a Hadamard transform hurts the relative error at small group sizes and
helps at large ones, and measure exactly that for NVFP4 on Laplace samples and Llama-3.1-8B tensors:
the E4M3 scale already maps a heavy-tailed block's maximum almost exactly onto 6, and the rotation
spreads that maximum's energy over the coarse E2M1 grid. MXFP4, with power-of-two scales, gains much
more from rotations. The NVFP4 pretraining paper applies the transform only to the wgrad inputs:
there it lowers the validation loss of its 1.2B model, while rotating the fprop or dgrad inputs makes
that model worse, and the random signs and the matrix size make no measurable difference at 1.2B and
only matter at 12B. The paper credits the transform with bounding block-level outliers; its evidence
is the training loss, not a tensor's error norm. Transformer Engine computes the
16 × 16 matrix once and caches it; per the paper the transform is a batched matmul of \`m · k · 16\`
multiply-adds, bound by reading the tensor, and can be fused with the kernels around it.`,
};
