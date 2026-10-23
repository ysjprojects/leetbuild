import type {Step} from '@/lib/types';

export const zero3Step: Step = {
  id: 'zero3',
  title: 'ZeRO-3: sharded weights, gathered per layer',
  concept: 'pytorch',
  file: 'zero3',
  localOnly:
    'its self-test runs the ranks as gloo processes through torch.multiprocessing, which the browser runtime cannot start',
  focus: [
    'shard-rest',
    'fwd-gather',
    'fwd-compute',
    'fwd-free',
    'bwd-gather',
    'bwd-compute',
    'reduce-shard',
    'opt-step',
  ],
  task: `## Task

Shard the parameters too. Each \`nn.Linear\` becomes this rank's slice of its flat \`[weight, bias]\`; the
full weight is all-gathered for the layer's forward, freed, gathered again for its backward, and freed;
the weight gradient is reduce-scattered back to the shard. Import \`from ddp import LR, STEPS,
broadcast_parameters, ddp_worker, make_data, make_model, run_ranks\` and \`from zero1 import all_gather_,
reduce_scatter_\`. \`FullWeightMeter\` and \`METER\` are given: \`METER.track(numel, *tensors)\` counts \`numel\`
elements as alive until the last of \`tensors\` is garbage-collected, and keeps the peak.

- \`ShardedLinear(linear)\` (an \`nn.Module\`):
  - \`in_features\`, \`out_features\`, \`numel = weight.numel() + bias.numel()\`, \`padded\` rounded up to a
    multiple of the world size.
  - \`self.shard = nn.Parameter(...)\`: this rank's \`padded / N\` slice of the zero-padded flat
    \`torch.cat([weight.reshape(-1), bias])\`, cloned so the full tensors can be dropped.
  - \`gather() -> (weight, bias)\`: \`all_gather_\` into a fresh \`torch.empty(padded)\`, view \`weight\`
    \`(out, in)\` and \`bias\` \`(out,)\` out of it, call \`METER.track(self.padded, flat, weight, bias)\`, return
    \`(weight, bias)\`.
  - \`forward(x)\`: \`GatheredLinear.apply(x, self.shard, self)\`. Passing \`self.shard\` is what connects the
    shard to the graph, so autograd hands its gradient to the optimizer.
- \`GatheredLinear(torch.autograd.Function)\`:
  - \`forward(ctx, x, shard, layer)\`: \`weight, bias = layer.gather()\`, \`ctx.save_for_backward(x)\`,
    \`ctx.layer = layer\`, return \`F.linear(x, weight, bias)\`. **Never** save the weight: the whole point is
    that it dies when \`forward\` returns.
  - \`backward(ctx, grad_y)\`: gather again; \`grad_x = grad_y @ weight\`; write \`grad_y.t() @ x\` and
    \`grad_y.sum(0)\` into a zero flat of length \`padded\`; \`grad_shard = reduce_scatter_(flat)\` divided by
    the world size and cloned (it is a view of scratch); return \`(grad_x, grad_shard, None)\`.
- \`shard_module(model)\`: replace every \`nn.Linear\` child (recursively) with \`ShardedLinear(child)\` via
  \`setattr\`; return the model.
- Then plain \`torch.optim.AdamW(model.parameters())\` is a sharded optimizer: it only ever sees shards.
- No \`FullyShardedDataParallel\`, \`fully_shard\`, \`torch.distributed.fsdp\` or DeepSpeed.

The self-test broadcasts and shards step 1's model, trains 5 steps with \`torch.optim.AdamW(lr=LR)\`, and
for world sizes 2 and 4 asserts: every \`shard.grad\` is shard-sized; nothing gathered is still alive after
a step; \`METER.peak\` equals the largest layer's padded size (1,056 numbers, one 32 × 32 layer with its bias); the shards
add up to 1/N of every layer; AdamW's state is twice the shards; and the gathered parameters match DDP
within 1e-6. At N = 4 a rank holds 953 shard numbers plus at most 1,056 gathered, 2,009 instead of
3,811. Then \`PASS\`.

> ZeRO-3 trades memory for traffic: the weights are sent twice per step instead of being kept, 3Ψ of
> communication against DDP's 2Ψ, and in exchange no rank ever holds more than one layer whole.`,
  hints: [
    'The custom autograd function is where the memory is decided. Inside `forward`, autograd is off, so `F.linear` saves nothing; whatever you put in `ctx.save_for_backward` lives until backward. Save `x`, keep a reference to the module in `ctx.layer`, and gather the weight again in `backward`.',
    'The shard is the parameter that autograd tracks: `GatheredLinear.apply(x, self.shard, self)`. `backward` must return one gradient per `forward` input: `grad_x` for `x`, a tensor shaped like the shard for `shard`, and `None` for `layer`.',
    'In `backward`: `grad_flat = torch.zeros(layer.padded, dtype=grad_y.dtype)`, `grad_flat[:n_w].view_as(weight).copy_(grad_y.t() @ x)`, `grad_flat[n_w:layer.numel].copy_(grad_y.sum(0))`, then `reduce_scatter_(grad_flat).div_(dist.get_world_size()).clone()`. Every rank calls the same gathers and reduces in the same layer order, so the collectives pair up.',
  ],
  checks: [
    {
      id: 'autograd-function',
      title: 'A custom autograd function applied to the shard',
      detail:
        'A `torch.autograd.Function` with its own `backward`, called as `….apply(x, self.shard, …)`: only a hand-written backward can gather the weight again and return a shard-sized gradient. FSDP and DeepSpeed would do the work for you.',
      match: {
        python: {
          all: [/class\s+\w+\(\s*torch\.autograd\.Function\s*\)/, /def\s+backward\(\s*ctx/, /\.apply\(\s*x\b/],
          none: [
            /FullyShardedDataParallel|torch\.distributed\.fsdp|\bfully_shard\(|\bdeepspeed\b|DistributedDataParallel/,
          ],
        },
      },
    },
    {
      id: 'gather-in-forward',
      title: 'Forward gathers the weight and does not keep it',
      detail:
        '`forward` calls `gather()` and computes the layer from the gathered weight, saving only `x`. Saving the weight in `ctx` (or on `ctx` as an attribute) keeps every layer’s full weight alive until backward: DDP’s memory with ZeRO-3’s traffic.',
      match: {
        python: {
          order: [/def forward\(\s*ctx/, /\.gather\(\)/, /F\.linear\(|\bmatmul\(|\w\s*@\s*\w/],
          none: [/save_for_backward\([^)]*(?:weight|\bw\b|flat|full)/, /ctx\.(?:weight|w|flat|full|bias)\s*=/],
        },
      },
    },
    {
      id: 'regather-in-backward',
      title: 'Backward gathers again, then reduces to the shard',
      detail:
        '`backward` calls `gather()` a second time and ends in a reduce-scatter of the flat weight gradient (`reduce_scatter_` or `dist.reduce` per shard), so each rank keeps only its shard’s gradient.',
      match: {
        python: {
          order: [/def backward\(\s*ctx/, /\.gather\(\)/, /reduce_scatter_\(|dist\.reduce(?:_scatter(?:_tensor)?)?\(/],
        },
      },
    },
    {
      id: 'shard-gradient',
      title: 'The shard gradient is averaged and returned with None for the layer',
      detail:
        'The reduced shard is divided by the world size (the mean, as DDP takes) and returned as `(grad_x, grad_shard, None)`: one gradient per input of `forward`, `None` for the module.',
      match: {
        python: {
          all: [
            /\.div_\(\s*(?:dist\.get_world_size\(\)|(?:self\.|layer\.)?world_size)\s*\)|\/\s*(?:dist\.get_world_size\(\)|(?:self\.|layer\.)?world_size)\b/,
            /return\s+[\w.]+\s*,\s*[\w.]+\s*,\s*None\b/,
          ],
        },
      },
    },
    {
      id: 'shard-parameter',
      title: 'Each layer stored as a padded flat shard',
      detail:
        '`self.shard = nn.Parameter(…)` holds `padded / N` numbers, with `padded` the flat `[weight, bias]` size rounded up to a multiple of the world size: the only parameter the module registers.',
      match: {
        python: {
          all: [
            /self\.shard\s*=\s*nn\.Parameter\(/,
            /ceil\([^)]*world_size\s*\)\s*\*\s*(?:self\.)?world_size|\/\/\s*(?:self\.)?world_size\s*\)?\s*\*\s*(?:self\.)?world_size/,
          ],
        },
      },
    },
    {
      id: 'shard-module',
      title: 'Every Linear replaced in place',
      detail:
        '`shard_module` walks the children, and `setattr` replaces each `isinstance(child, nn.Linear)` with a `ShardedLinear`, so the original full tensors are dropped and the model runs unchanged.',
      match: {python: {all: [/isinstance\(\s*\w+\s*,\s*nn\.Linear\s*\)/, /setattr\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""ZeRO stage 3 from scratch: parameters sharded too; a layer's full weight exists only inside its forward and backward."""

import math
import weakref

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from ddp import LR, STEPS, broadcast_parameters, ddp_worker, make_data, make_model, run_ranks
from zero1 import all_gather_, reduce_scatter_


class FullWeightMeter:
    """Counts the gathered full-weight elements alive on this rank; \`peak\` is the most alive at once."""

    def __init__(self) -> None:
        self.live = 0
        self.peak = 0

    def track(self, numel: int, *tensors: torch.Tensor) -> None:
        """\`tensors\` share one buffer of \`numel\` elements, which is freed when the last of them dies."""
        self.live += numel
        self.peak = max(self.peak, self.live)
        remaining = [len(tensors)]

        def release() -> None:
            remaining[0] -= 1
            if remaining[0] == 0:
                self.live -= numel

        for t in tensors:
            weakref.finalize(t, release)


METER = FullWeightMeter()


class GatheredLinear(torch.autograd.Function):
    """y = x Wᵀ + b, where W and b exist on this rank only as a flat shard between calls."""

    @staticmethod
    def forward(ctx, x: torch.Tensor, shard: torch.Tensor, layer: "ShardedLinear") -> torch.Tensor:
        # TODO: gather the full weight and bias, keep only x (and the layer) for backward, return x Wᵀ + b.
        raise NotImplementedError("TODO: GatheredLinear.forward")

    @staticmethod
    def backward(ctx, grad_y: torch.Tensor):
        # TODO: gather again, compute grad_x, put grad_W and grad_b into a padded flat, reduce-scatter it,
        # average over the world size, and return (grad_x, grad_shard, None).
        raise NotImplementedError("TODO: GatheredLinear.backward")


class ShardedLinear(nn.Module):
    """An \`nn.Linear\` stored as this rank's shard of its flat \`[weight, bias]\`, padded to the world size."""

    def __init__(self, linear: nn.Linear):
        super().__init__()
        # TODO: in_features, out_features, numel (weight + bias), padded (a multiple of the world size), and
        # self.shard: an nn.Parameter holding this rank's slice of the padded flat [weight, bias].
        raise NotImplementedError("TODO: ShardedLinear.__init__")

    def gather(self) -> tuple[torch.Tensor, torch.Tensor]:
        """All-gather the full weight and bias; they are freed as soon as the caller drops them."""
        # TODO: all-gather the shards into a padded flat, view weight and bias out of it, and register all three
        # with METER.track(self.padded, flat, weight, bias) before returning (weight, bias).
        raise NotImplementedError("TODO: ShardedLinear.gather")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: run the layer through GatheredLinear with this shard.
        raise NotImplementedError("TODO: ShardedLinear.forward")


def shard_module(model: nn.Module) -> nn.Module:
    """Replace every \`nn.Linear\` child with a \`ShardedLinear\`; the full tensors are dropped."""
    # TODO: recursively setattr every nn.Linear child to ShardedLinear(child); return model.
    raise NotImplementedError("TODO: shard_module")


# ---- self-test ---------------------------------------------------------------------------------------


def zero3_worker(rank: int, world_size: int, steps: int) -> dict:
    model = make_model(seed=rank)
    broadcast_parameters(model)
    model = shard_module(model)
    layers = {name: m for name, m in model.named_modules() if isinstance(m, ShardedLinear)}
    opt = torch.optim.AdamW(model.parameters(), lr=LR)
    x, y = make_data()
    xb, yb = x.chunk(world_size)[rank], y.chunk(world_size)[rank]
    for _ in range(steps):
        opt.zero_grad(set_to_none=True)
        F.mse_loss(model(xb), yb).backward()
        assert all(m.shard.grad.shape == m.shard.shape for m in layers.values()), "gradients are sharded too"
        opt.step()
    leaked, peak = METER.live, METER.peak
    params = {}
    for name, m in layers.items():
        weight, bias = m.gather()
        params[f"{name}.weight"], params[f"{name}.bias"] = weight.clone(), bias.clone()
    return {
        "params": params,
        "peak": peak,
        "leaked": leaked,
        "shards": sum(m.shard.numel() for m in layers.values()),
        "layers": [m.padded for m in layers.values()],
        "state": sum(t.numel() for s in opt.state.values() for t in s.values() if t.dim() > 0),
    }


def check(world_size: int) -> tuple[float, int, int, int]:
    ddp = run_ranks(ddp_worker, world_size, STEPS)
    zero = run_ranks(zero3_worker, world_size, STEPS)
    worst = 0.0
    for r in zero:
        for k, v in ddp[0]["params"].items():
            worst = max(worst, (r["params"][k] - v).abs().max().item())
        assert r["leaked"] == 0, f"{r['leaked']} gathered elements still alive after the step"
        assert r["peak"] == max(r["layers"]), f"peak {r['peak']} gathered elements, want one layer ({max(r['layers'])})"
        assert r["shards"] * world_size == sum(r["layers"]), "each rank stores 1/world of every layer"
        assert r["state"] == 2 * r["shards"], "AdamW state covers the shards only"
    assert worst <= 1e-6, f"max |zero3 - ddp| = {worst:.3e}"
    full = sum(p.numel() for p in ddp[0]["params"].values())
    return worst, zero[0]["peak"], zero[0]["shards"], full


if __name__ == "__main__":
    for ws in (2, 4):
        err, peak, shards, full = check(ws)
        print(
            f"world {ws}: max |zero3 - ddp| = {err:.2e}; params per rank: {shards} sharded"
            f" + at most {peak} gathered = {shards + peak} (DDP: {full})"
        )
    print("PASS")
`,
      solution: `"""ZeRO stage 3 from scratch: parameters sharded too; a layer's full weight exists only inside its forward and backward."""

import math
import weakref

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from ddp import LR, STEPS, broadcast_parameters, ddp_worker, make_data, make_model, run_ranks
from zero1 import all_gather_, reduce_scatter_


class FullWeightMeter:
    """Counts the gathered full-weight elements alive on this rank; \`peak\` is the most alive at once."""

    def __init__(self) -> None:
        self.live = 0
        self.peak = 0

    def track(self, numel: int, *tensors: torch.Tensor) -> None:
        """\`tensors\` share one buffer of \`numel\` elements, which is freed when the last of them dies."""
        self.live += numel
        self.peak = max(self.peak, self.live)
        remaining = [len(tensors)]

        def release() -> None:
            remaining[0] -= 1
            if remaining[0] == 0:
                self.live -= numel

        for t in tensors:
            weakref.finalize(t, release)


METER = FullWeightMeter()


class GatheredLinear(torch.autograd.Function):
    """y = x Wᵀ + b, where W and b exist on this rank only as a flat shard between calls."""

    @staticmethod
    def forward(ctx, x: torch.Tensor, shard: torch.Tensor, layer: "ShardedLinear") -> torch.Tensor:
        weight, bias = layer.gather()
        ctx.save_for_backward(x)
        ctx.layer = layer
        return F.linear(x, weight, bias)

    @staticmethod
    def backward(ctx, grad_y: torch.Tensor):
        (x,) = ctx.saved_tensors
        layer = ctx.layer
        weight, _ = layer.gather()
        grad_x = grad_y @ weight
        grad_flat = torch.zeros(layer.padded, dtype=grad_y.dtype)
        n_weight = weight.numel()
        grad_flat[:n_weight].view_as(weight).copy_(grad_y.t() @ x)
        grad_flat[n_weight : layer.numel].copy_(grad_y.sum(0))
        grad_shard = reduce_scatter_(grad_flat).div_(dist.get_world_size()).clone()
        return grad_x, grad_shard, None


class ShardedLinear(nn.Module):
    """An \`nn.Linear\` stored as this rank's shard of its flat \`[weight, bias]\`, padded to the world size."""

    def __init__(self, linear: nn.Linear):
        super().__init__()
        world_size, rank = dist.get_world_size(), dist.get_rank()
        self.in_features, self.out_features = linear.in_features, linear.out_features
        self.numel = linear.weight.numel() + linear.bias.numel()
        self.padded = math.ceil(self.numel / world_size) * world_size
        size = self.padded // world_size
        flat = torch.zeros(self.padded, dtype=linear.weight.dtype)
        flat[: self.numel].copy_(torch.cat([linear.weight.detach().reshape(-1), linear.bias.detach()]))
        self.shard = nn.Parameter(flat[rank * size : (rank + 1) * size].clone())

    def gather(self) -> tuple[torch.Tensor, torch.Tensor]:
        """All-gather the full weight and bias; they are freed as soon as the caller drops them."""
        flat = torch.empty(self.padded, dtype=self.shard.dtype)
        all_gather_(flat, self.shard.detach())
        n_weight = self.out_features * self.in_features
        weight = flat[:n_weight].view(self.out_features, self.in_features)
        bias = flat[n_weight : self.numel]
        METER.track(self.padded, flat, weight, bias)
        return weight, bias

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return GatheredLinear.apply(x, self.shard, self)


def shard_module(model: nn.Module) -> nn.Module:
    """Replace every \`nn.Linear\` child with a \`ShardedLinear\`; the full tensors are dropped."""
    for name, child in model.named_children():
        if isinstance(child, nn.Linear):
            setattr(model, name, ShardedLinear(child))
        else:
            shard_module(child)
    return model


# ---- self-test ---------------------------------------------------------------------------------------


def zero3_worker(rank: int, world_size: int, steps: int) -> dict:
    model = make_model(seed=rank)
    broadcast_parameters(model)
    model = shard_module(model)
    layers = {name: m for name, m in model.named_modules() if isinstance(m, ShardedLinear)}
    opt = torch.optim.AdamW(model.parameters(), lr=LR)
    x, y = make_data()
    xb, yb = x.chunk(world_size)[rank], y.chunk(world_size)[rank]
    for _ in range(steps):
        opt.zero_grad(set_to_none=True)
        F.mse_loss(model(xb), yb).backward()
        assert all(m.shard.grad.shape == m.shard.shape for m in layers.values()), "gradients are sharded too"
        opt.step()
    leaked, peak = METER.live, METER.peak
    params = {}
    for name, m in layers.items():
        weight, bias = m.gather()
        params[f"{name}.weight"], params[f"{name}.bias"] = weight.clone(), bias.clone()
    return {
        "params": params,
        "peak": peak,
        "leaked": leaked,
        "shards": sum(m.shard.numel() for m in layers.values()),
        "layers": [m.padded for m in layers.values()],
        "state": sum(t.numel() for s in opt.state.values() for t in s.values() if t.dim() > 0),
    }


def check(world_size: int) -> tuple[float, int, int, int]:
    ddp = run_ranks(ddp_worker, world_size, STEPS)
    zero = run_ranks(zero3_worker, world_size, STEPS)
    worst = 0.0
    for r in zero:
        for k, v in ddp[0]["params"].items():
            worst = max(worst, (r["params"][k] - v).abs().max().item())
        assert r["leaked"] == 0, f"{r['leaked']} gathered elements still alive after the step"
        assert r["peak"] == max(r["layers"]), f"peak {r['peak']} gathered elements, want one layer ({max(r['layers'])})"
        assert r["shards"] * world_size == sum(r["layers"]), "each rank stores 1/world of every layer"
        assert r["state"] == 2 * r["shards"], "AdamW state covers the shards only"
    assert worst <= 1e-6, f"max |zero3 - ddp| = {worst:.3e}"
    full = sum(p.numel() for p in ddp[0]["params"].values())
    return worst, zero[0]["peak"], zero[0]["shards"], full


if __name__ == "__main__":
    for ws in (2, 4):
        err, peak, shards, full = check(ws)
        print(
            f"world {ws}: max |zero3 - ddp| = {err:.2e}; params per rank: {shards} sharded"
            f" + at most {peak} gathered = {shards + peak} (DDP: {full})"
        )
    print("PASS")
`,
    },
  },
  debrief: `With the optimizer and gradients sharded, what is left on every rank is the 2Ψ of weights, and ZeRO-3 removes it by observing that a layer's weight is only needed while that layer runs. Each layer owns a padded flat shard; its full weight is assembled by an all-gather just before forward, dropped as soon as forward returns, assembled again for backward, and dropped again, while the weight gradient goes through a reduce-scatter so each rank keeps only its shard's. The custom \`autograd.Function\` is the right place for this because it controls what the graph keeps: saving \`x\` and a reference to the module costs the activation, not the weight. The self-test measures it: \`METER\` sees at most 1,056 gathered numbers alive at once, one 32 × 32 layer with its bias, and a per-rank total of shards plus one layer: the ZeRO paper's 16Ψ/N of model states, plus a one-layer working set. The price is traffic: two all-gathers of the weights and one reduce-scatter of the gradients, 3Ψ per step per rank against DDP's 2Ψ, the 1.5× the paper states. Since the optimizer only sees shard parameters, a stock \`torch.optim.AdamW\` is already a sharded optimizer, which is exactly how FSDP is used. What production adds, mostly to hide that traffic: prefetching layer ℓ + 1's all-gather while layer ℓ computes (forward and backward prefetch in FSDP, \`stage3_prefetch_bucket_size\` in DeepSpeed), keeping small layers or the last layer gathered between forward and backward (\`reshard_after_forward=False\`), grouping many parameters into one flat unit per transformer block so each collective is large, bf16 gathers with fp32 master shards, initialisation directly into shards (\`deepspeed.zero.Init\`, the meta device) so the full model never exists on one rank, hybrid sharding that shards within a node and replicates across nodes, and offloading shards to CPU or NVMe (ZeRO-Offload, ZeRO-Infinity).`,
};
