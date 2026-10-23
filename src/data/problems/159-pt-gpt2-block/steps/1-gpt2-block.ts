import type {Step} from '@/lib/types';

export const gpt2BlockStep: Step = {
  id: 'gpt2-block',
  title: 'Block: pre-LN, two residuals, a 4× GELU MLP, GPT-2 init',
  concept: 'pytorch',
  file: 'gpt2_block',
  focus: ['ln1', 'add1', 'ln2', 'mlp', 'add2'],
  task: `## Task

Implement the layer GPT-2 stacks \`n_layer\` times: \`MLP(cfg)\` and \`Block(cfg)\` over a \`GPTConfig\`
(\`n_embd\`, \`n_head\`, \`n_layer\`, \`block_size\`, \`dropout\`). \`CausalSelfAttention\` is given (it is the
sibling problem), and so is the self-test; everything else in the file is yours.

- \`gelu_tanh(x)\`: GPT-2's activation, written out: \`0.5 · x · (1 + tanh(√(2/π) · (x + 0.044715 · x³)))\`
  with \`torch.tanh\` and \`math.sqrt(2 / math.pi)\`. \`nn.GELU\` is forbidden; \`F.gelu(…, approximate="tanh")\`
  is the reference the self-test compares against (\`atol = 1e-12\` in float64).
- \`MLP\`: \`c_fc = nn.Linear(n_embd, 4 · n_embd)\`, \`c_proj = nn.Linear(4 · n_embd, n_embd)\`,
  \`dropout = nn.Dropout(cfg.dropout)\`; \`forward(x)\` is \`dropout(c_proj(gelu_tanh(c_fc(x))))\`, in that
  order. Shapes: \`(B, T, C)\` → \`(B, T, 4C)\` → \`(B, T, C)\`.
- \`Block\`: \`ln_1\` and \`ln_2\` are \`nn.LayerNorm(n_embd)\`, \`attn\` a \`CausalSelfAttention\`, \`mlp\` an
  \`MLP\`. \`forward(x)\` is **pre-LN**: \`x = x + attn(ln_1(x))\`, then \`x = x + mlp(ln_2(x))\`. The residual
  adds to the *un-normalised* stream; \`ln_1(x + …)\` (post-LN) is wrong here.
- \`Block.__init__\` ends with GPT-2's initialisation: \`self.apply(self._init_weights)\`, where
  \`_init_weights(module)\` sets every \`nn.Linear\` weight to \`normal_(mean=0.0, std=0.02)\` and bias to
  \`zeros_\`, every \`nn.LayerNorm\` to \`ones_\` weight and \`zeros_\` bias; **after** \`apply\`, every parameter
  whose name \`endswith("c_proj.weight")\` (both the attention's and the MLP's) is re-drawn with
  \`std = 0.02 / math.sqrt(2 * n_layer)\`.
- Self-test (\`torch.manual_seed(0)\`, \`n_embd = 64\`, \`n_head = 4\`, \`n_layer = 12\`, \`B = 2\`, \`T = 16\`):
  \`gelu_tanh\` against \`F.gelu\`; the block's output has shape \`(2, 16, 64)\` and matches a functional
  reference built on \`F.scaled_dot_product_attention(is_causal=True)\` to \`atol = 1e-5\`; positions before
  \`T/2\` are unchanged when the later ones change; with both \`c_proj\` zeroed the block is the identity
  (\`torch.equal\`); on a 256-wide block the linears' std is within 5 % of \`0.02\`, the \`c_proj\`s within 5 %
  of \`0.02 / √24\`, biases are exactly zero and LayerNorms exactly one; \`torch.autograd.gradcheck\` of an
  8-wide \`MLP\` in float64 passes. Then \`PASS\`.

> A block is the identity plus two small corrections. Pre-LN keeps the corrections small at init, and
> scaling \`c_proj\` by \`1/√(2·n_layer)\` keeps the sum of \`2·n_layer\` corrections from outgrowing the stream.`,
  hints: [
    'Write `gelu_tanh` first, straight from the task’s formula (`torch.pow(x, 3.0)` or `x * x * x` for the cube), and run the file: the first assertion checks only that. The MLP is then two `nn.Linear`s around it.',
    '`self.apply(fn)` calls `fn` on every submodule, including the attention’s linears. Branch on `isinstance(module, nn.Linear)` / `nn.LayerNorm`; `nn.Linear` has a bias here, but guard `module.bias is not None` anyway. The `c_proj` rescale is a loop over `self.named_parameters()` placed *after* `apply`, or `apply` overwrites it.',
    '`forward` is two lines, and neither line calls a LayerNorm on a sum or assigns its output to `x`. If the `"reference"` assertion fails, you have post-LN or you added to the normalised stream instead of the raw one.',
  ],
  checks: [
    {
      id: 'mlp-widths',
      title: 'The MLP expands 4× and projects back',
      detail:
        '`c_fc` is `nn.Linear(n_embd, 4 * n_embd)` and `c_proj` is `nn.Linear(4 * n_embd, n_embd)`: the hidden width GPT-2 uses, and where two thirds of a block’s parameters live.',
      match: {
        python: {
          all: [
            /self\.c_fc\s*=\s*nn\.Linear\(\s*[\w.]+\s*,\s*(?:4\s*\*\s*[\w.]+|[\w.]+\s*\*\s*4)\s*\)/,
            /self\.c_proj\s*=\s*nn\.Linear\(\s*(?:4\s*\*\s*[\w.]+|[\w.]+\s*\*\s*4)\s*,\s*[\w.]+\s*\)/,
          ],
        },
      },
    },
    {
      id: 'gelu-tanh',
      title: 'GELU is the tanh approximation, written out',
      detail:
        '`gelu_tanh` computes `0.5 · x · (1 + tanh(√(2/π) · (x + 0.044715 · x³)))` with `torch.tanh` and `math.sqrt(2 / math.pi)`; `nn.GELU` is not used. The self-test holds it to `F.gelu(approximate="tanh")` at `1e-12`.',
      match: {
        python: {
          all: [/0\.044715/, /torch\.tanh\(/, /math\.sqrt\(\s*2(?:\.0)?\s*\/\s*math\.pi\s*\)/],
          none: [/nn\.GELU\(/],
        },
      },
    },
    {
      id: 'mlp-order',
      title: 'MLP.forward is c_fc → gelu → c_proj → dropout',
      detail:
        'The activation sits between the two linears and dropout is last, on the output that joins the residual stream; `self.dropout` is an `nn.Dropout(cfg.dropout)`.',
      match: {
        python: {
          all: [/self\.dropout\s*=\s*nn\.Dropout\(/],
          order: [/self\.c_fc\(/, /gelu_tanh\(/, /self\.c_proj\(/, /self\.dropout\(/],
        },
      },
    },
    {
      id: 'pre-ln',
      title: 'Two LayerNorms, each before its sublayer',
      detail:
        '`ln_1` and `ln_2` are `nn.LayerNorm(n_embd)` and normalise the *input* of attention and of the MLP. A LayerNorm applied to `x + …` is post-LN: the original Transformer’s order, not GPT-2’s.',
      match: {
        python: {
          all: [/self\.ln_1\s*=\s*nn\.LayerNorm\(/, /self\.ln_2\s*=\s*nn\.LayerNorm\(/],
          none: [/self\.ln_1\(\s*x\s*\+/, /self\.ln_2\(\s*x\s*\+/],
        },
      },
    },
    {
      id: 'residual',
      title: 'The residual adds each sublayer to the un-normalised stream',
      detail:
        '`x + self.attn(self.ln_1(x))`, then `x + self.mlp(self.ln_2(x))`, attention first. With both `c_proj` zeroed the block must return `x` bit-for-bit.',
      match: {
        python: {
          all: [
            /x\s*\+\s*self\.attn\(\s*self\.ln_1\(\s*x\s*\)\s*\)/,
            /x\s*\+\s*self\.mlp\(\s*self\.ln_2\(\s*x\s*\)\s*\)/,
          ],
          order: [/x\s*\+\s*self\.attn\(\s*self\.ln_1\(/, /x\s*\+\s*self\.mlp\(\s*self\.ln_2\(/],
        },
      },
    },
    {
      id: 'init-linear',
      title: 'Linears start at N(0, 0.02) with zero bias',
      detail:
        '`self.apply(self._init_weights)` visits every submodule; an `nn.Linear` gets `normal_(weight, mean=0.0, std=0.02)` and `zeros_(bias)`. PyTorch’s default Kaiming-uniform init is not GPT-2’s.',
      match: {
        python: {
          all: [
            /self\.apply\(/,
            /isinstance\(\s*\w+\s*,\s*nn\.Linear\s*\)/,
            /normal_\(\s*\w+\.weight\s*,\s*mean\s*=\s*0(?:\.0)?\s*,\s*std\s*=\s*0\.02\s*\)/,
            /zeros_\(\s*\w+\.bias\s*\)/,
          ],
        },
      },
    },
    {
      id: 'init-layernorm',
      title: 'LayerNorms start as the identity',
      detail:
        'An `nn.LayerNorm` gets `ones_(weight)` and `zeros_(bias)`: at init the block’s normalisers only standardise.',
      match: {
        python: {all: [/isinstance\(\s*\w+\s*,\s*nn\.LayerNorm\s*\)/, /ones_\(\s*\w+\.weight\s*\)/]},
      },
    },
    {
      id: 'resid-scaling',
      title: 'Residual projections are scaled by 1/√(2·n_layer), after apply',
      detail:
        'Every parameter named `…c_proj.weight` (the attention’s and the MLP’s) is re-drawn with `std = 0.02 / math.sqrt(2 * n_layer)`, and that loop runs *after* `self.apply(...)`, which would otherwise overwrite it with `0.02`.',
      match: {
        python: {
          all: [/endswith\(\s*["']c_proj\.weight["']\s*\)/, /0\.02\s*\/\s*math\.sqrt\(\s*2\s*\*\s*[\w.]*n_layer\s*\)/],
          order: [/self\.apply\(/, /0\.02\s*\/\s*math\.sqrt\(\s*2\s*\*/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""A GPT-2 transformer block: pre-LayerNorm, causal self-attention, a 4x GELU MLP, a residual around each, and GPT-2's initialisation."""

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GPTConfig:
    n_embd: int = 64
    n_head: int = 4
    n_layer: int = 12
    block_size: int = 32
    dropout: float = 0.0


def gelu_tanh(x: torch.Tensor) -> torch.Tensor:
    """GPT-2's GELU: the tanh approximation of x * Phi(x), written out."""
    # TODO: 0.5 * x * (1 + tanh(sqrt(2/pi) * (x + c * x^3))) with GPT-2's constant c
    raise NotImplementedError("TODO")


class CausalSelfAttention(nn.Module):
    """Multi-head causal self-attention; given, not the point of this problem."""

    def __init__(self, cfg: GPTConfig):
        super().__init__()
        assert cfg.n_embd % cfg.n_head == 0
        self.n_head = cfg.n_head
        self.c_attn = nn.Linear(cfg.n_embd, 3 * cfg.n_embd)
        self.c_proj = nn.Linear(cfg.n_embd, cfg.n_embd)
        self.attn_dropout = nn.Dropout(cfg.dropout)
        self.resid_dropout = nn.Dropout(cfg.dropout)
        mask = torch.tril(torch.ones(cfg.block_size, cfg.block_size, dtype=torch.bool))
        self.register_buffer("mask", mask.view(1, 1, cfg.block_size, cfg.block_size), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.c_attn(x).split(C, dim=2)
        q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(k.size(-1))
        att = att.masked_fill(~self.mask[:, :, :T, :T], float("-inf"))
        att = F.softmax(att, dim=-1)
        att = self.attn_dropout(att)
        y = (att @ v).transpose(1, 2).contiguous().view(B, T, C)
        return self.resid_dropout(self.c_proj(y))


class MLP(nn.Module):
    """c_fc: C -> 4C, GELU (tanh), c_proj: 4C -> C, dropout."""

    def __init__(self, cfg: GPTConfig):
        super().__init__()
        # TODO: c_fc, c_proj, dropout
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: c_fc -> gelu_tanh -> c_proj -> dropout
        raise NotImplementedError("TODO")


class Block(nn.Module):
    """x -> x + attn(ln_1(x)) -> x + mlp(ln_2(x)), initialised the way GPT-2 is."""

    def __init__(self, cfg: GPTConfig):
        super().__init__()
        # TODO: ln_1, attn, ln_2, mlp; then self.apply(self._init_weights);
        # then re-draw every parameter named ...c_proj.weight with std 0.02 / sqrt(2 * n_layer)
        raise NotImplementedError("TODO")

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        # TODO: nn.Linear -> N(0, 0.02) weight, zero bias; nn.LayerNorm -> ones weight, zero bias
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: pre-LN with a residual around each sublayer
        raise NotImplementedError("TODO")


def reference_block(blk: Block, x: torch.Tensor) -> torch.Tensor:
    """The same block written functionally with PyTorch's own GELU and causal SDPA."""
    B, T, C = x.shape
    H = blk.attn.n_head
    h = F.layer_norm(x, (C,), blk.ln_1.weight, blk.ln_1.bias)
    q, k, v = F.linear(h, blk.attn.c_attn.weight, blk.attn.c_attn.bias).split(C, dim=2)
    q, k, v = (t.view(B, T, H, C // H).transpose(1, 2) for t in (q, k, v))
    a = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, T, C)
    x = x + F.linear(a, blk.attn.c_proj.weight, blk.attn.c_proj.bias)
    h = F.layer_norm(x, (C,), blk.ln_2.weight, blk.ln_2.bias)
    m = F.gelu(F.linear(h, blk.mlp.c_fc.weight, blk.mlp.c_fc.bias), approximate="tanh")
    return x + F.linear(m, blk.mlp.c_proj.weight, blk.mlp.c_proj.bias)


if __name__ == "__main__":
    torch.manual_seed(0)
    cfg = GPTConfig(n_embd=64, n_head=4, n_layer=12, block_size=32, dropout=0.0)
    B, T = 2, 16

    # 1. The GELU formula matches PyTorch's tanh approximation.
    z = torch.randn(1000, dtype=torch.float64) * 4
    assert torch.allclose(gelu_tanh(z), F.gelu(z, approximate="tanh"), atol=1e-12), "gelu_tanh"

    # 2. Shape and agreement with a functional reference (pre-LN, causal, 4x GELU MLP).
    blk = Block(cfg).eval()
    x = torch.randn(B, T, cfg.n_embd)
    y = blk(x)
    assert y.shape == (B, T, cfg.n_embd), y.shape
    assert torch.allclose(y, reference_block(blk, x), atol=1e-5, rtol=1e-4), "reference"

    # 3. Causality: position t sees nothing after t.
    x2 = x.clone()
    x2[:, T // 2 :] = torch.randn(B, T - T // 2, cfg.n_embd)
    assert torch.allclose(blk(x2)[:, : T // 2], y[:, : T // 2], atol=1e-6), "causal"

    # 4. Residual identity: zero both c_proj and the block is the identity, exactly.
    with torch.no_grad():
        for lin in (blk.attn.c_proj, blk.mlp.c_proj):
            lin.weight.zero_()
            lin.bias.zero_()
    assert torch.equal(blk(x), x), "residual identity"

    # 5. Init statistics on a wide block: N(0, 0.02) linears, zero biases, unit LayerNorm, scaled c_proj.
    wide = Block(GPTConfig(n_embd=256, n_head=8, n_layer=12, block_size=32))
    for lin in (wide.attn.c_attn, wide.mlp.c_fc):
        assert abs(lin.weight.mean().item()) < 1e-3, "linear mean"
        assert abs(lin.weight.std().item() - 0.02) < 0.02 * 0.05, "linear std"
        assert torch.equal(lin.bias, torch.zeros_like(lin.bias)), "linear bias"
    scaled = 0.02 / (2 * 12) ** 0.5
    for lin in (wide.attn.c_proj, wide.mlp.c_proj):
        assert abs(lin.weight.std().item() - scaled) < scaled * 0.05, "c_proj std"
    for ln in (wide.ln_1, wide.ln_2):
        assert torch.equal(ln.weight, torch.ones_like(ln.weight)), "ln weight"
        assert torch.equal(ln.bias, torch.zeros_like(ln.bias)), "ln bias"

    # 6. Gradients of the MLP in float64.
    mlp = MLP(GPTConfig(n_embd=8)).double().eval()
    xg = torch.randn(2, 3, 8, dtype=torch.float64, requires_grad=True)
    assert torch.autograd.gradcheck(mlp, (xg,), eps=1e-6, atol=1e-4), "gradcheck"

    print("PASS")
`,
      solution: `"""A GPT-2 transformer block: pre-LayerNorm, causal self-attention, a 4x GELU MLP, a residual around each, and GPT-2's initialisation."""

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GPTConfig:
    n_embd: int = 64
    n_head: int = 4
    n_layer: int = 12
    block_size: int = 32
    dropout: float = 0.0


def gelu_tanh(x: torch.Tensor) -> torch.Tensor:
    """GPT-2's GELU: the tanh approximation of x * Phi(x), written out."""
    return 0.5 * x * (1.0 + torch.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * torch.pow(x, 3.0))))


class CausalSelfAttention(nn.Module):
    """Multi-head causal self-attention; given, not the point of this problem."""

    def __init__(self, cfg: GPTConfig):
        super().__init__()
        assert cfg.n_embd % cfg.n_head == 0
        self.n_head = cfg.n_head
        self.c_attn = nn.Linear(cfg.n_embd, 3 * cfg.n_embd)
        self.c_proj = nn.Linear(cfg.n_embd, cfg.n_embd)
        self.attn_dropout = nn.Dropout(cfg.dropout)
        self.resid_dropout = nn.Dropout(cfg.dropout)
        mask = torch.tril(torch.ones(cfg.block_size, cfg.block_size, dtype=torch.bool))
        self.register_buffer("mask", mask.view(1, 1, cfg.block_size, cfg.block_size), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.c_attn(x).split(C, dim=2)
        q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(k.size(-1))
        att = att.masked_fill(~self.mask[:, :, :T, :T], float("-inf"))
        att = F.softmax(att, dim=-1)
        att = self.attn_dropout(att)
        y = (att @ v).transpose(1, 2).contiguous().view(B, T, C)
        return self.resid_dropout(self.c_proj(y))


class MLP(nn.Module):
    """c_fc: C -> 4C, GELU (tanh), c_proj: 4C -> C, dropout."""

    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.c_fc = nn.Linear(cfg.n_embd, 4 * cfg.n_embd)
        self.c_proj = nn.Linear(4 * cfg.n_embd, cfg.n_embd)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.c_fc(x)
        x = gelu_tanh(x)
        x = self.c_proj(x)
        return self.dropout(x)


class Block(nn.Module):
    """x -> x + attn(ln_1(x)) -> x + mlp(ln_2(x)), initialised the way GPT-2 is."""

    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.ln_1 = nn.LayerNorm(cfg.n_embd)
        self.attn = CausalSelfAttention(cfg)
        self.ln_2 = nn.LayerNorm(cfg.n_embd)
        self.mlp = MLP(cfg)
        self.apply(self._init_weights)
        # The residual stream receives 2 * n_layer projections; shrink each so their sum stays O(1).
        for name, p in self.named_parameters():
            if name.endswith("c_proj.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * cfg.n_layer))

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.LayerNorm):
            nn.init.ones_(module.weight)
            nn.init.zeros_(module.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln_1(x))
        x = x + self.mlp(self.ln_2(x))
        return x


def reference_block(blk: Block, x: torch.Tensor) -> torch.Tensor:
    """The same block written functionally with PyTorch's own GELU and causal SDPA."""
    B, T, C = x.shape
    H = blk.attn.n_head
    h = F.layer_norm(x, (C,), blk.ln_1.weight, blk.ln_1.bias)
    q, k, v = F.linear(h, blk.attn.c_attn.weight, blk.attn.c_attn.bias).split(C, dim=2)
    q, k, v = (t.view(B, T, H, C // H).transpose(1, 2) for t in (q, k, v))
    a = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, T, C)
    x = x + F.linear(a, blk.attn.c_proj.weight, blk.attn.c_proj.bias)
    h = F.layer_norm(x, (C,), blk.ln_2.weight, blk.ln_2.bias)
    m = F.gelu(F.linear(h, blk.mlp.c_fc.weight, blk.mlp.c_fc.bias), approximate="tanh")
    return x + F.linear(m, blk.mlp.c_proj.weight, blk.mlp.c_proj.bias)


if __name__ == "__main__":
    torch.manual_seed(0)
    cfg = GPTConfig(n_embd=64, n_head=4, n_layer=12, block_size=32, dropout=0.0)
    B, T = 2, 16

    # 1. The GELU formula matches PyTorch's tanh approximation.
    z = torch.randn(1000, dtype=torch.float64) * 4
    assert torch.allclose(gelu_tanh(z), F.gelu(z, approximate="tanh"), atol=1e-12), "gelu_tanh"

    # 2. Shape and agreement with a functional reference (pre-LN, causal, 4x GELU MLP).
    blk = Block(cfg).eval()
    x = torch.randn(B, T, cfg.n_embd)
    y = blk(x)
    assert y.shape == (B, T, cfg.n_embd), y.shape
    assert torch.allclose(y, reference_block(blk, x), atol=1e-5, rtol=1e-4), "reference"

    # 3. Causality: position t sees nothing after t.
    x2 = x.clone()
    x2[:, T // 2 :] = torch.randn(B, T - T // 2, cfg.n_embd)
    assert torch.allclose(blk(x2)[:, : T // 2], y[:, : T // 2], atol=1e-6), "causal"

    # 4. Residual identity: zero both c_proj and the block is the identity, exactly.
    with torch.no_grad():
        for lin in (blk.attn.c_proj, blk.mlp.c_proj):
            lin.weight.zero_()
            lin.bias.zero_()
    assert torch.equal(blk(x), x), "residual identity"

    # 5. Init statistics on a wide block: N(0, 0.02) linears, zero biases, unit LayerNorm, scaled c_proj.
    wide = Block(GPTConfig(n_embd=256, n_head=8, n_layer=12, block_size=32))
    for lin in (wide.attn.c_attn, wide.mlp.c_fc):
        assert abs(lin.weight.mean().item()) < 1e-3, "linear mean"
        assert abs(lin.weight.std().item() - 0.02) < 0.02 * 0.05, "linear std"
        assert torch.equal(lin.bias, torch.zeros_like(lin.bias)), "linear bias"
    scaled = 0.02 / (2 * 12) ** 0.5
    for lin in (wide.attn.c_proj, wide.mlp.c_proj):
        assert abs(lin.weight.std().item() - scaled) < scaled * 0.05, "c_proj std"
    for ln in (wide.ln_1, wide.ln_2):
        assert torch.equal(ln.weight, torch.ones_like(ln.weight)), "ln weight"
        assert torch.equal(ln.bias, torch.zeros_like(ln.bias)), "ln bias"

    # 6. Gradients of the MLP in float64.
    mlp = MLP(GPTConfig(n_embd=8)).double().eval()
    xg = torch.randn(2, 3, 8, dtype=torch.float64, requires_grad=True)
    assert torch.autograd.gradcheck(mlp, (xg,), eps=1e-6, atol=1e-4), "gradcheck"

    print("PASS")
`,
    },
  },
  debrief: `The block is \`x + f(x) + g(x + f(x))\`: an identity path with two additive corrections, which is why gradients reach layer 1 of a 48-layer GPT-2 XL at all. Three choices are GPT-2's own. **Pre-LN** (normalise the sublayer's *input*, add to the raw stream) rather than the original Transformer's post-LN (\`ln(x + f(x))\`): with post-LN the stream is re-standardised after every block and, at init, the gradients of the layers near the output are large, so training needs a warm-up; with pre-LN the stream is never rescaled, each block adds a small correction, and the gradient norm is roughly equal across blocks from step 0 (Xiong et al. 2020). **The tanh GELU** is the faster approximation from the GELU paper, the formula GPT-2's TensorFlow code shipped, and every GPT-2 checkpoint is trained on it; exact \`F.gelu\` differs from it by at most \`4.7e-4\` (near \`|x| ≈ 2.7\`), small enough that nanoGPT loads the OpenAI weights under exact \`nn.GELU()\`, but enough that the outputs no longer match the checkpoint's own. **The init** is \`N(0, 0.02)\` everywhere except the two projections that write into the residual stream, which are scaled by \`1/√(2·n_layer)\`: the stream receives \`2·n_layer\` such writes, and without the scaling the variance they add grows linearly with depth, so after 48 layers the stream is about \`√48\` wider than after one, before any training. Zeroing \`c_proj\` is the limit of this idea (the block starts as the exact identity, which the self-test uses), and some later recipes do exactly that. What frameworks add: \`torch.compile\` fuses each LayerNorm into one kernel and the bias and GELU into one pass after the \`c_fc\` GEMM (into the GEMM's epilogue under \`mode="max-autotune"\`); FlashAttention-2 replaces the \`(T, T)\` score tensor in the attention; Megatron splits \`c_fc\` by columns and \`c_proj\` by rows across GPUs so the 4× hidden layer never materialises whole on one device, with one all-reduce per MLP; Hugging Face's \`GPT2Block\` keeps these exact names (\`ln_1\`, \`attn.c_attn\`, \`attn.c_proj\`, \`ln_2\`, \`mlp.c_fc\`, \`mlp.c_proj\`) but stores the linears as \`Conv1D\` with transposed weights, which is why loading the OpenAI checkpoint into this file needs a \`.t()\` per matrix.`,
};
