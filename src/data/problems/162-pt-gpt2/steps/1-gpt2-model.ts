import type {Step} from '@/lib/types';

export const gpt2ModelStep: Step = {
  id: 'gpt2-model',
  title: 'The model: embeddings, blocks, tied head, loss',
  concept: 'pytorch',
  file: 'gpt2_model',
  focus: ['tokens', 'embed', 'blocks', 'head'],
  task: `## Task

Write GPT-2 as nanoGPT does: a config, three small modules and the model, every tensor in the
shapes the paper fixes. No \`nn.MultiheadAttention\`, \`nn.TransformerEncoderLayer\` or
\`F.scaled_dot_product_attention\` — the attention is the point.

- \`GPTConfig\`: a \`@dataclass\` with \`vocab_size=50257\`, \`block_size=1024\`, \`n_layer=12\`,
  \`n_head=12\`, \`n_embd=768\`, \`dropout=0.0\`, \`bias=True\`.
- \`CausalSelfAttention(config)\`: one \`c_attn = nn.Linear(n_embd, 3 * n_embd)\` whose output is
  \`split\` into q, k, v, each reshaped to \`(B, n_head, T, hd)\`; scores \`q @ kᵀ / sqrt(hd)\`; a
  \`torch.tril\` mask registered as a non-persistent buffer and applied with \`masked_fill(…, -inf)\`
  **before** the softmax; \`c_proj\` back to \`n_embd\`; dropout on the attention weights and on the
  output. Input and output are \`(B, T, n_embd)\`.
- \`MLP(config)\`: \`c_fc\` to \`4 * n_embd\`, \`nn.GELU()\`, \`c_proj\` back, dropout.
- \`Block(config)\`: pre-norm residuals — \`x = x + attn(ln_1(x))\`, \`x = x + mlp(ln_2(x))\` with
  \`nn.LayerNorm(n_embd, bias=config.bias)\` (PyTorch ≥ 2.1).
- \`GPT(config)\`: \`transformer = nn.ModuleDict(wte, wpe, drop, h, ln_f)\` — \`wte\` is
  \`nn.Embedding(vocab_size, n_embd)\`, \`wpe\` is \`nn.Embedding(block_size, n_embd)\`, \`h\` the
  \`n_layer\` blocks — and \`lm_head = nn.Linear(n_embd, vocab_size, bias=False)\` **tied** to the
  token table: \`self.lm_head.weight = self.transformer.wte.weight\`, one tensor under two names.
- Init as GPT-2: every \`nn.Linear\` and \`nn.Embedding\` weight \`normal(0, 0.02)\`, biases zero, then
  every parameter named \`c_proj.weight\` re-drawn with \`std = 0.02 / sqrt(2 * n_layer)\`.
- \`forward(idx, targets=None) -> (logits, loss)\`: \`assert T <= block_size\`; \`wte(idx) + wpe(arange(T))\`;
  dropout; the blocks; \`ln_f\`; \`lm_head\` on **every** position → \`logits (B, T, vocab_size)\`;
  \`loss = F.cross_entropy(logits.view(-1, V), targets.view(-1), ignore_index=-1)\` when targets are
  given, else \`None\`.
- \`num_params(non_embedding=True)\`: every parameter once (the tied tensor counts once), minus
  \`wpe.weight.numel()\` when \`non_embedding\` — nanoGPT's "123.65M" for GPT-2 small (124.44M with it).

The self-test builds \`GPTConfig(64, 16, 2, 2, 8)\`, checks shapes, \`lm_head.weight is wte.weight\`,
the loss against a manual log-softmax to 1e-6 and \`F.cross_entropy\`, the count
\`V·d + n_layer·(12d² + 13d) + 2d\`, the residual-projection std, causality, the \`block_size\`
assertion and that every parameter receives a gradient, then prints \`PASS\`.

> One tensor, two jobs: the token table maps ids to vectors on the way in and vectors to logits on
> the way out — 38.6M of GPT-2 small's parameters saved, and the model's largest matrix trained from both ends.`,
  sequence: {
    participants: ['idx (B, T)', 'wte + wpe', 'Block × n_layer', 'ln_f · lm_head', 'loss'],
    messages: [
      {from: 'idx (B, T)', to: 'wte + wpe', label: 'wte[idx] + wpe[0..T)  → x (B, T, d)', kind: 'sync'},
      {from: 'wte + wpe', to: 'Block × n_layer', label: 'drop(x)', kind: 'sync'},
      {
        from: 'Block × n_layer',
        to: 'Block × n_layer',
        label: 'x += attn(ln_1(x)): qkv → mask → softmax → @ v → c_proj',
        kind: 'sync',
      },
      {from: 'Block × n_layer', to: 'Block × n_layer', label: 'x += mlp(ln_2(x)): c_fc → GELU → c_proj', kind: 'sync'},
      {from: 'Block × n_layer', to: 'ln_f · lm_head', label: 'x (B, T, d)', kind: 'sync'},
      {from: 'ln_f · lm_head', to: 'loss', label: 'logits (B, T, V) = ln_f(x) @ wteᵀ', kind: 'sync'},
      {from: 'loss', to: 'idx (B, T)', label: 'cross_entropy(logits, targets) — or None', kind: 'reply'},
    ],
  },
  hints: [
    'Build attention in the shape order `(B, T, 3C)` → split → `view(B, T, nh, hd)` → `transpose(1, 2)` → `(B, nh, T, hd)`; after `att @ v` reverse it: `transpose(1, 2).contiguous().view(B, T, C)`. Slice the mask buffer to `[:, :, :T, :T]`.',
    'Tie after both modules exist: create `lm_head`, then assign `self.lm_head.weight = self.transformer.wte.weight`. `self.apply(self._init_weights)` initialises the shared tensor twice, harmlessly; the `c_proj` rescale is a loop over `named_parameters()` after `apply`.',
    'The parameter count with biases: per block `ln_1 (2d) + c_attn (3d² + 3d) + c_proj (d² + d) + ln_2 (2d) + c_fc (4d² + 4d) + c_proj (4d² + d)`; the test subtracts `wpe` and nothing else because the tied head adds no tensor.',
  ],
  checks: [
    {
      id: 'config',
      title: 'GPTConfig carries GPT-2’s defaults',
      detail:
        'A `@dataclass GPTConfig` with `vocab_size: int = 50257` and `block_size: int = 1024` (the BPE vocabulary and the length of the learned position table) plus `n_layer`, `n_head`, `n_embd`, `dropout`, `bias`.',
      match: {
        python: {
          all: [/@dataclass\s*\nclass GPTConfig/, /vocab_size:\s*int\s*=\s*50257/, /block_size:\s*int\s*=\s*1024/],
        },
      },
    },
    {
      id: 'qkv',
      title: 'One fused qkv projection, split into heads',
      detail:
        '`c_attn = nn.Linear(n_embd, 3 * n_embd)` produces q, k, v in one matmul; `.split(n_embd, dim=2)` separates them and `.view(B, T, n_head, hd).transpose(1, 2)` puts heads in front of the sequence axis.',
      match: {
        python: {
          all: [
            /nn\.Linear\(\s*config\.n_embd\s*,\s*3\s*\*\s*config\.n_embd/,
            /\.split\(\s*self\.n_embd\s*,\s*dim\s*=\s*2\s*\)/,
            /\.transpose\(\s*1\s*,\s*2\s*\)/,
          ],
        },
      },
    },
    {
      id: 'causal-mask',
      title: 'Hand-written causal attention: tril mask, −inf, softmax',
      detail:
        'Scores are `q @ kᵀ` divided by `sqrt(hd)`; a `torch.tril` buffer masks future keys with `masked_fill(…, float("-inf"))` before `F.softmax(…, dim=-1)`. `F.scaled_dot_product_attention` and `nn.MultiheadAttention` are not allowed here.',
      match: {
        python: {
          all: [/torch\.tril\(/, /register_buffer\(/, /masked_fill\([^\n]*float\("-inf"\)/, /math\.sqrt\(/],
          order: [/masked_fill\(/, /F\.softmax\(/],
          none: [/scaled_dot_product_attention/, /nn\.MultiheadAttention/, /nn\.Transformer/],
        },
      },
    },
    {
      id: 'pre-norm-block',
      title: 'Pre-norm residual block with a GELU MLP',
      detail:
        'Each block is `x = x + self.attn(self.ln_1(x))` then `x = x + self.mlp(self.ln_2(x))` — LayerNorm on the branch, the residual stream untouched — with `nn.GELU()` between `c_fc` and `c_proj`.',
      match: {
        python: {
          all: [
            /x\s*=\s*x\s*\+\s*self\.attn\(\s*self\.ln_1\(\s*x\s*\)\s*\)/,
            /x\s*=\s*x\s*\+\s*self\.mlp\(\s*self\.ln_2\(\s*x\s*\)\s*\)/,
            /nn\.GELU\(\)/,
          ],
        },
      },
    },
    {
      id: 'tied-head',
      title: 'lm_head shares the token embedding tensor',
      detail:
        'After building both modules the head’s weight is assigned to the embedding’s (`self.lm_head.weight = self.transformer.wte.weight`): one `(vocab_size, n_embd)` tensor serves as input table and output projection.',
      match: {
        python: {
          all: [
            /nn\.Linear\(\s*config\.n_embd\s*,\s*config\.vocab_size\s*,\s*bias\s*=\s*False\s*\)/,
            /self\.(?:lm_head|transformer\.wte)\.weight\s*=\s*self\.(?:transformer\.wte|lm_head)\.weight/,
          ],
        },
      },
    },
    {
      id: 'gpt2-init',
      title: 'GPT-2 init with residual scaling',
      detail:
        'Linear and Embedding weights are `normal_(…, std=0.02)` and biases zero; every `c_proj.weight` is re-drawn with `std=0.02 / math.sqrt(2 * config.n_layer)` so the residual stream’s variance stays flat across depth.',
      match: {
        python: {
          all: [
            /self\.apply\(\s*self\._init_weights\s*\)/,
            /std\s*=\s*0\.02\s*\)/,
            /endswith\(\s*"c_proj\.weight"\s*\)/,
            /0\.02\s*\/\s*math\.sqrt\(\s*2\s*\*\s*config\.n_layer\s*\)/,
          ],
        },
      },
    },
    {
      id: 'forward-loss',
      title: 'forward adds positions, guards block_size, returns (logits, loss)',
      detail:
        '`assert T <= self.config.block_size`; `wte(idx) + wpe(torch.arange(…))`; `lm_head` on every position; `F.cross_entropy(logits.view(-1, V), targets.view(-1), ignore_index=-1)` only when targets are given, otherwise `loss = None`.',
      match: {
        python: {
          all: [
            /assert\s+T\s*<=\s*self\.config\.block_size/,
            /torch\.arange\(/,
            /self\.transformer\.wpe\(/,
            /F\.cross_entropy\([^\n]*ignore_index\s*=\s*-1/,
            /return logits, loss/,
          ],
        },
      },
    },
    {
      id: 'num-params',
      title: 'num_params excludes the position table only',
      detail:
        'The count sums every parameter once (the tied weight is one tensor) and subtracts `self.transformer.wpe.weight.numel()` when `non_embedding` — the 123.65M figure nanoGPT prints for GPT-2 small (124.44M with the position table).',
      match: {
        python: {
          all: [
            /def num_params\(\s*self\s*,\s*non_embedding\s*(?::\s*bool\s*)?=\s*True\s*\)/,
            /sum\(\s*p\.numel\(\)\s+for\s+p\s+in\s+self\.parameters\(\)\s*\)/,
            /-=\s*self\.transformer\.wpe\.weight\.numel\(\)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""GPT-2 from the paper's shapes: config, causal self-attention, MLP, block, and the model with a tied head."""

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GPTConfig:
    vocab_size: int = 50257  # GPT-2's BPE vocabulary
    block_size: int = 1024  # context length: the size of the learned position table
    n_layer: int = 12
    n_head: int = 12
    n_embd: int = 768
    dropout: float = 0.0
    bias: bool = True  # GPT-2 has biases on every Linear and LayerNorm


class CausalSelfAttention(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        # TODO: c_attn (n_embd -> 3 * n_embd), c_proj, two dropouts, n_head / n_embd, and a
        # non-persistent tril mask buffer of shape (1, 1, block_size, block_size).
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: qkv -> (B, nh, T, hd); q @ k^T / sqrt(hd); mask -> -inf; softmax; @ v; merge heads; c_proj.
        raise NotImplementedError("TODO")


class MLP(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        raise NotImplementedError("TODO")  # c_fc (4x), GELU, c_proj, dropout

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO")


class Block(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        raise NotImplementedError("TODO")  # ln_1, attn, ln_2, mlp

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO")  # pre-norm residuals


class GPT(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.config = config
        # TODO: transformer = ModuleDict(wte, wpe, drop, h, ln_f); lm_head tied to wte.weight;
        # apply(_init_weights); re-draw every c_proj.weight with std 0.02 / sqrt(2 * n_layer).
        raise NotImplementedError("TODO")

    def _init_weights(self, module: nn.Module) -> None:
        raise NotImplementedError("TODO")  # Linear / Embedding: normal(0, 0.02), biases zero

    def num_params(self, non_embedding: bool = True) -> int:
        """Parameter count; \`non_embedding\` drops the position table (the token table stays: it is the tied head)."""
        raise NotImplementedError("TODO")

    def forward(self, idx: torch.Tensor, targets: torch.Tensor | None = None):
        # TODO: assert T <= block_size; wte + wpe; drop; blocks; ln_f; lm_head; cross-entropy if targets.
        raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    V, L, n_layer, n_head, d = 64, 16, 2, 2, 8
    config = GPTConfig(vocab_size=V, block_size=L, n_layer=n_layer, n_head=n_head, n_embd=d, dropout=0.0)
    model = GPT(config)
    model.eval()

    # Shapes: full logits for every position; no loss without targets.
    idx = torch.randint(V, (3, 10))
    logits, loss = model(idx)
    assert logits.shape == (3, 10, V), logits.shape
    assert loss is None

    # Tied weights: one tensor, two names, counted once.
    assert model.lm_head.weight is model.transformer.wte.weight
    assert sum(1 for _ in model.parameters()) == len(dict(model.named_parameters()))

    # The loss is the mean token-level cross-entropy, the same number as the manual log-softmax.
    targets = torch.randint(V, (3, 10))
    logits, loss = model(idx, targets)
    logp = F.log_softmax(logits, dim=-1)
    manual = -logp.gather(-1, targets.unsqueeze(-1)).mean()
    assert torch.allclose(loss, manual, atol=1e-6), (loss.item(), manual.item())
    assert torch.allclose(loss, F.cross_entropy(logits.reshape(-1, V), targets.reshape(-1)), atol=1e-6)
    assert abs(loss.item() - math.log(V)) < 0.5, "a freshly initialised model should be near uniform"

    # Parameter count as nanoGPT reports it: everything but the position table, with biases.
    per_block = 12 * d * d + 13 * d
    expected = V * d + n_layer * per_block + 2 * d
    assert model.num_params() == expected, (model.num_params(), expected)
    assert model.num_params(non_embedding=False) == expected + L * d

    # Residual-stream projections carry the 1/sqrt(2 * n_layer) scaling; ordinary ones do not.
    big = GPT(GPTConfig(vocab_size=V, block_size=L, n_layer=8, n_head=4, n_embd=256))
    std_proj = big.transformer.h[0].attn.c_proj.weight.std().item()
    std_fc = big.transformer.h[0].mlp.c_fc.weight.std().item()
    assert abs(std_fc - 0.02) < 0.002, std_fc
    assert abs(std_proj - 0.02 / math.sqrt(16)) < 0.001, std_proj

    # Causality: a change in the last token must not move any earlier logit.
    idx2 = idx.clone()
    idx2[:, -1] = (idx2[:, -1] + 1) % V
    logits2, _ = model(idx2)
    assert torch.allclose(logits[:, :-1], logits2[:, :-1], atol=1e-6)
    assert not torch.allclose(logits[:, -1], logits2[:, -1])

    # Longer than block_size is a programming error, not a silent truncation.
    try:
        model(torch.zeros(1, L + 1, dtype=torch.long))
        raise SystemExit("expected an AssertionError for T > block_size")
    except AssertionError:
        pass

    # Gradients reach every parameter through the loss.
    model.train()
    _, loss = model(idx, targets)
    loss.backward()
    assert all(p.grad is not None for p in model.parameters())
    print("PASS")
`,
      solution: `"""GPT-2 from the paper's shapes: config, causal self-attention, MLP, block, and the model with a tied head."""

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GPTConfig:
    vocab_size: int = 50257  # GPT-2's BPE vocabulary
    block_size: int = 1024  # context length: the size of the learned position table
    n_layer: int = 12
    n_head: int = 12
    n_embd: int = 768
    dropout: float = 0.0
    bias: bool = True  # GPT-2 has biases on every Linear and LayerNorm


class CausalSelfAttention(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        assert config.n_embd % config.n_head == 0
        self.c_attn = nn.Linear(config.n_embd, 3 * config.n_embd, bias=config.bias)
        self.c_proj = nn.Linear(config.n_embd, config.n_embd, bias=config.bias)
        self.attn_dropout = nn.Dropout(config.dropout)
        self.resid_dropout = nn.Dropout(config.dropout)
        self.n_head = config.n_head
        self.n_embd = config.n_embd
        mask = torch.tril(torch.ones(config.block_size, config.block_size, dtype=torch.bool))
        self.register_buffer("mask", mask.view(1, 1, config.block_size, config.block_size), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        hd = C // self.n_head
        q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
        q = q.view(B, T, self.n_head, hd).transpose(1, 2)  # (B, nh, T, hd)
        k = k.view(B, T, self.n_head, hd).transpose(1, 2)
        v = v.view(B, T, self.n_head, hd).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(hd)  # (B, nh, T, T)
        att = att.masked_fill(~self.mask[:, :, :T, :T], float("-inf"))
        att = F.softmax(att, dim=-1)
        att = self.attn_dropout(att)
        y = att @ v  # (B, nh, T, hd)
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        return self.resid_dropout(self.c_proj(y))


class MLP(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.c_fc = nn.Linear(config.n_embd, 4 * config.n_embd, bias=config.bias)
        self.gelu = nn.GELU()
        self.c_proj = nn.Linear(4 * config.n_embd, config.n_embd, bias=config.bias)
        self.dropout = nn.Dropout(config.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.dropout(self.c_proj(self.gelu(self.c_fc(x))))


class Block(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.ln_1 = nn.LayerNorm(config.n_embd, bias=config.bias)
        self.attn = CausalSelfAttention(config)
        self.ln_2 = nn.LayerNorm(config.n_embd, bias=config.bias)
        self.mlp = MLP(config)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln_1(x))
        x = x + self.mlp(self.ln_2(x))
        return x


class GPT(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.config = config
        self.transformer = nn.ModuleDict(
            dict(
                wte=nn.Embedding(config.vocab_size, config.n_embd),
                wpe=nn.Embedding(config.block_size, config.n_embd),
                drop=nn.Dropout(config.dropout),
                h=nn.ModuleList([Block(config) for _ in range(config.n_layer)]),
                ln_f=nn.LayerNorm(config.n_embd, bias=config.bias),
            )
        )
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        # Weight tying: the output projection *is* the token embedding table (one tensor, two names).
        self.lm_head.weight = self.transformer.wte.weight
        self.apply(self._init_weights)
        # GPT-2's residual scaling: every projection that writes into the residual stream is
        # shrunk by 1/sqrt(2 * n_layer) so the stream's variance does not grow with depth.
        for name, p in self.named_parameters():
            if name.endswith("c_proj.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * config.n_layer))

    def _init_weights(self, module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def num_params(self, non_embedding: bool = True) -> int:
        """Parameter count; \`non_embedding\` drops the position table (the token table stays: it is the tied head)."""
        n = sum(p.numel() for p in self.parameters())
        if non_embedding:
            n -= self.transformer.wpe.weight.numel()
        return n

    def forward(self, idx: torch.Tensor, targets: torch.Tensor | None = None):
        B, T = idx.shape
        assert T <= self.config.block_size, f"sequence of length {T} exceeds block_size {self.config.block_size}"
        pos = torch.arange(0, T, dtype=torch.long, device=idx.device)
        tok_emb = self.transformer.wte(idx)  # (B, T, n_embd)
        pos_emb = self.transformer.wpe(pos)  # (T, n_embd), broadcast over the batch
        x = self.transformer.drop(tok_emb + pos_emb)
        for block in self.transformer.h:
            x = block(x)
        x = self.transformer.ln_f(x)
        logits = self.lm_head(x)  # (B, T, vocab_size)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1), ignore_index=-1)
        return logits, loss


if __name__ == "__main__":
    torch.manual_seed(0)
    V, L, n_layer, n_head, d = 64, 16, 2, 2, 8
    config = GPTConfig(vocab_size=V, block_size=L, n_layer=n_layer, n_head=n_head, n_embd=d, dropout=0.0)
    model = GPT(config)
    model.eval()

    # Shapes: full logits for every position; no loss without targets.
    idx = torch.randint(V, (3, 10))
    logits, loss = model(idx)
    assert logits.shape == (3, 10, V), logits.shape
    assert loss is None

    # Tied weights: one tensor, two names, counted once.
    assert model.lm_head.weight is model.transformer.wte.weight
    assert sum(1 for _ in model.parameters()) == len(dict(model.named_parameters()))

    # The loss is the mean token-level cross-entropy, the same number as the manual log-softmax.
    targets = torch.randint(V, (3, 10))
    logits, loss = model(idx, targets)
    logp = F.log_softmax(logits, dim=-1)
    manual = -logp.gather(-1, targets.unsqueeze(-1)).mean()
    assert torch.allclose(loss, manual, atol=1e-6), (loss.item(), manual.item())
    assert torch.allclose(loss, F.cross_entropy(logits.reshape(-1, V), targets.reshape(-1)), atol=1e-6)
    assert abs(loss.item() - math.log(V)) < 0.5, "a freshly initialised model should be near uniform"

    # Parameter count as nanoGPT reports it: everything but the position table, with biases.
    per_block = 12 * d * d + 13 * d
    expected = V * d + n_layer * per_block + 2 * d
    assert model.num_params() == expected, (model.num_params(), expected)
    assert model.num_params(non_embedding=False) == expected + L * d

    # Residual-stream projections carry the 1/sqrt(2 * n_layer) scaling; ordinary ones do not.
    big = GPT(GPTConfig(vocab_size=V, block_size=L, n_layer=8, n_head=4, n_embd=256))
    std_proj = big.transformer.h[0].attn.c_proj.weight.std().item()
    std_fc = big.transformer.h[0].mlp.c_fc.weight.std().item()
    assert abs(std_fc - 0.02) < 0.002, std_fc
    assert abs(std_proj - 0.02 / math.sqrt(16)) < 0.001, std_proj

    # Causality: a change in the last token must not move any earlier logit.
    idx2 = idx.clone()
    idx2[:, -1] = (idx2[:, -1] + 1) % V
    logits2, _ = model(idx2)
    assert torch.allclose(logits[:, :-1], logits2[:, :-1], atol=1e-6)
    assert not torch.allclose(logits[:, -1], logits2[:, -1])

    # Longer than block_size is a programming error, not a silent truncation.
    try:
        model(torch.zeros(1, L + 1, dtype=torch.long))
        raise SystemExit("expected an AssertionError for T > block_size")
    except AssertionError:
        pass

    # Gradients reach every parameter through the loss.
    model.train()
    _, loss = model(idx, targets)
    loss.backward()
    assert all(p.grad is not None for p in model.parameters())
    print("PASS")
`,
    },
  },
  debrief: `The file is nanoGPT's \`model.py\` with nothing hidden. Three choices carry the model. **Fused qkv**: one \`(C, 3C)\` matmul instead of three — the same FLOPs, a third of the kernel launches and one contiguous read of \`x\`; the \`view/transpose\` dance that follows is free (a view) until \`.contiguous()\` after \`att @ v\`, which is the one copy. **Pre-norm**: LayerNorm sits on the branch, so the residual stream is an unnormalised sum of every block's output and gradients flow through the identity path untouched — GPT-2 moved LayerNorm here from the post-norm original Transformer, and that is what keeps the 48-layer GPT-2 XL trainable. The \`1/sqrt(2 · n_layer)\` rescale of the \`c_proj\` weights is the complement: \`2 · n_layer\` branches add into the stream, and shrinking each keeps its variance of order one at the last layer. **Tying**: \`lm_head.weight = wte.weight\` is a Python assignment of the same \`nn.Parameter\`, so the optimizer sees it once and both gradients accumulate into it; \`num_params\` subtracts only \`wpe\` for the same reason. What frameworks add: \`F.scaled_dot_product_attention\` dispatches to FlashAttention-2 so the \`(B, nh, T, T)\` score matrix never materialises (at \`T = 1024\`, \`nh = 12\` that is 24 MiB per sequence in bf16, read and written three times here); \`torch.compile\` fuses the GELU, the residual adds and the LayerNorms into a handful of kernels; and \`F.cross_entropy\` on \`(B·T, 50257)\` logits is replaced by a fused, chunked kernel so the logits tensor — the largest activation in the model — is never stored in full.`,
};
