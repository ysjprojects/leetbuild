import type {Step} from '@/lib/types';

/**
 * A pattern that must occur inside one top-level definition: from its header, never crossing onto a
 * line that opens the next `def`, `class` or the self-test, to `body`.
 */
const inside = (header: string, body: string): RegExp =>
  new RegExp(`${header}(?:(?!\\n(?:def |class |if __name__))[\\s\\S])*?${body}`);

const PRECOMPUTE = String.raw`def precompute_rope_cache\(`;
const APPLY = String.raw`def apply_rope\(`;
const MODULE = String.raw`class RoPE\(`;

export const ropeStep: Step = {
  id: 'rope',
  title: 'precompute_rope_cache, apply_rope and the RoPE module',
  concept: 'pytorch',
  file: 'rope',
  focus: ['rope-q', 'rope-k', 'gather', 'cast', 'halves', 'rotate', 'concat'],
  task: `## Task

Implement rotary position embeddings in \`rope.py\`, in the half-split convention of Llama and GPT-NeoX:
dimension \`i\` of a head pairs with dimension \`i + head_dim // 2\`, and each pair is rotated by an angle
proportional to the token's position.

:::widget rope-rotation

- \`precompute_rope_cache(head_dim, max_seq_len, base=10000.0) -> (cos, sin)\`: two float32 tensors of shape
  \`[max_seq_len, head_dim // 2]\`. Pair \`i\` turns at \`theta_i = base ** (-2 i / head_dim)\`: build the
  \`head_dim // 2\` inverse frequencies with \`torch.arange(0, head_dim, 2)\`, the angle table as the outer product
  of \`torch.arange(max_seq_len)\` with them, and return its \`.cos()\` and \`.sin()\`. Assert \`head_dim\` is even.
- \`apply_rope(x, cos, sin, positions=None)\`: \`x\` is \`[batch, heads, seq, head_dim]\` in any float dtype;
  \`positions\` is \`[seq]\` int64 and defaults to \`torch.arange(seq)\`. Gather \`cos[positions]\` and
  \`sin[positions]\`, cast them to \`x.dtype\`, shape them \`[1, 1, seq, head_dim // 2]\`, split \`x\` into halves
  \`x1, x2 = x.chunk(2, dim=-1)\` and return \`torch.cat((x1 * c - x2 * s, x2 * c + x1 * s), dim=-1)\`, same
  shape and dtype as \`x\`. Passing \`positions = torch.arange(offset, offset + seq)\` is how a decode step
  rotates its new tokens against a KV cache that already holds \`offset\` rotated keys.
- \`RoPE(nn.Module)\`: \`__init__(head_dim, max_seq_len, base=10000.0)\` computes the cache once and registers
  \`cos\` and \`sin\` with \`self.register_buffer(..., persistent=False)\`: they follow \`.to(device)\` but stay
  out of \`state_dict\` and are never trained (no \`nn.Parameter\`). \`forward(x, positions=None)\` is
  \`apply_rope(x, self.cos, self.sin, positions)\`.
- No third-party rotary module (\`rotary_embedding_torch\`, \`torchtune\`, \`flash_attn\`): the three pieces above
  are the whole mechanism.
- The self-test at the end of the file stays as it is: with \`torch.manual_seed(0)\` and
  \`B, H, L, D, MAX = 2, 4, 8, 16, 64\` it checks the cache's shape and that \`cos² + sin² = 1\`; that
  \`apply_rope\` with explicit positions \`0..L-1\` equals the module exactly; that position 0 is the identity;
  agreement with a complex-number reference (\`e^{i m theta}\` per pair, \`atol=1e-5\`); that norms are
  preserved and bfloat16 comes back as bfloat16; that \`scores[m, n] = q_m · k_n\` over all 64 positions
  satisfies \`scores[d:, d:] == scores[:-d, :-d]\` for shifts 1, 7 and 40 (\`atol=1e-4\`, the cache being
  float32) while still varying with the distance; that one token rotated alone with offset 44 equals its slot
  in a sequence rotated at \`37..44\`; and a float64 \`torch.autograd.gradcheck\` with repeated, unordered
  positions. It prints \`PASS\`.

> Rotate q by \`m·theta\` and k by \`n·theta\` and their dot product is a function of \`m − n\` alone: the
> position reaches the attention score as a distance, with no table of pairs and no learned parameter.`,
  hints: [
    '`torch.arange(0, head_dim, 2)` is `0, 2, …, head_dim − 2`, so dividing it by `head_dim` gives the exponents `2i / head_dim` directly; pass `dtype=torch.float32` so the cache is float32 whatever the default dtype. In the angle table, positions run down the rows and frequencies across the columns.',
    'Indexing the cache with the positions tensor gives `[seq, head_dim // 2]` rows; two leading singleton dimensions make them broadcast over batch and heads. Build the default positions on `x.device`. The half with the minus sign comes first: a flipped sign rotates the wrong way and swapped halves scramble the pairs, and the complex reference catches both.',
    'Two `register_buffer(name, tensor, persistent=False)` calls in `__init__`, no `nn.Parameter`; `forward` is a single call to `apply_rope`.',
  ],
  checks: [
    {
      id: 'inverse-frequencies',
      title: 'Pair i turns at base^(−2i/d): the cache is [max_seq_len, head_dim // 2]',
      detail:
        '`precompute_rope_cache` builds `inv_freq = base ** (-torch.arange(0, head_dim, 2) / head_dim)` (`head_dim // 2` geometrically spaced frequencies from 1 down to `base^(−1 + 2/head_dim)`), so `cos` and `sin` come out `[max_seq_len, head_dim // 2]`; the self-test checks the shape and that `cos² + sin² = 1`.',
      match: {
        python: {
          all: [
            inside(PRECOMPUTE, String.raw`torch\.arange\(\s*0\s*,\s*head_dim\s*,\s*2\b`),
            inside(PRECOMPUTE, String.raw`\bbase\s*\*\*`),
          ],
        },
      },
    },
    {
      id: 'angle-table',
      title: 'cos and sin of every position × frequency, computed once',
      detail:
        'The angle table is the outer product of positions `0..max_seq_len−1` with `inv_freq` (`torch.outer`, or broadcasting), and its `.cos()` / `.sin()` are the cache. Computing angles or transcendentals inside `apply_rope` redoes that work in every layer of every step.',
      match: {
        python: {
          all: [
            inside(PRECOMPUTE, String.raw`torch\.outer\(|torch\.einsum\(|\[\s*:\s*,\s*None\s*\]|\.unsqueeze\(`),
            inside(PRECOMPUTE, String.raw`\.cos\(\)|torch\.cos\(`),
            inside(PRECOMPUTE, String.raw`\.sin\(\)|torch\.sin\(`),
          ],
        },
      },
    },
    {
      id: 'half-split-rotation',
      title: 'apply_rope rotates (x_i, x_{i + d/2}) into (x1 c − x2 s, x2 c + x1 s)',
      detail:
        'Split `x` into halves along `head_dim`, form `x1 * cos − x2 * sin` and `x2 * cos + x1 * sin`, and concatenate them in that order: the half-split convention of Llama and GPT-NeoX. The self-test compares against a complex-number reference at `1e-5`, checks that position 0 is the identity and that norms are preserved. No third-party rotary module.',
      match: {
        python: {
          all: [
            inside(APPLY, String.raw`\.chunk\(\s*2\s*,|\.split\(|\[\s*\.\.\.\s*,\s*:`),
            inside(APPLY, String.raw`\w+\s*\*\s*\w+\s*-\s*\w+\s*\*\s*\w+`),
            inside(APPLY, String.raw`\w+\s*\*\s*\w+\s*\+\s*\w+\s*\*\s*\w+`),
            inside(APPLY, String.raw`torch\.cat\(`),
          ],
          none: [/rotary_embedding_torch|torchtune|flash_attn/],
        },
      },
    },
    {
      id: 'positions-gather',
      title: 'Rows are gathered by position; the default is 0..seq−1; an offset serves the KV cache',
      detail:
        '`apply_rope(x, cos, sin, positions=None)` indexes `cos[positions]` and `sin[positions]` (`[seq, head_dim // 2]`), with `positions` defaulting to `torch.arange(seq)`. A decode step passes `torch.arange(offset, offset + seq)`: the self-test checks that a token rotated alone at position 44 equals its slot in a sequence rotated at `37..44`, and that explicit `0..L-1` equals the default exactly.',
      match: {
        python: {
          all: [
            inside(APPLY, String.raw`positions\s+is\s+None`),
            inside(APPLY, String.raw`torch\.arange\(`),
            inside(APPLY, String.raw`(cos|sin)\s*\[\s*positions\s*\]|index_select\(`),
          ],
        },
      },
    },
    {
      id: 'dtype-broadcast',
      title: "The gathered rows take x's dtype and broadcast over batch and heads",
      detail:
        'The cache stays float32; the gathered `[seq, head_dim // 2]` rows are cast with `.to(x.dtype)` and shaped `[1, 1, seq, head_dim // 2]` so one table serves every batch row and head. The self-test checks that float32 and bfloat16 inputs come back in their own dtype, and runs the relative-position check and `gradcheck` in float64.',
      match: {
        python: {
          all: [
            inside(APPLY, String.raw`\.to\(\s*(?:dtype\s*=\s*)?x\.dtype\s*\)|\.type_as\(\s*x\s*\)`),
            inside(
              APPLY,
              String.raw`\[\s*None\s*,\s*None\s*(?:,\s*:\s*,\s*:\s*)?\]|\.unsqueeze\(|\.view\(\s*1\s*,\s*1\s*,|\.reshape\(\s*1\s*,\s*1\s*,`,
            ),
          ],
        },
      },
    },
    {
      id: 'buffer',
      title: 'The cache is a non-persistent buffer of RoPE, not a Parameter',
      detail:
        '`RoPE.__init__` computes the cache once and calls `self.register_buffer("cos", cos, persistent=False)` and the same for `sin`: buffers follow `.to(device)` like weights but are recomputable, so they stay out of `state_dict` (the self-test asserts `"cos"` is not in it), and they are never trained: no `nn.Parameter`.',
      match: {
        python: {
          all: [
            inside(MODULE, String.raw`register_buffer\(\s*["']cos["'][^)]*persistent\s*=\s*False`),
            inside(MODULE, String.raw`register_buffer\(\s*["']sin["'][^)]*persistent\s*=\s*False`),
          ],
          none: [/nn\.Parameter\(/],
        },
      },
    },
    {
      id: 'module-forward',
      title: 'RoPE.forward delegates to apply_rope with its buffers',
      detail:
        '`forward(x, positions=None)` is `apply_rope(x, self.cos, self.sin, positions)`: one function serves the module in training and prefill and a caller holding only the tensors in a fused decode path. The self-test checks the two agree exactly.',
      match: {
        python: {
          all: [inside(MODULE, String.raw`apply_rope\(\s*x\s*,\s*self\.cos\s*,\s*self\.sin\s*,\s*positions\s*\)`)],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Rotary position embeddings (RoFormer; Llama, GPT-NeoX, Mistral, Qwen): rotate every (x_i, x_{i + d/2}) pair of a
query or key by an angle proportional to its position, so that q_m . k_n depends on m - n and nothing else."""
import torch
from torch import Tensor, nn


def precompute_rope_cache(head_dim: int, max_seq_len: int, base: float = 10000.0) -> tuple[Tensor, Tensor]:
    """cos and sin of every (position, pair) angle, each float32 [max_seq_len, head_dim // 2]."""
    # TODO: inv_freq = base ** (-arange(0, head_dim, 2) / head_dim); angles = outer(arange(max_seq_len), inv_freq)
    raise NotImplementedError("TODO")


def apply_rope(x: Tensor, cos: Tensor, sin: Tensor, positions: Tensor | None = None) -> Tensor:
    """Rotate x [batch, heads, seq, head_dim] by its tokens' angles; positions [seq] int64 defaults to 0..seq-1."""
    # TODO: default positions; gather the rows, cast to x.dtype, shape [1, 1, seq, head_dim // 2];
    #       halves x1, x2; cat(x1 c - x2 s, x2 c + x1 s)
    raise NotImplementedError("TODO")


class RoPE(nn.Module):
    """The cache as non-persistent buffers: it follows .to(device), stays out of state_dict and is never trained."""

    def __init__(self, head_dim: int, max_seq_len: int, base: float = 10000.0) -> None:
        super().__init__()
        # TODO: compute the cache once; register_buffer "cos" and "sin" with persistent=False
        raise NotImplementedError("TODO")

    def forward(self, x: Tensor, positions: Tensor | None = None) -> Tensor:
        # TODO: apply_rope with the buffers
        raise NotImplementedError("TODO")


def reference(x: Tensor, positions: Tensor, base: float = 10000.0) -> Tensor:
    """Independent check: each (x_i, x_{i + d/2}) pair as a complex number times e^{i m theta_i}, in float64."""
    d = x.shape[-1]
    theta = base ** (-torch.arange(0, d, 2, dtype=torch.float64) / d)
    rot = torch.polar(torch.ones(len(positions), d // 2, dtype=torch.float64), positions.double()[:, None] * theta)
    z = torch.complex(x[..., : d // 2].double(), x[..., d // 2 :].double()) * rot
    return torch.cat((z.real, z.imag), dim=-1).to(x.dtype)


if __name__ == "__main__":
    torch.manual_seed(0)
    B, H, L, D, MAX = 2, 4, 8, 16, 64
    rope = RoPE(D, MAX)
    x = torch.randn(B, H, L, D)

    # the cache: shape, unit circle, float32, out of the state_dict
    assert rope.cos.shape == (MAX, D // 2) and rope.sin.shape == (MAX, D // 2)
    assert torch.allclose(rope.cos**2 + rope.sin**2, torch.ones(MAX, D // 2), atol=1e-6)
    assert rope.cos.dtype == torch.float32 and "cos" not in rope.state_dict()

    # explicit positions 0..L-1 equal the module's default; position 0 is the identity; the complex reference agrees
    out = rope(x)
    assert out.shape == x.shape and out.dtype == x.dtype
    assert torch.equal(apply_rope(x, rope.cos, rope.sin, torch.arange(L)), out)
    assert torch.equal(out[:, :, 0], x[:, :, 0])
    assert torch.allclose(out, reference(x, torch.arange(L)), atol=1e-5)
    assert torch.allclose(out.norm(dim=-1), x.norm(dim=-1), atol=1e-5)  # a rotation keeps lengths
    assert rope(x.to(torch.bfloat16)).dtype == torch.bfloat16

    # relative position: q at m against k at n depends on m - n only
    q, k = torch.randn(2, D, dtype=torch.float64)
    qs = apply_rope(q.expand(1, 1, MAX, D), rope.cos, rope.sin)[0, 0]  # [MAX, D]: q rotated to every position
    ks = apply_rope(k.expand(1, 1, MAX, D), rope.cos, rope.sin)[0, 0]
    scores = qs @ ks.T  # scores[m, n] = q_m . k_n
    for shift in (1, 7, 40):
        assert torch.allclose(scores[shift:, shift:], scores[:-shift, :-shift], atol=1e-4)
    assert (scores[0] - scores[0, 0]).abs().max() > 0.1  # and it does change with the distance

    # KV cache: one new token rotated alone with its offset equals its slot in the full sequence
    offset = 37
    full = rope(x, torch.arange(offset, offset + L))
    last = rope(x[:, :, -1:], torch.arange(offset + L - 1, offset + L))
    assert last.shape == (B, H, 1, D) and torch.equal(last, full[:, :, -1:])

    # float64 gradcheck of the rotation, with repeated and unordered positions
    x64 = torch.randn(1, 2, 5, D, dtype=torch.float64, requires_grad=True)
    pos = torch.tensor([3, 0, 11, 11, 60])
    assert torch.autograd.gradcheck(lambda t: apply_rope(t, rope.cos, rope.sin, pos), (x64,))
    print("PASS")
`,
      solution: `"""Rotary position embeddings (RoFormer; Llama, GPT-NeoX, Mistral, Qwen): rotate every (x_i, x_{i + d/2}) pair of a
query or key by an angle proportional to its position, so that q_m . k_n depends on m - n and nothing else."""
import torch
from torch import Tensor, nn


def precompute_rope_cache(head_dim: int, max_seq_len: int, base: float = 10000.0) -> tuple[Tensor, Tensor]:
    """cos and sin of every (position, pair) angle, each float32 [max_seq_len, head_dim // 2]."""
    assert head_dim % 2 == 0, "head_dim must be even: dimensions rotate in pairs"
    inv_freq = base ** (-torch.arange(0, head_dim, 2, dtype=torch.float32) / head_dim)  # theta_i, [head_dim // 2]
    positions = torch.arange(max_seq_len, dtype=torch.float32)
    angles = torch.outer(positions, inv_freq)  # [max_seq_len, head_dim // 2]: m * theta_i
    return angles.cos(), angles.sin()


def apply_rope(x: Tensor, cos: Tensor, sin: Tensor, positions: Tensor | None = None) -> Tensor:
    """Rotate x [batch, heads, seq, head_dim] by its tokens' angles; positions [seq] int64 defaults to 0..seq-1."""
    seq = x.shape[-2]
    if positions is None:
        positions = torch.arange(seq, device=x.device)
    c = cos[positions].to(x.dtype)[None, None]  # [1, 1, seq, head_dim // 2], broadcast over batch and heads
    s = sin[positions].to(x.dtype)[None, None]
    x1, x2 = x.chunk(2, dim=-1)  # dimension i pairs with i + head_dim // 2
    return torch.cat((x1 * c - x2 * s, x2 * c + x1 * s), dim=-1)


class RoPE(nn.Module):
    """The cache as non-persistent buffers: it follows .to(device), stays out of state_dict and is never trained."""

    def __init__(self, head_dim: int, max_seq_len: int, base: float = 10000.0) -> None:
        super().__init__()
        cos, sin = precompute_rope_cache(head_dim, max_seq_len, base)
        self.register_buffer("cos", cos, persistent=False)
        self.register_buffer("sin", sin, persistent=False)

    def forward(self, x: Tensor, positions: Tensor | None = None) -> Tensor:
        return apply_rope(x, self.cos, self.sin, positions)


def reference(x: Tensor, positions: Tensor, base: float = 10000.0) -> Tensor:
    """Independent check: each (x_i, x_{i + d/2}) pair as a complex number times e^{i m theta_i}, in float64."""
    d = x.shape[-1]
    theta = base ** (-torch.arange(0, d, 2, dtype=torch.float64) / d)
    rot = torch.polar(torch.ones(len(positions), d // 2, dtype=torch.float64), positions.double()[:, None] * theta)
    z = torch.complex(x[..., : d // 2].double(), x[..., d // 2 :].double()) * rot
    return torch.cat((z.real, z.imag), dim=-1).to(x.dtype)


if __name__ == "__main__":
    torch.manual_seed(0)
    B, H, L, D, MAX = 2, 4, 8, 16, 64
    rope = RoPE(D, MAX)
    x = torch.randn(B, H, L, D)

    # the cache: shape, unit circle, float32, out of the state_dict
    assert rope.cos.shape == (MAX, D // 2) and rope.sin.shape == (MAX, D // 2)
    assert torch.allclose(rope.cos**2 + rope.sin**2, torch.ones(MAX, D // 2), atol=1e-6)
    assert rope.cos.dtype == torch.float32 and "cos" not in rope.state_dict()

    # explicit positions 0..L-1 equal the module's default; position 0 is the identity; the complex reference agrees
    out = rope(x)
    assert out.shape == x.shape and out.dtype == x.dtype
    assert torch.equal(apply_rope(x, rope.cos, rope.sin, torch.arange(L)), out)
    assert torch.equal(out[:, :, 0], x[:, :, 0])
    assert torch.allclose(out, reference(x, torch.arange(L)), atol=1e-5)
    assert torch.allclose(out.norm(dim=-1), x.norm(dim=-1), atol=1e-5)  # a rotation keeps lengths
    assert rope(x.to(torch.bfloat16)).dtype == torch.bfloat16

    # relative position: q at m against k at n depends on m - n only
    q, k = torch.randn(2, D, dtype=torch.float64)
    qs = apply_rope(q.expand(1, 1, MAX, D), rope.cos, rope.sin)[0, 0]  # [MAX, D]: q rotated to every position
    ks = apply_rope(k.expand(1, 1, MAX, D), rope.cos, rope.sin)[0, 0]
    scores = qs @ ks.T  # scores[m, n] = q_m . k_n
    for shift in (1, 7, 40):
        assert torch.allclose(scores[shift:, shift:], scores[:-shift, :-shift], atol=1e-4)
    assert (scores[0] - scores[0, 0]).abs().max() > 0.1  # and it does change with the distance

    # KV cache: one new token rotated alone with its offset equals its slot in the full sequence
    offset = 37
    full = rope(x, torch.arange(offset, offset + L))
    last = rope(x[:, :, -1:], torch.arange(offset + L - 1, offset + L))
    assert last.shape == (B, H, 1, D) and torch.equal(last, full[:, :, -1:])

    # float64 gradcheck of the rotation, with repeated and unordered positions
    x64 = torch.randn(1, 2, 5, D, dtype=torch.float64, requires_grad=True)
    pos = torch.tensor([3, 0, 11, 11, 60])
    assert torch.autograd.gradcheck(lambda t: apply_rope(t, rope.cos, rope.sin, pos), (x64,))
    print("PASS")
`,
    },
  },
  debrief: `RoPE is three small decisions. The **cache is computed once**, in float32, as a table of \`cos\` and \`sin\` over every position and every pair: a forward pass then does one gather, two multiplies and one subtraction or addition per element, and nothing transcendental. The angle for position \`m\` is \`m · theta_i\` with \`theta_i\` falling geometrically from 1 to just above \`1 / base\`, so the first pairs turn once every few tokens and the last once every tens of thousands: a clock with \`head_dim / 2\` hands, each at its own speed, which is what lets the model read both nearby order and distant position from the same vectors. The **rows are gathered by \`positions\`** rather than sliced from the front, so decoding a token against a KV cache is the same function with \`arange(offset, offset + 1)\`: the cached keys were rotated at their own positions, the new query at its own, and the score between them is still a function of the distance, the relative-position property the self-test checks numerically. Rotating by \`m·theta\` and \`n·theta\` and taking the dot product gives a rotation by \`(n − m)·theta\`, which is why no pair table and no learned parameter appear anywhere. The **half-split layout** (dimension \`i\` with \`i + head_dim // 2\`) is GPT-NeoX's: \`chunk\` and \`cat\` on whole halves, no strided reshape into pairs. The interleaved layout of the paper and of Meta's reference code (dimension \`2i\` with \`2i + 1\`) is the same rotation in a different basis, and Hugging Face permutes Llama's \`q\` and \`k\` projection weights at conversion so the two agree. Buffers rather than parameters because the table is a function of the config, not of the data: \`persistent=False\` keeps 64 MiB of cos and sin out of a 128K-context checkpoint. Production adds what this file leaves out. vLLM rotates \`q\` and \`k\` in place with one kernel indexed by \`positions\` (an \`is_neox_style\` flag picks the layout); FlashAttention's \`flash_attn_with_kvcache\` and TensorRT-LLM's attention plugin rotate the new keys as they write them into the KV cache; \`torch.compile\` fuses the gather and the four elementwise ops into one kernel. Hugging Face keeps only \`inv_freq\` as a buffer and recomputes \`cos\`/\`sin\` from \`position_ids\` in float32 on every forward, and context extension (position interpolation, NTK-aware scaling, YaRN, Llama 3's per-frequency smoothing) is a rescaling of \`inv_freq\` that touches nothing else.`,
};
