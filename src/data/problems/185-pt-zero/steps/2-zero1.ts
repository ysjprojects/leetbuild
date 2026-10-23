import type {Step} from '@/lib/types';

export const zero1Step: Step = {
  id: 'zero1',
  title: 'ZeRO-1: AdamW with sharded moments',
  concept: 'pytorch',
  file: 'zero1',
  focus: ['stage-zero1', 'zero1-r0', 'zero1-r1', 'zero1-r2', 'zero1-r3'],
  task: `## Task

Shard the optimizer: every rank still holds all the parameters and computes all the gradients, but
AdamW's two moments, 2Ψ numbers in this float64 test and 12Ψ bytes in a mixed-precision run, live on one
rank per shard. Import from step 1: \`from ddp import LR, STEPS, broadcast_parameters, ddp_worker,
make_data, make_model, run_ranks\`.

- \`reduce_scatter_(flat) -> torch.Tensor\`: \`flat\` has a length divisible by the world size; split it into
  N equal shards and \`dist.reduce(shard_k, dst=k)\` each one to its owner \`k\`. Return this rank's shard (a
  view of \`flat\`), which now holds the sum over ranks; the rest of \`flat\` is scratch. This emulates a
  reduce-scatter with collectives every gloo build has.
- \`all_gather_(flat, shard)\`: \`dist.all_gather(list(flat.chunk(world_size)), shard.clone())\`, so every rank
  ends with every shard in rank order. Gather a clone: \`shard\` is itself a slice of \`flat\`.
- \`ShardedAdamW(params, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=1e-2)\`, the defaults of
  \`torch.optim.AdamW\`:
  - \`self.numel\`: the trainable parameters' total; \`self.padded\`: rounded **up** to a multiple of the world
    size (\`math.ceil(numel / N) * N\`); \`self.shard_size = padded // N\`.
  - \`self.flat\` and \`self.flat_grad\`: zero tensors of length \`padded\` in the parameters' dtype. Copy every
    parameter into \`self.flat\` in order and re-point it: \`p.data = self.flat[off : off + n].view_as(p)\`. The
    model's parameters now **are** slices of \`self.flat\`, so gathering into \`self.flat\` updates the model.
  - \`self.shard\`: the view \`self.flat[rank * S : (rank + 1) * S]\`; \`self.exp_avg\` and \`self.exp_avg_sq\`:
    zeros of length \`S\` only; \`self.t = 0\`.
  - \`zero_grad()\` sets every \`p.grad = None\`; \`state_numel()\` returns \`exp_avg.numel() + exp_avg_sq.numel()\`.
  - \`step()\` under \`@torch.no_grad()\`: copy each \`p.grad\` into \`self.flat_grad\`, zero the padding, take
    \`grad = reduce_scatter_(self.flat_grad).div_(N)\`, then torch's AdamW on the shard: \`t += 1\`;
    \`shard *= 1 - lr · weight_decay\`; \`m = β₁m + (1 − β₁)g\`; \`v = β₂v + (1 − β₂)g²\`;
    \`shard -= lr / (1 − β₁ᵗ) · m / (√v / √(1 − β₂ᵗ) + eps)\`. Finally \`all_gather_(self.flat, self.shard)\`.
- No \`torch.optim.Adam\`/\`AdamW\` inside this file, no \`dist.all_reduce\`, no \`ZeroRedundancyOptimizer\`.

The self-test trains step 1's model for 5 steps twice per world size (2 and 4): with \`ddp_worker\`
(\`GradBucketer\` + \`torch.optim.AdamW\`) and with \`ShardedAdamW(model.parameters(), lr=LR)\` and no bucketer.
It asserts identical parameters on every rank, a max abs difference from DDP of at most 1e-6, a padding
of fewer than N elements (3,811 parameters pad to 3,812), and \`state_numel() · N == 2 · padded\`: 3,812
moment numbers per rank at N = 2 and 1,906 at N = 4 instead of 7,622. Then \`PASS\`.

:::widget zero-memory {"psi": 7.5, "gpus": 64, "stage": "zero1"}

> AdamW is elementwise, so the update of element i needs only element i's gradient and moments. Whoever
> owns element i can update it alone and send the result to everyone.`,
  hints: [
    'Nothing in AdamW mixes elements: the moments and the update of element i depend on element i alone. Split the flat vector into N contiguous shards, let rank r own shard r, and the update of the whole model is N independent updates whose results are gathered.',
    'Padding: with 3,811 numbers and N = 2, `padded = 3,812` and the last shard ends in one zero. A zero gradient keeps `m = v = 0`, so the update there is `0 / (0 + eps) = 0` and decay keeps 0 at 0. Zero `flat_grad[numel:]` every step: a `dist.reduce` may leave scratch in the slices a rank does not own.',
    'Write the AdamW update with in-place ops on views, in torch’s order: `shard.mul_(1 - lr * wd)`, `exp_avg.lerp_(g, 1 - beta1)`, `exp_avg_sq.mul_(beta2).addcmul_(g, g, value=1 - beta2)`, `denom = (exp_avg_sq.sqrt() / math.sqrt(1 - beta2 ** t)).add_(eps)`, `shard.addcdiv_(exp_avg, denom, value=-lr / (1 - beta1 ** t))`.',
  ],
  checks: [
    {
      id: 'padded-flat',
      title: 'Flat length padded up to a multiple of the world size',
      detail:
        '`padded = math.ceil(numel / world_size) * world_size` (or `(numel + N − 1) // N * N`): N equal shards need a length N divides, and rounding down would leave the tail parameters with no owner.',
      match: {
        python: {
          all: [
            /ceil\([^)]*world_size\s*\)\s*\*\s*(?:self\.)?world_size|\/\/\s*(?:self\.)?world_size\s*\)?\s*\*\s*(?:self\.)?world_size/,
          ],
        },
      },
    },
    {
      id: 'params-alias-flat',
      title: 'Parameters re-pointed into the flat buffer',
      detail:
        '`p.data = self.flat[off : off + n].view_as(p)`: the model’s parameters become slices of one buffer, so the all-gather that refills the buffer updates the model with no copy back.',
      match: {python: {all: [/\.data\s*=\s*[^\n]*\.view(?:_as)?\(/]}},
    },
    {
      id: 'state-shard-only',
      title: 'Moments allocated for the own shard only',
      detail:
        '`exp_avg` and `exp_avg_sq` are zeros of the shard’s length: that is the whole saving of ZeRO-1. Wrapping `torch.optim.AdamW` or `ZeroRedundancyOptimizer` would hide the mechanism.',
      match: {
        python: {
          all: [/exp_avg\s*=\s*torch\.zeros(?:_like)?\(/, /exp_avg_sq\s*=\s*torch\.zeros(?:_like)?\(/],
          none: [
            /torch\.optim\.AdamW?\(/,
            /ZeroRedundancyOptimizer/,
            /DistributedDataParallel|FullyShardedDataParallel/,
          ],
        },
      },
    },
    {
      id: 'reduce-to-owner',
      title: 'Gradients reduced to their owners, not all-reduced',
      detail:
        'Each shard of the flat gradient is summed onto the rank that owns it (`dist.reduce(…, dst=owner)` per shard, or a native reduce-scatter): no rank needs the other shards’ sums, so an all-reduce would move twice the data for nothing.',
      match: {
        python: {
          all: [/dist\.(?:reduce|reduce_scatter|reduce_scatter_tensor)\(/],
          none: [/dist\.all_reduce\(/],
        },
      },
    },
    {
      id: 'adamw-update',
      title: 'AdamW arithmetic with decoupled decay and bias correction',
      detail:
        'The shard decays by `1 - lr * weight_decay` before the moment update, and both moments are bias-corrected with `1 - beta1 ** t` and `1 - beta2 ** t`, as `torch.optim.AdamW` does; anything else drifts from DDP within a few steps.',
      match: {
        python: {
          all: [
            /1\s*-\s*(?:self\.)?lr\s*\*\s*(?:self\.)?weight_decay/,
            /(?:beta1|betas\[0\])\s*\*\*/,
            /(?:beta2|betas\[1\])\s*\*\*/,
          ],
        },
      },
    },
    {
      id: 'step-order',
      title: 'Reduce, update the shard, then all-gather',
      detail:
        '`step()` reduces the gradients to their owners, updates the owned shard, and only then all-gathers the parameters: gathering first would spread the old values.',
      match: {
        python: {
          order: [
            /def step\(/,
            /reduce_scatter_\(|dist\.reduce(?:_scatter(?:_tensor)?)?\(/,
            /addcdiv_\(|\/\s*\(?\s*denom\b/,
            /all_gather_\(|dist\.all_gather(?:_into_tensor)?\(/,
          ],
        },
      },
    },
    {
      id: 'all-gather',
      title: 'Updated shards all-gathered into every replica',
      detail:
        '`dist.all_gather` (or `all_gather_into_tensor`) fills every rank’s flat buffer with every owner’s updated shard, so all replicas run the next forward with the same weights.',
      match: {python: {all: [/dist\.all_gather(?:_into_tensor)?\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""ZeRO stage 1 from scratch: AdamW whose moments live only on the rank that owns each shard."""

import math

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from ddp import LR, STEPS, broadcast_parameters, ddp_worker, make_data, make_model, run_ranks


def reduce_scatter_(flat: torch.Tensor) -> torch.Tensor:
    """Sum \`flat\` (length a multiple of the world size) over ranks; return this rank's shard of the sum.

    Emulated with one reduce per shard, each to the shard's owner: older gloo builds have no
    reduce-scatter. Only the returned shard is meaningful afterwards; the rest of \`flat\` is scratch.
    """
    # TODO: one dist.reduce per shard, each to the rank that owns it; return this rank's shard (a view).
    raise NotImplementedError("TODO: reduce_scatter_")


def all_gather_(flat: torch.Tensor, shard: torch.Tensor) -> None:
    """Fill \`flat\` with every rank's \`shard\`, in rank order (shards are contiguous slices of \`flat\`)."""
    # TODO: all-gather every rank's shard into the chunks of flat, in rank order.
    raise NotImplementedError("TODO: all_gather_")


class ShardedAdamW:
    """AdamW over the parameters' flat view, with \`exp_avg\`/\`exp_avg_sq\` kept for this rank's shard only.

    The parameters are re-pointed into one flat buffer padded to a multiple of the world size; rank r
    owns elements \`[r * S, (r + 1) * S)\`. \`step()\` reduces the gradients to their owners, updates the
    owned shard with torch's AdamW arithmetic, and all-gathers the updated shards into every replica.
    """

    def __init__(self, params, lr: float = 1e-3, betas=(0.9, 0.999), eps: float = 1e-8, weight_decay: float = 1e-2):
        self.params = [p for p in params if p.requires_grad]
        self.lr, self.betas, self.eps, self.weight_decay = lr, betas, eps, weight_decay
        self.world_size, self.rank = dist.get_world_size(), dist.get_rank()
        # TODO: self.numel, self.padded (a multiple of the world size), self.shard_size; self.flat and
        # self.flat_grad of length self.padded; re-point every p.data into self.flat; self.shard (a view of this
        # rank's slice); self.exp_avg and self.exp_avg_sq for the shard only; self.t = 0.
        raise NotImplementedError("TODO: ShardedAdamW.__init__")

    def zero_grad(self) -> None:
        for p in self.params:
            p.grad = None

    def state_numel(self) -> int:
        return self.exp_avg.numel() + self.exp_avg_sq.numel()

    @torch.no_grad()
    def step(self) -> None:
        # TODO: copy the grads into self.flat_grad (padding zeroed), reduce-scatter and average, AdamW on the
        # shard (decoupled decay, both moments, bias correction), then all-gather the shards into self.flat.
        raise NotImplementedError("TODO: ShardedAdamW.step")


# ---- self-test ---------------------------------------------------------------------------------------


def zero1_worker(rank: int, world_size: int, steps: int) -> dict:
    model = make_model(seed=rank)
    broadcast_parameters(model)
    opt = ShardedAdamW(model.parameters(), lr=LR)
    x, y = make_data()
    xb, yb = x.chunk(world_size)[rank], y.chunk(world_size)[rank]
    for _ in range(steps):
        opt.zero_grad()
        F.mse_loss(model(xb), yb).backward()
        opt.step()
    return {
        "params": {k: v.detach().clone() for k, v in model.state_dict().items()},
        "state": opt.state_numel(),
        "numel": opt.numel,
        "padded": opt.padded,
    }


def check(world_size: int) -> tuple[float, int, int]:
    ddp = run_ranks(ddp_worker, world_size, STEPS)
    zero = run_ranks(zero1_worker, world_size, STEPS)
    worst = 0.0
    for r in zero:
        for k, v in ddp[0]["params"].items():
            assert torch.equal(r["params"][k], zero[0]["params"][k]), f"ranks disagree on {k}"
            worst = max(worst, (r["params"][k] - v).abs().max().item())
        numel, padded = r["numel"], r["padded"]
        assert padded % world_size == 0 and 0 <= padded - numel < world_size
        assert r["state"] * world_size == 2 * padded, "each rank keeps exp_avg and exp_avg_sq for 1/world of the flat"
    assert worst <= 1e-6, f"max |zero1 - ddp| = {worst:.3e}"
    return worst, zero[0]["state"], 2 * zero[0]["numel"]


if __name__ == "__main__":
    for ws in (2, 4):
        err, state, full = check(ws)
        print(f"world {ws}: max |zero1 - ddp| = {err:.2e}, AdamW state per rank {state} of {full} numbers")
    print("PASS")
`,
      solution: `"""ZeRO stage 1 from scratch: AdamW whose moments live only on the rank that owns each shard."""

import math

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from ddp import LR, STEPS, broadcast_parameters, ddp_worker, make_data, make_model, run_ranks


def reduce_scatter_(flat: torch.Tensor) -> torch.Tensor:
    """Sum \`flat\` (length a multiple of the world size) over ranks; return this rank's shard of the sum.

    Emulated with one reduce per shard, each to the shard's owner: older gloo builds have no
    reduce-scatter. Only the returned shard is meaningful afterwards; the rest of \`flat\` is scratch.
    """
    world_size, rank = dist.get_world_size(), dist.get_rank()
    size = flat.numel() // world_size
    for owner in range(world_size):
        dist.reduce(flat[owner * size : (owner + 1) * size], dst=owner)
    return flat[rank * size : (rank + 1) * size]


def all_gather_(flat: torch.Tensor, shard: torch.Tensor) -> None:
    """Fill \`flat\` with every rank's \`shard\`, in rank order (shards are contiguous slices of \`flat\`)."""
    world_size = dist.get_world_size()
    dist.all_gather(list(flat.chunk(world_size)), shard.clone())


class ShardedAdamW:
    """AdamW over the parameters' flat view, with \`exp_avg\`/\`exp_avg_sq\` kept for this rank's shard only.

    The parameters are re-pointed into one flat buffer padded to a multiple of the world size; rank r
    owns elements \`[r * S, (r + 1) * S)\`. \`step()\` reduces the gradients to their owners, updates the
    owned shard with torch's AdamW arithmetic, and all-gathers the updated shards into every replica.
    """

    def __init__(self, params, lr: float = 1e-3, betas=(0.9, 0.999), eps: float = 1e-8, weight_decay: float = 1e-2):
        self.params = [p for p in params if p.requires_grad]
        self.lr, self.betas, self.eps, self.weight_decay = lr, betas, eps, weight_decay
        self.world_size, self.rank = dist.get_world_size(), dist.get_rank()
        self.numel = sum(p.numel() for p in self.params)
        self.padded = math.ceil(self.numel / self.world_size) * self.world_size
        self.shard_size = self.padded // self.world_size
        dtype = self.params[0].dtype
        self.flat = torch.zeros(self.padded, dtype=dtype)
        self.flat_grad = torch.zeros(self.padded, dtype=dtype)
        offset = 0
        with torch.no_grad():
            for p in self.params:
                n = p.numel()
                self.flat[offset : offset + n].copy_(p.reshape(-1))
                p.data = self.flat[offset : offset + n].view_as(p)
                offset += n
        lo = self.rank * self.shard_size
        self.shard = self.flat[lo : lo + self.shard_size]
        self.exp_avg = torch.zeros(self.shard_size, dtype=dtype)
        self.exp_avg_sq = torch.zeros(self.shard_size, dtype=dtype)
        self.t = 0

    def zero_grad(self) -> None:
        for p in self.params:
            p.grad = None

    def state_numel(self) -> int:
        return self.exp_avg.numel() + self.exp_avg_sq.numel()

    @torch.no_grad()
    def step(self) -> None:
        offset = 0
        for p in self.params:
            n = p.numel()
            self.flat_grad[offset : offset + n].copy_(p.grad.reshape(-1))
            offset += n
        self.flat_grad[self.numel :].zero_()
        grad = reduce_scatter_(self.flat_grad).div_(self.world_size)

        self.t += 1
        beta1, beta2 = self.betas
        self.shard.mul_(1 - self.lr * self.weight_decay)
        self.exp_avg.lerp_(grad, 1 - beta1)
        self.exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)
        bias1 = 1 - beta1**self.t
        bias2 = 1 - beta2**self.t
        denom = (self.exp_avg_sq.sqrt() / math.sqrt(bias2)).add_(self.eps)
        self.shard.addcdiv_(self.exp_avg, denom, value=-self.lr / bias1)

        all_gather_(self.flat, self.shard)


# ---- self-test ---------------------------------------------------------------------------------------


def zero1_worker(rank: int, world_size: int, steps: int) -> dict:
    model = make_model(seed=rank)
    broadcast_parameters(model)
    opt = ShardedAdamW(model.parameters(), lr=LR)
    x, y = make_data()
    xb, yb = x.chunk(world_size)[rank], y.chunk(world_size)[rank]
    for _ in range(steps):
        opt.zero_grad()
        F.mse_loss(model(xb), yb).backward()
        opt.step()
    return {
        "params": {k: v.detach().clone() for k, v in model.state_dict().items()},
        "state": opt.state_numel(),
        "numel": opt.numel,
        "padded": opt.padded,
    }


def check(world_size: int) -> tuple[float, int, int]:
    ddp = run_ranks(ddp_worker, world_size, STEPS)
    zero = run_ranks(zero1_worker, world_size, STEPS)
    worst = 0.0
    for r in zero:
        for k, v in ddp[0]["params"].items():
            assert torch.equal(r["params"][k], zero[0]["params"][k]), f"ranks disagree on {k}"
            worst = max(worst, (r["params"][k] - v).abs().max().item())
        numel, padded = r["numel"], r["padded"]
        assert padded % world_size == 0 and 0 <= padded - numel < world_size
        assert r["state"] * world_size == 2 * padded, "each rank keeps exp_avg and exp_avg_sq for 1/world of the flat"
    assert worst <= 1e-6, f"max |zero1 - ddp| = {worst:.3e}"
    return worst, zero[0]["state"], 2 * zero[0]["numel"]


if __name__ == "__main__":
    for ws in (2, 4):
        err, state, full = check(ws)
        print(f"world {ws}: max |zero1 - ddp| = {err:.2e}, AdamW state per rank {state} of {full} numbers")
    print("PASS")
`,
    },
  },
  debrief: `ZeRO-1 rests on one property of Adam: it is elementwise. The update of a parameter depends on its own gradient and its own two moments, so the optimizer state can be cut into N pieces with no communication between them, and each rank pays for 1/N of it. In mixed precision that state is 12Ψ of the 16Ψ bytes per parameter (fp32 master weights, \`m\` and \`v\`), so at N = 64 the per-GPU total for a 7.5B model falls from 120 GB to 31.4 GB, the paper's figure. The flat padded view is what makes the cut cheap: one contiguous vector, N equal slices, ownership by index. Re-pointing \`p.data\` into it means the all-gather writes straight into the model. The communication is a reduce-scatter of the gradients followed by an all-gather of the parameters, which together move exactly what DDP's all-reduce moves (a ring all-reduce *is* a reduce-scatter then an all-gather), so ZeRO-1 costs no extra bandwidth. **Gloo and reduce-scatter**: gloo has no reduce-scatter at all through PyTorch 2.1 (\`ProcessGroupGloo does not support reduce_scatter\`); 2.2 adds \`reduce_scatter_tensor\`, which the 2.14 used here runs but marks deprecated in favour of \`reduce_scatter_single\`, and the list form \`dist.reduce_scatter\` only works on gloo from 2.8. To run unchanged from 2.1 on, \`reduce_scatter_\` emulates it with N \`dist.reduce\` calls, one per shard to its owner: the same result, with N collective launches where NCCL would use one. This file still materialises the full flat gradient on every rank; dropping the non-owned part as soon as it is reduced is ZeRO-2, which DeepSpeed implements by reducing bucket by bucket during backward. What production adds: bf16 or fp16 compute weights with fp32 master shards, gradient bucketing and overlap of the reduce-scatter with backward, \`ZeroRedundancyOptimizer\` in PyTorch (shards by whole parameters rather than a flat view), gradient clipping that needs a global norm all-reduced across shards, and checkpoints that save each rank's shard and reshard on load.`,
};
