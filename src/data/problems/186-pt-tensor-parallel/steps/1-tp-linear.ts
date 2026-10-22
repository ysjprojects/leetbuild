import type {Step} from '@/lib/types';

export const tpLinearStep: Step = {
  id: 'tp-linear',
  title: 'f, g and the column- and row-parallel linears',
  concept: 'pytorch',
  file: 'tp_linear',
  focus: ['f-attn', 'g-attn', 'f-mlp', 'fc-r0', 'fc-r1', 'down-r0', 'down-r1', 'g-mlp'],
  task: `## Task

Write the two operators Megatron-LM is built on, and the two linear layers they make possible. \`nn.Linear\`
stores its weight as \`(out, in)\` and computes \`y = x Wᵀ + b\`; the paper writes \`Y = X A\` with
\`A = Wᵀ\`, so the paper's *columns* of \`A\` are rows of \`W\`. All tensors are float32; \`p\` is
\`dist.get_world_size()\` and \`r\` is \`dist.get_rank()\` (\`tp_world()\` and \`tp_rank()\`, given).

- **\`CopyToTP\`** is f, a \`torch.autograd.Function\`: forward returns \`x\` unchanged and communicates
  nothing; backward \`dist.all_reduce\`s (SUM) a contiguous copy of the incoming gradient and returns it.
- **\`ReduceFromTP\`** is g: forward all-reduces (SUM) a contiguous copy of \`x\`; backward returns the
  gradient unchanged. Never all-reduce autograd's own tensors in place.
- **\`GatherFromTP\`**: forward \`dist.all_gather\`s every rank's \`(…, n)\` slice into \`(…, n · p)\` in rank
  order (\`torch.cat(parts, dim=-1)\`); backward returns this rank's slice of the gradient.
  **\`ScatterToTP\`** is its mirror: forward keeps this rank's slice of the last dimension, backward
  all-gathers the gradient. \`copy_to_tp\`, \`reduce_from_tp\`, \`gather_from_tp\`, \`scatter_to_tp\` are their
  \`.apply\` (given).
- **\`ColumnParallelLinear(in_features, out_features, bias=True, gather_output=False)\`**: assert
  \`out_features % p == 0\`; \`self.out_per_rank = out_features // p\`; \`self.weight\` of shape
  \`(out_per_rank, in_features)\`, \`self.bias\` of shape \`(out_per_rank,)\` or \`None\`. Forward:
  \`copy_to_tp(x)\`, then \`F.linear(x, self.weight, self.bias)\`, then \`gather_from_tp\` only when
  \`gather_output\`.
- **\`RowParallelLinear(in_features, out_features, bias=True, input_is_parallel=True)\`**: assert
  \`in_features % p == 0\`; \`self.in_per_rank = in_features // p\`; \`self.weight\` of shape
  \`(out_features, in_per_rank)\`; \`self.bias\` of shape \`(out_features,)\`, whole on every rank. Forward:
  \`scatter_to_tp(x)\` when \`not self.input_is_parallel\`; \`reduce_from_tp(F.linear(x, self.weight))\`; then
  \`+ self.bias\` **once**, after g. A bias inside the local matmul would be summed \`p\` times.
- **\`from_dense(dense, …)\`** on both, a \`classmethod\`: under \`torch.no_grad()\`, rank \`r\` copies
  \`dense.weight.chunk(p, dim=0)[r]\` and the matching bias slice (column), or
  \`dense.weight.chunk(p, dim=1)[r]\` and the whole bias (row).
- Not allowed: DTensor, \`parallelize_module\`, \`ColwiseParallel\` / \`RowwiseParallel\`, Megatron, fairscale.

:::widget tensor-parallel {"layer": "mlp", "ranks": 2}

\`launch(fn, world, *args)\` is given: it spawns \`world\` processes with \`torch.multiprocessing.spawn\`, joins a
gloo group through a file in a temporary directory, runs \`fn(rank, world, *args)\`, saves its result,
destroys the group and returns the results by rank. The self-test builds \`nn.Linear(8, 16)\` and
\`nn.Linear(16, 8)\` with seed 0, runs both shardings on \`p = 2\` and \`p = 4\` with
\`gather_output\` and \`input_is_parallel\` both ways, reassembles outputs and gradients in the parent, and
checks them against the dense layers to \`1e-5\`: the outputs, the input gradient on every rank, the weight
gradient shard by shard and the replicated row bias. Then it prints \`PASS\`.

> f and g are each other's transpose: what one communicates forward the other communicates backward. A
> column-parallel layer behind f and a row-parallel layer in front of g cost one all-reduce each way.`,
  hints: [
    'A `Function`’s `backward` returns one gradient per `forward` input. For f the incoming `grad` is this rank’s share of dL/dx: its column shard used `x`, and so did every other rank’s. The true gradient is the sum, so all-reduce a `.contiguous().clone()` and return it.',
    'In `RowParallelLinear.forward`, call `F.linear(x, self.weight)` with no bias, wrap it in `reduce_from_tp`, then add `self.bias`. In `from_dense`, `chunk(p, dim=0)[rank]` takes output rows (column-parallel) and `chunk(p, dim=1)[rank]` input columns (row-parallel); the row layer copies the whole bias.',
    'Gather: `parts = [torch.empty_like(x) for _ in range(tp_world())]`, `dist.all_gather(parts, x.contiguous())`, `return torch.cat(parts, dim=-1)`; its backward is `grad.chunk(tp_world(), dim=-1)[tp_rank()]`. Scatter is the same two bodies swapped.',
  ],
  checks: [
    {
      id: 'f-operator',
      title: 'f all-reduces the gradient in backward',
      detail:
        'An autograd `Function` whose `backward` body calls `dist.all_reduce(…)`: the input of a column-parallel layer feeds every rank’s shard, so its gradient is the sum of `p` partial gradients. Forward is the identity.',
      match: {
        python: {
          all: [
            /class\s+\w+\(\s*(?:torch\.autograd\.)?Function\s*\)/,
            /def backward\(\s*ctx[^)]*\)[^\n]*:\s*\n(?:[ \t]{8,}[^\n]*\n|[ \t]*\n)*?[ \t]{8,}[^\n]*dist\.all_reduce\(/,
          ],
        },
      },
    },
    {
      id: 'g-operator',
      title: 'g all-reduces the activation in forward',
      detail:
        'An autograd `Function` whose `forward` body calls `dist.all_reduce(…)` on a contiguous copy: each row-parallel shard produces a partial product over its slice of the inner dimension, and the sum is the layer’s output. Backward is the identity.',
      match: {
        python: {
          all: [
            /def forward\(\s*ctx[^)]*\)[^\n]*:\s*\n(?:[ \t]{8,}[^\n]*\n|[ \t]*\n)*?[ \t]{8,}[^\n]*dist\.all_reduce\(/,
          ],
        },
      },
    },
    {
      id: 'gather-last-dim',
      title: 'The gather concatenates rank slices on the last dimension',
      detail:
        '`dist.all_gather(parts, x)` into one buffer per rank, then `torch.cat(parts, dim=-1)`; the backward hands each rank its own slice of the gradient (`chunk` or `split` on the last dimension).',
      match: {
        python: {
          all: [
            /dist\.all_gather\(/,
            /torch\.cat\(\s*\w+\s*,\s*dim\s*=\s*-1\s*\)/,
            /grad\w*\.(?:chunk|split|tensor_split)\(/,
          ],
        },
      },
    },
    {
      id: 'column-shard',
      title: 'Column-parallel weight is (out / p, in) behind f',
      detail:
        '`self.out_per_rank = out_features // p` and a weight of shape `(self.out_per_rank, in_features)`; forward calls `copy_to_tp(x)` before the local `F.linear`, so the input gradient is summed over ranks.',
      match: {
        python: {
          all: [
            /self\.out_per_rank\s*=\s*out_features\s*\/\/\s*\w+/,
            /torch\.\w+\(\s*self\.out_per_rank\s*,\s*in_features\s*\)/,
          ],
          order: [
            /class ColumnParallelLinear/,
            /copy_to_tp\(\s*x\s*\)|CopyToTP\.apply\(\s*x\s*\)/,
            /F\.linear\(|torch\.matmul\(|@\s*self\.weight/,
          ],
        },
      },
    },
    {
      id: 'row-shard-bias-once',
      title: 'Row-parallel weight is (out, in / p), bias added once after g',
      detail:
        '`self.in_per_rank = in_features // p`, a weight of shape `(out_features, self.in_per_rank)`, the local matmul without the bias inside `reduce_from_tp(…)`, and `+ self.bias` after it. A bias in the local matmul would be counted `p` times.',
      match: {
        python: {
          all: [
            /self\.in_per_rank\s*=\s*in_features\s*\/\/\s*\w+/,
            /torch\.\w+\(\s*out_features\s*,\s*self\.in_per_rank\s*\)/,
          ],
          order: [
            /class RowParallelLinear/,
            /reduce_from_tp\(\s*(?:F\.linear|torch\.matmul|x\s*@)|ReduceFromTP\.apply\(/,
            /\+\s*self\.bias/,
          ],
        },
      },
    },
    {
      id: 'input-is-parallel',
      title: 'A full input is scattered before the row-parallel matmul',
      detail:
        'When `input_is_parallel` is `False` the layer receives the whole `(…, in_features)` input and keeps its own slice with `scatter_to_tp(x)`, whose backward all-gathers the input gradient.',
      match: {
        python: {
          all: [/if\s+not\s+self\.input_is_parallel/, /scatter_to_tp\(\s*x\s*\)|ScatterToTP\.apply\(\s*x\s*\)/],
        },
      },
    },
    {
      id: 'from-dense',
      title: 'from_dense takes rows for column, columns for row',
      detail:
        'Under `torch.no_grad()`, rank `r` copies `dense.weight.chunk(p, dim=0)[r]` for the column-parallel layer and `dense.weight.chunk(p, dim=1)[r]` for the row-parallel one (or the equivalent slices).',
      match: {
        python: {
          all: [
            /torch\.no_grad\(\)/,
            /weight\.(?:chunk|tensor_split|split)\([^\n]*dim\s*=\s*0|weight\[\s*\w+\s*:\s*\w+\s*\]/,
            /weight\.(?:chunk|tensor_split|split)\([^\n]*dim\s*=\s*1|weight\[\s*:\s*,\s*\w+\s*:\s*\w+\s*\]/,
          ],
        },
      },
    },
    {
      id: 'no-library-tp',
      title: 'No library tensor parallelism',
      detail:
        'The sharding is the point: no DTensor, `parallelize_module`, `ColwiseParallel` / `RowwiseParallel`, Megatron or fairscale.',
      match: {
        python: {
          none: [
            /parallelize_module/,
            /ColwiseParallel|RowwiseParallel/,
            /DTensor|distribute_tensor/,
            /\bmegatron\b/,
            /fairscale/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Megatron-LM tensor parallelism, part 1: the conjugate operators f and g, and the two parallel linears."""

import os
import sys
import tempfile

import torch
import torch.distributed as dist
import torch.multiprocessing as mp
import torch.nn as nn
import torch.nn.functional as F


def tp_rank() -> int:
    return dist.get_rank()


def tp_world() -> int:
    return dist.get_world_size()


# ---- the conjugate operators -------------------------------------------------------------------


class CopyToTP(torch.autograd.Function):
    """f: identity forward, all-reduce (sum) of the input gradient backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: f forward, the identity")

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: f backward, sum the input gradient over every rank")


class ReduceFromTP(torch.autograd.Function):
    """g: all-reduce (sum) forward, identity backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: g forward, sum the partial outputs over every rank")

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: g backward, the identity")


class GatherFromTP(torch.autograd.Function):
    """All-gather along the last dimension forward; keep this rank's slice of the gradient backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: gather every rank's slice, concatenated in rank order on the last dim")

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: this rank's slice of the gradient")


class ScatterToTP(torch.autograd.Function):
    """Keep this rank's slice of the last dimension forward; all-gather the gradient backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: this rank's slice of the last dim")

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: gather the gradient slices back to full width")


def copy_to_tp(x: torch.Tensor) -> torch.Tensor:
    return CopyToTP.apply(x)


def reduce_from_tp(x: torch.Tensor) -> torch.Tensor:
    return ReduceFromTP.apply(x)


def gather_from_tp(x: torch.Tensor) -> torch.Tensor:
    return GatherFromTP.apply(x)


def scatter_to_tp(x: torch.Tensor) -> torch.Tensor:
    return ScatterToTP.apply(x)


# ---- the parallel linears ----------------------------------------------------------------------


class ColumnParallelLinear(nn.Module):
    """Y = X Aᵀ with A split by output rows: this rank holds A[r · out/p : (r+1) · out/p, :]."""

    def __init__(self, in_features: int, out_features: int, bias: bool = True, gather_output: bool = False):
        super().__init__()
        # TODO: assert divisibility; self.in_features, self.out_features, self.out_per_rank, self.gather_output;
        # self.weight of shape (out_per_rank, in_features); self.bias of shape (out_per_rank,) or None.
        raise NotImplementedError("TODO: the column shard")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: f, the local matmul with the bias shard, gather if gather_output")

    @classmethod
    def from_dense(cls, dense: nn.Linear, gather_output: bool = False) -> "ColumnParallelLinear":
        raise NotImplementedError("TODO: copy this rank's rows of dense.weight and dense.bias")


class RowParallelLinear(nn.Module):
    """Y = X Aᵀ with A split by input columns: this rank holds A[:, r · in/p : (r+1) · in/p]."""

    def __init__(self, in_features: int, out_features: int, bias: bool = True, input_is_parallel: bool = True):
        super().__init__()
        # TODO: assert divisibility; self.in_features, self.out_features, self.in_per_rank, self.input_is_parallel;
        # self.weight of shape (out_features, in_per_rank); self.bias of shape (out_features,), whole, or None.
        raise NotImplementedError("TODO: the row shard")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: scatter unless input_is_parallel, local matmul, g, then the bias once")

    @classmethod
    def from_dense(cls, dense: nn.Linear, input_is_parallel: bool = True) -> "RowParallelLinear":
        raise NotImplementedError("TODO: copy this rank's columns of dense.weight, and the whole bias")


# ---- running p processes -----------------------------------------------------------------------


def _entry(rank: int, world: int, tmp: str, fn, args: tuple) -> None:
    os.environ.setdefault("GLOO_SOCKET_IFNAME", "lo0" if sys.platform == "darwin" else "lo")
    store = "file://" + os.path.join(tmp, "rendezvous")
    dist.init_process_group("gloo", init_method=store, rank=rank, world_size=world)
    try:
        torch.save(fn(rank, world, *args), os.path.join(tmp, f"rank{rank}.pt"))
    finally:
        dist.destroy_process_group()


def launch(fn, world: int, *args) -> list:
    """Run \`fn(rank, world, *args)\` in \`world\` gloo processes on the CPU; return each rank's result, by rank."""
    with tempfile.TemporaryDirectory() as tmp:
        mp.spawn(_entry, args=(world, tmp, fn, args), nprocs=world, join=True)
        return [torch.load(os.path.join(tmp, f"rank{r}.pt")) for r in range(world)]


# ---- self-test ---------------------------------------------------------------------------------

B, T, D_IN, D_OUT = 3, 5, 8, 16


def _dense_case():
    """The same layers, inputs and output probes on every rank and in the parent."""
    torch.manual_seed(0)
    col = nn.Linear(D_IN, D_OUT)
    row = nn.Linear(D_OUT, D_IN)
    x = torch.randn(B, T, D_IN)
    h = torch.randn(B, T, D_OUT)
    probe_col = torch.randn(B, T, D_OUT)
    probe_row = torch.randn(B, T, D_IN)
    return col, row, x, h, probe_col, probe_row


def _worker(rank: int, world: int) -> dict:
    col, row, x, h, probe_col, probe_row = _dense_case()
    out = {}
    for gather in (False, True):
        layer = ColumnParallelLinear.from_dense(col, gather_output=gather)
        assert layer.weight.shape == (D_OUT // world, D_IN)
        xi = x.clone().requires_grad_()
        y = layer(xi)
        probe = probe_col if gather else probe_col.chunk(world, dim=-1)[rank]
        (y * probe).sum().backward()
        out[f"col{int(gather)}"] = (y.detach(), xi.grad, layer.weight.grad, layer.bias.grad)
    for parallel in (True, False):
        layer = RowParallelLinear.from_dense(row, input_is_parallel=parallel)
        assert layer.weight.shape == (D_IN, D_OUT // world)
        hi = (h.chunk(world, dim=-1)[rank] if parallel else h).clone().requires_grad_()
        y = layer(hi)
        (y * probe_row).sum().backward()
        out[f"row{int(parallel)}"] = (y.detach(), hi.grad, layer.weight.grad, layer.bias.grad)
    return out


def _check(name: str, got: torch.Tensor, want: torch.Tensor) -> None:
    assert got.shape == want.shape, f"{name}: shape {tuple(got.shape)} != {tuple(want.shape)}"
    assert torch.allclose(got, want, atol=1e-5, rtol=1e-5), f"{name}: max err {(got - want).abs().max():.2e}"


if __name__ == "__main__":
    col, row, x, h, probe_col, probe_row = _dense_case()
    x.requires_grad_()
    (col(x) * probe_col).sum().backward()
    h.requires_grad_()
    (row(h) * probe_row).sum().backward()
    with torch.no_grad():
        y_col, y_row = col(x), row(h)

    for world in (2, 4):
        ranks = launch(_worker, world)
        for gather in (False, True):
            ys, xgrads, wgrads, bgrads = zip(*(r[f"col{int(gather)}"] for r in ranks))
            y = ys[0] if gather else torch.cat(ys, dim=-1)
            _check(f"p={world} column output (gather={gather})", y, y_col)
            if gather:
                for other in ys[1:]:
                    _check(f"p={world} gathered output is the same on every rank", other, y_col)
            for g in xgrads:
                _check(f"p={world} column input grad: f all-reduces it", g, x.grad)
            _check(f"p={world} column weight grad", torch.cat(wgrads, dim=0), col.weight.grad)
            _check(f"p={world} column bias grad", torch.cat(bgrads, dim=0), col.bias.grad)
        for parallel in (True, False):
            ys, hgrads, wgrads, bgrads = zip(*(r[f"row{int(parallel)}"] for r in ranks))
            for y in ys:
                _check(f"p={world} row output on every rank (input_is_parallel={parallel})", y, y_row)
            hgrad = torch.cat(hgrads, dim=-1) if parallel else hgrads[0]
            _check(f"p={world} row input grad", hgrad, h.grad)
            _check(f"p={world} row weight grad", torch.cat(wgrads, dim=1), row.weight.grad)
            for g in bgrads:
                _check(f"p={world} row bias grad: added once, after g", g, row.bias.grad)
        print(f"p={world}: column and row parallel linears match nn.Linear, outputs and gradients")
    print("PASS")
`,
      solution: `"""Megatron-LM tensor parallelism, part 1: the conjugate operators f and g, and the two parallel linears."""

import os
import sys
import tempfile

import torch
import torch.distributed as dist
import torch.multiprocessing as mp
import torch.nn as nn
import torch.nn.functional as F


def tp_rank() -> int:
    return dist.get_rank()


def tp_world() -> int:
    return dist.get_world_size()


# ---- the conjugate operators -------------------------------------------------------------------


class CopyToTP(torch.autograd.Function):
    """f: identity forward, all-reduce (sum) of the input gradient backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        return x.view_as(x)

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        grad = grad.contiguous().clone()
        dist.all_reduce(grad, op=dist.ReduceOp.SUM)
        return grad


class ReduceFromTP(torch.autograd.Function):
    """g: all-reduce (sum) forward, identity backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        x = x.contiguous().clone()
        dist.all_reduce(x, op=dist.ReduceOp.SUM)
        return x

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        return grad


class GatherFromTP(torch.autograd.Function):
    """All-gather along the last dimension forward; keep this rank's slice of the gradient backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        x = x.contiguous()
        parts = [torch.empty_like(x) for _ in range(tp_world())]
        dist.all_gather(parts, x)
        return torch.cat(parts, dim=-1)

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        return grad.chunk(tp_world(), dim=-1)[tp_rank()].contiguous()


class ScatterToTP(torch.autograd.Function):
    """Keep this rank's slice of the last dimension forward; all-gather the gradient backward."""

    @staticmethod
    def forward(ctx, x: torch.Tensor) -> torch.Tensor:
        return x.chunk(tp_world(), dim=-1)[tp_rank()].contiguous()

    @staticmethod
    def backward(ctx, grad: torch.Tensor) -> torch.Tensor:
        grad = grad.contiguous()
        parts = [torch.empty_like(grad) for _ in range(tp_world())]
        dist.all_gather(parts, grad)
        return torch.cat(parts, dim=-1)


def copy_to_tp(x: torch.Tensor) -> torch.Tensor:
    return CopyToTP.apply(x)


def reduce_from_tp(x: torch.Tensor) -> torch.Tensor:
    return ReduceFromTP.apply(x)


def gather_from_tp(x: torch.Tensor) -> torch.Tensor:
    return GatherFromTP.apply(x)


def scatter_to_tp(x: torch.Tensor) -> torch.Tensor:
    return ScatterToTP.apply(x)


# ---- the parallel linears ----------------------------------------------------------------------


class ColumnParallelLinear(nn.Module):
    """Y = X Aᵀ with A split by output rows: this rank holds A[r · out/p : (r+1) · out/p, :]."""

    def __init__(self, in_features: int, out_features: int, bias: bool = True, gather_output: bool = False):
        super().__init__()
        world = tp_world()
        assert out_features % world == 0, f"out_features={out_features} is not divisible by {world} ranks"
        self.in_features = in_features
        self.out_features = out_features
        self.out_per_rank = out_features // world
        self.gather_output = gather_output
        self.weight = nn.Parameter(torch.empty(self.out_per_rank, in_features).normal_(0.0, 0.02))
        self.bias = nn.Parameter(torch.zeros(self.out_per_rank)) if bias else None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = copy_to_tp(x)
        y = F.linear(x, self.weight, self.bias)
        return gather_from_tp(y) if self.gather_output else y

    @classmethod
    def from_dense(cls, dense: nn.Linear, gather_output: bool = False) -> "ColumnParallelLinear":
        layer = cls(dense.in_features, dense.out_features, dense.bias is not None, gather_output)
        rank, world = tp_rank(), tp_world()
        with torch.no_grad():
            layer.weight.copy_(dense.weight.chunk(world, dim=0)[rank])
            if dense.bias is not None:
                layer.bias.copy_(dense.bias.chunk(world, dim=0)[rank])
        return layer


class RowParallelLinear(nn.Module):
    """Y = X Aᵀ with A split by input columns: this rank holds A[:, r · in/p : (r+1) · in/p]."""

    def __init__(self, in_features: int, out_features: int, bias: bool = True, input_is_parallel: bool = True):
        super().__init__()
        world = tp_world()
        assert in_features % world == 0, f"in_features={in_features} is not divisible by {world} ranks"
        self.in_features = in_features
        self.out_features = out_features
        self.in_per_rank = in_features // world
        self.input_is_parallel = input_is_parallel
        self.weight = nn.Parameter(torch.empty(out_features, self.in_per_rank).normal_(0.0, 0.02))
        self.bias = nn.Parameter(torch.zeros(out_features)) if bias else None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if not self.input_is_parallel:
            x = scatter_to_tp(x)
        y = reduce_from_tp(F.linear(x, self.weight))
        return y + self.bias if self.bias is not None else y

    @classmethod
    def from_dense(cls, dense: nn.Linear, input_is_parallel: bool = True) -> "RowParallelLinear":
        layer = cls(dense.in_features, dense.out_features, dense.bias is not None, input_is_parallel)
        rank, world = tp_rank(), tp_world()
        with torch.no_grad():
            layer.weight.copy_(dense.weight.chunk(world, dim=1)[rank])
            if dense.bias is not None:
                layer.bias.copy_(dense.bias)
        return layer


# ---- running p processes -----------------------------------------------------------------------


def _entry(rank: int, world: int, tmp: str, fn, args: tuple) -> None:
    os.environ.setdefault("GLOO_SOCKET_IFNAME", "lo0" if sys.platform == "darwin" else "lo")
    store = "file://" + os.path.join(tmp, "rendezvous")
    dist.init_process_group("gloo", init_method=store, rank=rank, world_size=world)
    try:
        torch.save(fn(rank, world, *args), os.path.join(tmp, f"rank{rank}.pt"))
    finally:
        dist.destroy_process_group()


def launch(fn, world: int, *args) -> list:
    """Run \`fn(rank, world, *args)\` in \`world\` gloo processes on the CPU; return each rank's result, by rank."""
    with tempfile.TemporaryDirectory() as tmp:
        mp.spawn(_entry, args=(world, tmp, fn, args), nprocs=world, join=True)
        return [torch.load(os.path.join(tmp, f"rank{r}.pt")) for r in range(world)]


# ---- self-test ---------------------------------------------------------------------------------

B, T, D_IN, D_OUT = 3, 5, 8, 16


def _dense_case():
    """The same layers, inputs and output probes on every rank and in the parent."""
    torch.manual_seed(0)
    col = nn.Linear(D_IN, D_OUT)
    row = nn.Linear(D_OUT, D_IN)
    x = torch.randn(B, T, D_IN)
    h = torch.randn(B, T, D_OUT)
    probe_col = torch.randn(B, T, D_OUT)
    probe_row = torch.randn(B, T, D_IN)
    return col, row, x, h, probe_col, probe_row


def _worker(rank: int, world: int) -> dict:
    col, row, x, h, probe_col, probe_row = _dense_case()
    out = {}
    for gather in (False, True):
        layer = ColumnParallelLinear.from_dense(col, gather_output=gather)
        assert layer.weight.shape == (D_OUT // world, D_IN)
        xi = x.clone().requires_grad_()
        y = layer(xi)
        probe = probe_col if gather else probe_col.chunk(world, dim=-1)[rank]
        (y * probe).sum().backward()
        out[f"col{int(gather)}"] = (y.detach(), xi.grad, layer.weight.grad, layer.bias.grad)
    for parallel in (True, False):
        layer = RowParallelLinear.from_dense(row, input_is_parallel=parallel)
        assert layer.weight.shape == (D_IN, D_OUT // world)
        hi = (h.chunk(world, dim=-1)[rank] if parallel else h).clone().requires_grad_()
        y = layer(hi)
        (y * probe_row).sum().backward()
        out[f"row{int(parallel)}"] = (y.detach(), hi.grad, layer.weight.grad, layer.bias.grad)
    return out


def _check(name: str, got: torch.Tensor, want: torch.Tensor) -> None:
    assert got.shape == want.shape, f"{name}: shape {tuple(got.shape)} != {tuple(want.shape)}"
    assert torch.allclose(got, want, atol=1e-5, rtol=1e-5), f"{name}: max err {(got - want).abs().max():.2e}"


if __name__ == "__main__":
    col, row, x, h, probe_col, probe_row = _dense_case()
    x.requires_grad_()
    (col(x) * probe_col).sum().backward()
    h.requires_grad_()
    (row(h) * probe_row).sum().backward()
    with torch.no_grad():
        y_col, y_row = col(x), row(h)

    for world in (2, 4):
        ranks = launch(_worker, world)
        for gather in (False, True):
            ys, xgrads, wgrads, bgrads = zip(*(r[f"col{int(gather)}"] for r in ranks))
            y = ys[0] if gather else torch.cat(ys, dim=-1)
            _check(f"p={world} column output (gather={gather})", y, y_col)
            if gather:
                for other in ys[1:]:
                    _check(f"p={world} gathered output is the same on every rank", other, y_col)
            for g in xgrads:
                _check(f"p={world} column input grad: f all-reduces it", g, x.grad)
            _check(f"p={world} column weight grad", torch.cat(wgrads, dim=0), col.weight.grad)
            _check(f"p={world} column bias grad", torch.cat(bgrads, dim=0), col.bias.grad)
        for parallel in (True, False):
            ys, hgrads, wgrads, bgrads = zip(*(r[f"row{int(parallel)}"] for r in ranks))
            for y in ys:
                _check(f"p={world} row output on every rank (input_is_parallel={parallel})", y, y_row)
            hgrad = torch.cat(hgrads, dim=-1) if parallel else hgrads[0]
            _check(f"p={world} row input grad", hgrad, h.grad)
            _check(f"p={world} row weight grad", torch.cat(wgrads, dim=1), row.weight.grad)
            for g in bgrads:
                _check(f"p={world} row bias grad: added once, after g", g, row.bias.grad)
        print(f"p={world}: column and row parallel linears match nn.Linear, outputs and gradients")
    print("PASS")
`,
    },
  },
  debrief: `The two operators are the whole method. A column-parallel layer splits the output features, so every
rank needs the whole input and returns a slice of the output: forward is free, but \`x\` was used by
\`p\` shards, so its gradient is a sum of \`p\` partial gradients (f). A row-parallel layer splits the
inner dimension, so each rank's product is a partial sum of the output (g), while the gradient of the
sum with respect to each partial is the identity. f and g are transposes of each other, and every
Megatron layer is built from these two plus the gather and scatter you wrote for the edges. The
\`.clone()\` before each in-place \`all_reduce\` matters: autograd may hand the same buffer to another
consumer, and a collective that overwrites a saved tensor corrupts the graph silently. Megatron's
\`megatron/core/tensor_parallel/mappings.py\` has the same four classes
(\`_CopyToModelParallelRegion\`, \`_ReduceFromModelParallelRegion\`, \`_ScatterToModelParallelRegion\`,
\`_GatherFromModelParallelRegion\`) plus the sequence-parallel variants that replace the all-reduce with a
reduce-scatter and an all-gather. What production adds: NCCL over NVLink instead of gloo over loopback,
the input-gradient all-reduce launched asynchronously so it overlaps the weight-gradient GEMM
(\`LinearWithGradAccumulationAndAsyncCommunication\`), and the master weight initialised whole and then
split (\`_initialize_affine_weight_cpu\`), so a fresh model is the same whatever \`p\` is. The processes here
rendezvous through a file (\`init_method="file://<tmp>/rendezvous"\`) rather than \`MASTER_ADDR\`/\`MASTER_PORT\`: on one
machine the TCP store adds nothing, and on a host whose name does not resolve its start-up stalls for
about 35 s; \`GLOO_SOCKET_IFNAME\` pins gloo to the loopback device for the same reason.`,
};
