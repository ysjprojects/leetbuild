import type {Step} from '@/lib/types';

export const tpBlockStep: Step = {
  id: 'tp-block',
  title: 'A parallel block: MLP, attention by heads, LayerNorms replicated',
  concept: 'pytorch',
  file: 'tp_block',
  focus: [
    'ln1',
    'qkv-r0',
    'qkv-r1',
    'heads-r0',
    'heads-r1',
    'o-r0',
    'o-r1',
    'add1',
    'ln2',
    'gelu-r0',
    'gelu-r1',
    'add2',
  ],
  task: `## Task

Build Megatron's transformer block from the step-1 layers. The file holds dense references (\`DenseMLP\`,
\`DenseAttention\`, \`DenseBlock\`, given) whose parameter names your parallel modules reuse, so their
gradients can be compared shard by shard. \`DenseAttention.qkv\` is one \`nn.Linear(d, 3d)\` whose output
rows are \`[q of heads 0 … n−1; k of heads 0 … n−1; v of heads 0 … n−1]\`, as GPT-2 stores it.

- **\`ParallelMLP(d_model, d_ff)\`**: \`self.fc = ColumnParallelLinear(d_model, d_ff, gather_output=False)\`,
  \`self.proj = RowParallelLinear(d_ff, d_model, input_is_parallel=True)\`, forward
  \`self.proj(F.gelu(self.fc(x)))\`. GELU runs on the local \`(B, T, d_ff / p)\` slice: no gather between
  the two layers, one all-reduce forward (g) and one backward (f).
- **\`ParallelAttention(d_model, n_heads, block_size)\`**: assert \`n_heads % p == 0\`;
  \`self.head_dim = d_model // n_heads\`, \`self.local_heads = n_heads // p\`,
  \`self.local_dim = self.local_heads * self.head_dim\`; \`self.qkv\` a \`ColumnParallelLinear(d_model,
  3 * d_model)\` whose local output is \`[q_r; k_r; v_r]\`, each \`local_dim\` wide; \`self.proj\` a
  \`RowParallelLinear(d_model, d_model)\`. Forward: \`self.qkv(x).split(self.local_dim, dim=-1)\`, each
  \`.view(B, T, self.local_heads, self.head_dim).transpose(1, 2)\`, scores \`q @ kᵀ / sqrt(head_dim)\`,
  the \`tril\` mask with \`masked_fill(…, -inf)\` before the softmax, \`att @ v\`, merge to
  \`(B, T, self.local_dim)\`, \`self.proj\`. Every head lives on exactly one rank, so attention needs no
  communication.
- **\`ParallelAttention.from_dense\`**: rank \`r\` owns heads \`r · n/p … (r+1) · n/p − 1\`, which are rows
  \`r · local_dim … (r+1) · local_dim − 1\` of **each** of q, k and v. Split the dense weight and bias into
  q, k, v (\`split(d_model, dim=0)\`), slice each, and \`torch.cat\` the three slices. A plain
  \`ColumnParallelLinear.from_dense(dense.qkv)\` would hand rank 0 all of q and half of k.
- **\`ParallelBlock(d_model, n_heads, d_ff, block_size)\`**: \`ln1\`, \`attn\`, \`ln2\`, \`mlp\`;
  \`x = x + self.attn(self.ln1(x))\`, \`x = x + self.mlp(self.ln2(x))\`. Both \`nn.LayerNorm\`s are
  replicated: every rank holds the whole stream, so each computes the same normalisation and receives
  the same gradient. \`from_dense\` copies them whole (\`load_state_dict\`).
- **\`CollectiveCounter\`**: a context manager; on \`__enter__\` it replaces \`dist.all_reduce\` and
  \`dist.all_gather\` (\`setattr(dist, name, wrapper)\`) with wrappers that append \`(name, payload bytes)\`
  to \`self.calls\` and call the original; \`__exit__\` puts the originals back. \`count(name)\` and
  \`bytes()\` are given.
- \`F.scaled_dot_product_attention\` and \`nn.MultiheadAttention\` are not allowed.

:::widget tensor-parallel {"layer": "attention", "ranks": 4}

The self-test builds \`DenseBlock(16, 4, 64, block_size=6)\` with seed 0 (LayerNorm weights perturbed so
they are not trivially 1 and 0), and on \`p = 2\` and \`p = 4\` runs the MLP, the attention and the whole
block forward and backward against a fixed output probe. It checks the outputs and input gradients on every
rank, every parameter gradient reassembled from the shards (q, k and v regrouped by head), the replicated
gradients equal across ranks, \`local_heads == 4 / p\`, and exactly one all-reduce of \`B · T · d · 4\` bytes
per sublayer forward and one backward (two each for the block) with no all-gather, to \`1e-5\`. Then it
prints \`PASS\`.

> Split the first matrix by columns and the second by rows, and everything between them (GELU, a whole
> attention head) is local. The only communication is the sum at the end, and its transpose on the way back.`,
  hints: [
    'Every module is two step-1 layers around a local computation. The MLP: `fc` with `gather_output=False`, `F.gelu`, `proj` with `input_is_parallel=True`. The attention: the dense module’s forward with `n_heads` replaced by `self.local_heads` and `C` by `self.local_dim`.',
    'Sharding qkv: `w_q, w_k, w_v = dense.qkv.weight.split(d_model, dim=0)`, `heads = slice(rank * local_dim, (rank + 1) * local_dim)`, then `attn.qkv.weight.copy_(torch.cat([w_q[heads], w_k[heads], w_v[heads]], dim=0))`; the same for the bias. `proj` is a plain `RowParallelLinear.from_dense`.',
    'The counter: in `__enter__`, save `{name: getattr(dist, name)}` and for each name `setattr(dist, name, wrapped)`, where `wrapped(*args, **kwargs)` appends `(name, t.numel() * t.element_size())` (the tensor is `args[0]` for `all_reduce`, `args[1]` for `all_gather`) and returns `original(*args, **kwargs)`. Bind `name` and `original` per wrapper (a factory function), or every wrapper calls the last one.',
  ],
  checks: [
    {
      id: 'mlp-column-gelu-row',
      title: 'ParallelMLP is column, GELU, row with nothing gathered',
      detail:
        '`ColumnParallelLinear(…, gather_output=False)`, then `RowParallelLinear(…, input_is_parallel=True)`, and `self.proj(F.gelu(self.fc(x)))`. Gathering between them would add an all-gather forward and turn the row layer’s input into a full copy.',
      match: {
        python: {
          all: [/self\.proj\(\s*F\.gelu\(\s*self\.fc\(\s*x\s*\)\s*\)\s*\)/],
          order: [
            /class ParallelMLP/,
            /ColumnParallelLinear\([^\n]*gather_output\s*=\s*False/,
            /RowParallelLinear\([^\n]*input_is_parallel\s*=\s*True/,
          ],
          none: [/gather_output\s*=\s*True/, /input_is_parallel\s*=\s*False/, /gather_from_tp\(/],
        },
      },
    },
    {
      id: 'local-heads',
      title: 'Each rank owns n_heads / p whole heads',
      detail:
        '`assert n_heads % p == 0` and `self.local_heads = n_heads // p`: a head is never split, so its softmax over keys needs nothing from another rank.',
      match: {
        python: {
          all: [
            /n_heads\s*%\s*\w+(?:\(\))?\s*==\s*0/,
            /self\.local_heads\s*=\s*n_heads\s*\/\/\s*\w+/,
            /self\.local_dim\s*=\s*self\.local_heads\s*\*\s*self\.head_dim/,
          ],
        },
      },
    },
    {
      id: 'local-causal-attention',
      title: 'Hand-written causal attention over the local heads',
      detail:
        'The local qkv output is split into `self.local_dim`-wide q, k, v, viewed as `(B, T, self.local_heads, self.head_dim)`, masked with the `tril` buffer before the softmax, and merged back to `(B, T, self.local_dim)` for the row-parallel projection. `F.scaled_dot_product_attention` and `nn.MultiheadAttention` are not allowed.',
      match: {
        python: {
          all: [
            /\.split\(\s*self\.local_dim\s*,\s*dim\s*=\s*-1\s*\)/,
            /\.view\(\s*B\s*,\s*T\s*,\s*self\.local_heads\s*,\s*self\.head_dim\s*\)/,
            /\.(?:reshape|view)\(\s*B\s*,\s*T\s*,\s*self\.local_dim\s*\)/,
          ],
          none: [/scaled_dot_product_attention/, /nn\.MultiheadAttention/],
        },
      },
    },
    {
      id: 'qkv-by-head',
      title: 'The fused qkv weight is sharded by head, within q, k and v',
      detail:
        'Rank `r` takes its heads’ rows from each of q, k and v and concatenates them (`torch.cat([w_q[heads], w_k[heads], w_v[heads]])`, or a `view(3, …)` of the weight). Chunking the fused `(3d, d)` weight directly gives rank 0 all of q and part of k.',
      match: {
        python: {
          all: [
            /torch\.cat\(\s*\[\s*\w+\[[^\]\n]+\]\s*,\s*\w+\[[^\]\n]+\]\s*,\s*\w+\[[^\]\n]+\]\s*\]|\.(?:view|reshape|unflatten)\(\s*(?:0\s*,\s*\(\s*)?3\s*,/,
          ],
          none: [/ColumnParallelLinear\.from_dense\(\s*dense\.qkv/],
        },
      },
    },
    {
      id: 'block-replicated-ln',
      title: 'Pre-LN block with replicated LayerNorms',
      detail:
        '`ParallelBlock` holds `nn.LayerNorm`s next to `ParallelAttention` and `ParallelMLP`, runs `x = x + self.attn(self.ln1(x))` and `x = x + self.mlp(self.ln2(x))`, and `from_dense` copies each LayerNorm whole.',
      match: {
        python: {
          all: [
            /x\s*=\s*x\s*\+\s*self\.attn\(\s*self\.ln1\(\s*x\s*\)\s*\)/,
            /ln1\.load_state_dict\(|ln1\.weight\.copy_\(/,
          ],
          order: [/class ParallelBlock/, /nn\.LayerNorm\(/, /ParallelAttention\(/, /ParallelMLP\(/],
        },
      },
    },
    {
      id: 'collective-counter',
      title: 'CollectiveCounter wraps the collectives and restores them',
      detail:
        '`__enter__` replaces `dist.all_reduce` and `dist.all_gather` with counting wrappers (`setattr(dist, …)` or an assignment) that still call the original; `__exit__` puts the originals back so nothing outside the `with` block is counted.',
      match: {
        python: {
          all: [
            /setattr\(\s*dist\s*,|dist\.all_reduce\s*=/,
            /def __exit__\([^)]*\)[^\n]*:\s*\n(?:[ \t]{8,}[^\n]*\n|[ \t]*\n)*?[ \t]{8,}[^\n]*(?:setattr\(\s*dist|dist\.\w+\s*=)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Megatron-LM tensor parallelism, part 2: the parallel MLP, parallel attention and a pre-LN block."""

import math

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from tp_linear import ColumnParallelLinear, RowParallelLinear, launch, tp_rank, tp_world

# ---- dense references (one process, nothing split) ---------------------------------------------


class DenseMLP(nn.Module):
    def __init__(self, d_model: int, d_ff: int):
        super().__init__()
        self.fc = nn.Linear(d_model, d_ff)
        self.proj = nn.Linear(d_ff, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(F.gelu(self.fc(x)))


class DenseAttention(nn.Module):
    """Causal self-attention; \`qkv\` rows are [q heads 0..n-1; k heads 0..n-1; v heads 0..n-1]."""

    def __init__(self, d_model: int, n_heads: int, block_size: int):
        super().__init__()
        self.n_heads, self.head_dim = n_heads, d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.proj = nn.Linear(d_model, d_model)
        self.register_buffer("mask", torch.tril(torch.ones(block_size, block_size, dtype=torch.bool)), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.qkv(x).split(C, dim=-1)
        q, k, v = (t.view(B, T, self.n_heads, self.head_dim).transpose(1, 2) for t in (q, k, v))
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        att = F.softmax(att.masked_fill(~self.mask[:T, :T], float("-inf")), dim=-1)
        return self.proj((att @ v).transpose(1, 2).reshape(B, T, C))


class DenseBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, d_ff: int, block_size: int):
        super().__init__()
        self.ln1 = nn.LayerNorm(d_model)
        self.attn = DenseAttention(d_model, n_heads, block_size)
        self.ln2 = nn.LayerNorm(d_model)
        self.mlp = DenseMLP(d_model, d_ff)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))


# ---- tensor-parallel modules -------------------------------------------------------------------


class ParallelMLP(nn.Module):
    """Column-parallel fc, GELU on the local shard, row-parallel proj: one all-reduce each way."""

    def __init__(self, d_model: int, d_ff: int):
        super().__init__()
        raise NotImplementedError("TODO: self.fc (column, no gather) and self.proj (row, parallel input)")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: proj of the GELU of fc")

    @classmethod
    def from_dense(cls, dense: DenseMLP) -> "ParallelMLP":
        raise NotImplementedError("TODO: shard dense.fc by output rows and dense.proj by input columns")


class ParallelAttention(nn.Module):
    """n_heads / p heads per rank: column-parallel qkv, local causal attention, row-parallel proj."""

    def __init__(self, d_model: int, n_heads: int, block_size: int):
        super().__init__()
        # TODO: assert divisibility; self.head_dim, self.local_heads, self.local_dim; self.qkv (column,
        # 3 * d_model outputs, no gather); self.proj (row, parallel input); the causal mask buffer.
        raise NotImplementedError("TODO: the local heads")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: local q, k, v; causal attention over the local heads; proj")

    @classmethod
    def from_dense(cls, dense: DenseAttention) -> "ParallelAttention":
        raise NotImplementedError("TODO: this rank's heads of q, of k and of v; proj by input columns")


class ParallelBlock(nn.Module):
    """Pre-LN block; both LayerNorms are replicated on every rank."""

    def __init__(self, d_model: int, n_heads: int, d_ff: int, block_size: int):
        super().__init__()
        raise NotImplementedError("TODO: ln1, attn, ln2, mlp")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: the two pre-LN residuals")

    @classmethod
    def from_dense(cls, dense: DenseBlock) -> "ParallelBlock":
        raise NotImplementedError("TODO: copy both LayerNorms whole, shard attn and mlp")


# ---- counting collectives ----------------------------------------------------------------------


class CollectiveCounter:
    """Counts every \`dist.all_reduce\` / \`dist.all_gather\` issued inside the \`with\` block, and its payload bytes."""

    NAMES = ("all_reduce", "all_gather")

    def __enter__(self) -> "CollectiveCounter":
        # TODO: self.calls = [] of (name, payload bytes); wrap each function of NAMES on the dist module
        # so a call records itself, then runs the original; keep the originals to put back.
        raise NotImplementedError("TODO: install the counting wrappers")

    def __exit__(self, *exc) -> None:
        raise NotImplementedError("TODO: restore the original functions")

    def count(self, name: str) -> int:
        return sum(1 for n, _ in self.calls if n == name)

    def bytes(self) -> int:
        return sum(b for _, b in self.calls)


# ---- self-test ---------------------------------------------------------------------------------

B, T, D, HEADS, D_FF = 2, 6, 16, 4, 64


def _dense_case():
    torch.manual_seed(0)
    block = DenseBlock(D, HEADS, D_FF, block_size=T)
    with torch.no_grad():
        for ln in (block.ln1, block.ln2):
            ln.weight.normal_(1.0, 0.1)
            ln.bias.normal_(0.0, 0.1)
    x = torch.randn(B, T, D)
    probe = torch.randn(B, T, D)
    return block, x, probe


def _worker(rank: int, world: int) -> dict:
    dense, x, probe = _dense_case()
    out = {}
    for name in ("mlp", "attn", "block"):
        if name == "mlp":
            module, inp = ParallelMLP.from_dense(dense.mlp), dense.ln2(x).detach()
        elif name == "attn":
            module, inp = ParallelAttention.from_dense(dense.attn), dense.ln1(x).detach()
        else:
            module, inp = ParallelBlock.from_dense(dense), x.clone()
        inp.requires_grad_()
        with CollectiveCounter() as fwd:
            y = module(inp)
        with CollectiveCounter() as bwd:
            (y * probe).sum().backward()
        grads = {n: p.grad for n, p in module.named_parameters()}
        out[name] = {
            "y": y.detach(),
            "x_grad": inp.grad,
            "grads": grads,
            "fwd": (fwd.count("all_reduce"), fwd.count("all_gather"), fwd.bytes()),
            "bwd": (bwd.count("all_reduce"), bwd.count("all_gather"), bwd.bytes()),
        }
    out["local_heads"] = ParallelAttention.from_dense(dense.attn).local_heads
    return out


def _check(name: str, got: torch.Tensor, want: torch.Tensor) -> None:
    assert got.shape == want.shape, f"{name}: shape {tuple(got.shape)} != {tuple(want.shape)}"
    assert torch.allclose(got, want, atol=1e-5, rtol=1e-4), f"{name}: max err {(got - want).abs().max():.2e}"


def _reference(module: nn.Module, inp: torch.Tensor, probe: torch.Tensor):
    inp = inp.detach().clone().requires_grad_()
    module.zero_grad()
    y = module(inp)
    (y * probe).sum().backward()
    return y.detach(), inp.grad, {n: p.grad.clone() for n, p in module.named_parameters()}


def _assemble(name: str, shards: list[torch.Tensor], local_dim: int) -> torch.Tensor:
    """The dense gradient rebuilt from the ranks' shards of parameter \`name\`."""
    if name.endswith(("qkv.weight", "qkv.bias")):
        # Each rank holds [q_r; k_r; v_r]: regroup into [q_0 q_1 ...; k_0 k_1 ...; v_0 v_1 ...].
        parts = [s.split(local_dim, dim=0) for s in shards]
        return torch.cat([torch.cat([p[i] for p in parts], dim=0) for i in range(3)], dim=0)
    if name.endswith(("fc.weight", "fc.bias")):
        return torch.cat(shards, dim=0)
    if name.endswith("proj.weight"):
        return torch.cat(shards, dim=1)
    for s in shards[1:]:
        _check(f"replicated {name} grad agrees across ranks", s, shards[0])
    return shards[0]


if __name__ == "__main__":
    dense, x, probe = _dense_case()
    refs = {
        "mlp": _reference(dense.mlp, dense.ln2(x), probe),
        "attn": _reference(dense.attn, dense.ln1(x), probe),
        "block": _reference(dense, x, probe),
    }
    activation = B * T * D * 4
    for world in (2, 4):
        ranks = launch(_worker, world)
        assert ranks[0]["local_heads"] == HEADS // world
        for name, (y_ref, xg_ref, g_ref) in refs.items():
            for r in ranks:
                _check(f"p={world} {name} output", r[name]["y"], y_ref)
                _check(f"p={world} {name} input grad", r[name]["x_grad"], xg_ref)
            for pname, want in g_ref.items():
                shards = [r[name]["grads"][pname] for r in ranks]
                _check(f"p={world} {name} {pname} grad", _assemble(pname, shards, D // world), want)
            n = 2 if name == "block" else 1
            fwd, bwd = ranks[0][name]["fwd"], ranks[0][name]["bwd"]
            assert fwd == (n, 0, n * activation), f"p={world} {name} forward collectives {fwd}, want {n} all-reduce"
            assert bwd == (n, 0, n * activation), f"p={world} {name} backward collectives {bwd}, want {n} all-reduce"
        print(f"p={world}: MLP, attention and block match dense; 1 + 1 all-reduces per sublayer of {activation} B")
    print("PASS")
`,
      solution: `"""Megatron-LM tensor parallelism, part 2: the parallel MLP, parallel attention and a pre-LN block."""

import math

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from tp_linear import ColumnParallelLinear, RowParallelLinear, launch, tp_rank, tp_world

# ---- dense references (one process, nothing split) ---------------------------------------------


class DenseMLP(nn.Module):
    def __init__(self, d_model: int, d_ff: int):
        super().__init__()
        self.fc = nn.Linear(d_model, d_ff)
        self.proj = nn.Linear(d_ff, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(F.gelu(self.fc(x)))


class DenseAttention(nn.Module):
    """Causal self-attention; \`qkv\` rows are [q heads 0..n-1; k heads 0..n-1; v heads 0..n-1]."""

    def __init__(self, d_model: int, n_heads: int, block_size: int):
        super().__init__()
        self.n_heads, self.head_dim = n_heads, d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.proj = nn.Linear(d_model, d_model)
        self.register_buffer("mask", torch.tril(torch.ones(block_size, block_size, dtype=torch.bool)), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.qkv(x).split(C, dim=-1)
        q, k, v = (t.view(B, T, self.n_heads, self.head_dim).transpose(1, 2) for t in (q, k, v))
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        att = F.softmax(att.masked_fill(~self.mask[:T, :T], float("-inf")), dim=-1)
        return self.proj((att @ v).transpose(1, 2).reshape(B, T, C))


class DenseBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, d_ff: int, block_size: int):
        super().__init__()
        self.ln1 = nn.LayerNorm(d_model)
        self.attn = DenseAttention(d_model, n_heads, block_size)
        self.ln2 = nn.LayerNorm(d_model)
        self.mlp = DenseMLP(d_model, d_ff)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))


# ---- tensor-parallel modules -------------------------------------------------------------------


class ParallelMLP(nn.Module):
    """Column-parallel fc, GELU on the local shard, row-parallel proj: one all-reduce each way."""

    def __init__(self, d_model: int, d_ff: int):
        super().__init__()
        self.fc = ColumnParallelLinear(d_model, d_ff, gather_output=False)
        self.proj = RowParallelLinear(d_ff, d_model, input_is_parallel=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(F.gelu(self.fc(x)))

    @classmethod
    def from_dense(cls, dense: DenseMLP) -> "ParallelMLP":
        mlp = cls(dense.fc.in_features, dense.fc.out_features)
        mlp.fc = ColumnParallelLinear.from_dense(dense.fc, gather_output=False)
        mlp.proj = RowParallelLinear.from_dense(dense.proj, input_is_parallel=True)
        return mlp


class ParallelAttention(nn.Module):
    """n_heads / p heads per rank: column-parallel qkv, local causal attention, row-parallel proj."""

    def __init__(self, d_model: int, n_heads: int, block_size: int):
        super().__init__()
        world = tp_world()
        assert n_heads % world == 0, f"n_heads={n_heads} is not divisible by {world} ranks"
        self.head_dim = d_model // n_heads
        self.local_heads = n_heads // world
        self.local_dim = self.local_heads * self.head_dim
        self.qkv = ColumnParallelLinear(d_model, 3 * d_model, gather_output=False)
        self.proj = RowParallelLinear(d_model, d_model, input_is_parallel=True)
        self.register_buffer("mask", torch.tril(torch.ones(block_size, block_size, dtype=torch.bool)), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, _ = x.shape
        q, k, v = self.qkv(x).split(self.local_dim, dim=-1)
        q, k, v = (t.view(B, T, self.local_heads, self.head_dim).transpose(1, 2) for t in (q, k, v))
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        att = F.softmax(att.masked_fill(~self.mask[:T, :T], float("-inf")), dim=-1)
        y = (att @ v).transpose(1, 2).reshape(B, T, self.local_dim)
        return self.proj(y)

    @classmethod
    def from_dense(cls, dense: DenseAttention) -> "ParallelAttention":
        d_model = dense.proj.in_features
        attn = cls(d_model, dense.n_heads, dense.mask.shape[0])
        rank, world = tp_rank(), tp_world()
        heads = slice(rank * attn.local_dim, (rank + 1) * attn.local_dim)
        with torch.no_grad():
            # Shard by head: this rank's q rows, then its k rows, then its v rows.
            w_q, w_k, w_v = dense.qkv.weight.split(d_model, dim=0)
            b_q, b_k, b_v = dense.qkv.bias.split(d_model, dim=0)
            attn.qkv.weight.copy_(torch.cat([w_q[heads], w_k[heads], w_v[heads]], dim=0))
            attn.qkv.bias.copy_(torch.cat([b_q[heads], b_k[heads], b_v[heads]], dim=0))
        attn.proj = RowParallelLinear.from_dense(dense.proj, input_is_parallel=True)
        return attn


class ParallelBlock(nn.Module):
    """Pre-LN block; both LayerNorms are replicated on every rank."""

    def __init__(self, d_model: int, n_heads: int, d_ff: int, block_size: int):
        super().__init__()
        self.ln1 = nn.LayerNorm(d_model)
        self.attn = ParallelAttention(d_model, n_heads, block_size)
        self.ln2 = nn.LayerNorm(d_model)
        self.mlp = ParallelMLP(d_model, d_ff)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))

    @classmethod
    def from_dense(cls, dense: DenseBlock) -> "ParallelBlock":
        d_model, d_ff = dense.mlp.fc.in_features, dense.mlp.fc.out_features
        block = cls(d_model, dense.attn.n_heads, d_ff, dense.attn.mask.shape[0])
        block.ln1.load_state_dict(dense.ln1.state_dict())
        block.ln2.load_state_dict(dense.ln2.state_dict())
        block.attn = ParallelAttention.from_dense(dense.attn)
        block.mlp = ParallelMLP.from_dense(dense.mlp)
        return block


# ---- counting collectives ----------------------------------------------------------------------


class CollectiveCounter:
    """Counts every \`dist.all_reduce\` / \`dist.all_gather\` issued inside the \`with\` block, and its payload bytes."""

    NAMES = ("all_reduce", "all_gather")

    def __enter__(self) -> "CollectiveCounter":
        self.calls: list[tuple[str, int]] = []
        self._saved = {name: getattr(dist, name) for name in self.NAMES}

        def wrap(name, original):
            def counted(*args, **kwargs):
                tensor = args[0] if name == "all_reduce" else args[1]
                self.calls.append((name, tensor.numel() * tensor.element_size()))
                return original(*args, **kwargs)

            return counted

        for name, original in self._saved.items():
            setattr(dist, name, wrap(name, original))
        return self

    def __exit__(self, *exc) -> None:
        for name, original in self._saved.items():
            setattr(dist, name, original)

    def count(self, name: str) -> int:
        return sum(1 for n, _ in self.calls if n == name)

    def bytes(self) -> int:
        return sum(b for _, b in self.calls)


# ---- self-test ---------------------------------------------------------------------------------

B, T, D, HEADS, D_FF = 2, 6, 16, 4, 64


def _dense_case():
    torch.manual_seed(0)
    block = DenseBlock(D, HEADS, D_FF, block_size=T)
    with torch.no_grad():
        for ln in (block.ln1, block.ln2):
            ln.weight.normal_(1.0, 0.1)
            ln.bias.normal_(0.0, 0.1)
    x = torch.randn(B, T, D)
    probe = torch.randn(B, T, D)
    return block, x, probe


def _worker(rank: int, world: int) -> dict:
    dense, x, probe = _dense_case()
    out = {}
    for name in ("mlp", "attn", "block"):
        if name == "mlp":
            module, inp = ParallelMLP.from_dense(dense.mlp), dense.ln2(x).detach()
        elif name == "attn":
            module, inp = ParallelAttention.from_dense(dense.attn), dense.ln1(x).detach()
        else:
            module, inp = ParallelBlock.from_dense(dense), x.clone()
        inp.requires_grad_()
        with CollectiveCounter() as fwd:
            y = module(inp)
        with CollectiveCounter() as bwd:
            (y * probe).sum().backward()
        grads = {n: p.grad for n, p in module.named_parameters()}
        out[name] = {
            "y": y.detach(),
            "x_grad": inp.grad,
            "grads": grads,
            "fwd": (fwd.count("all_reduce"), fwd.count("all_gather"), fwd.bytes()),
            "bwd": (bwd.count("all_reduce"), bwd.count("all_gather"), bwd.bytes()),
        }
    out["local_heads"] = ParallelAttention.from_dense(dense.attn).local_heads
    return out


def _check(name: str, got: torch.Tensor, want: torch.Tensor) -> None:
    assert got.shape == want.shape, f"{name}: shape {tuple(got.shape)} != {tuple(want.shape)}"
    assert torch.allclose(got, want, atol=1e-5, rtol=1e-4), f"{name}: max err {(got - want).abs().max():.2e}"


def _reference(module: nn.Module, inp: torch.Tensor, probe: torch.Tensor):
    inp = inp.detach().clone().requires_grad_()
    module.zero_grad()
    y = module(inp)
    (y * probe).sum().backward()
    return y.detach(), inp.grad, {n: p.grad.clone() for n, p in module.named_parameters()}


def _assemble(name: str, shards: list[torch.Tensor], local_dim: int) -> torch.Tensor:
    """The dense gradient rebuilt from the ranks' shards of parameter \`name\`."""
    if name.endswith(("qkv.weight", "qkv.bias")):
        # Each rank holds [q_r; k_r; v_r]: regroup into [q_0 q_1 ...; k_0 k_1 ...; v_0 v_1 ...].
        parts = [s.split(local_dim, dim=0) for s in shards]
        return torch.cat([torch.cat([p[i] for p in parts], dim=0) for i in range(3)], dim=0)
    if name.endswith(("fc.weight", "fc.bias")):
        return torch.cat(shards, dim=0)
    if name.endswith("proj.weight"):
        return torch.cat(shards, dim=1)
    for s in shards[1:]:
        _check(f"replicated {name} grad agrees across ranks", s, shards[0])
    return shards[0]


if __name__ == "__main__":
    dense, x, probe = _dense_case()
    refs = {
        "mlp": _reference(dense.mlp, dense.ln2(x), probe),
        "attn": _reference(dense.attn, dense.ln1(x), probe),
        "block": _reference(dense, x, probe),
    }
    activation = B * T * D * 4
    for world in (2, 4):
        ranks = launch(_worker, world)
        assert ranks[0]["local_heads"] == HEADS // world
        for name, (y_ref, xg_ref, g_ref) in refs.items():
            for r in ranks:
                _check(f"p={world} {name} output", r[name]["y"], y_ref)
                _check(f"p={world} {name} input grad", r[name]["x_grad"], xg_ref)
            for pname, want in g_ref.items():
                shards = [r[name]["grads"][pname] for r in ranks]
                _check(f"p={world} {name} {pname} grad", _assemble(pname, shards, D // world), want)
            n = 2 if name == "block" else 1
            fwd, bwd = ranks[0][name]["fwd"], ranks[0][name]["bwd"]
            assert fwd == (n, 0, n * activation), f"p={world} {name} forward collectives {fwd}, want {n} all-reduce"
            assert bwd == (n, 0, n * activation), f"p={world} {name} backward collectives {bwd}, want {n} all-reduce"
        print(f"p={world}: MLP, attention and block match dense; 1 + 1 all-reduces per sublayer of {activation} B")
    print("PASS")
`,
    },
  },
  debrief: `Column then row is the one order that keeps the middle local. GELU is elementwise, so GELU of a column
slice is the column slice of GELU; attention is per head, so a rank that holds whole heads computes their
softmax alone. Swap the order and the first layer's output is a partial sum that must be all-reduced
before the nonlinearity, then the second layer's split output must be gathered: two collectives each way,
the first one 4d wide in the MLP. The LayerNorms stay replicated because the residual stream is
replicated; that costs \`p\` copies of the stream's activations and of the LayerNorm work, which is exactly
what sequence parallelism (Korthikanti et al., 2022) removes by splitting those regions along the sequence
and turning each all-reduce into a reduce-scatter and an all-gather of the same total volume. The qkv
regrouping is a checkpoint-format detail with teeth: Megatron stores its fused \`linear_qkv\` interleaved
per head group (\`[q_h, k_h, v_h]\` for each group), so a plain chunk is right there, while a GPT-2 or
Hugging Face checkpoint stores \`[Q; K; V]\` and must be regrouped on load as here; grouped-query attention
adds the constraint that the number of KV heads divides \`p\` too (or KV heads are replicated). The counter
is the poor man's \`torch.distributed.tensor.debug.CommDebugMode\`: four all-reduces of \`B · T · d\` per
layer per step (two forward, two backward) is the number to check before anything else, and production
adds dropout under a per-rank CUDA RNG state (\`get_cuda_rng_tracker\`) so a split dropout mask differs
across ranks while a replicated one does not.`,
};
