import type {Step} from '@/lib/types';

export const tpVocabStep: Step = {
  id: 'tp-vocab',
  title: 'The vocabulary: parallel embedding, tied head, parallel cross-entropy',
  concept: 'pytorch',
  file: 'tp_vocab',
  focus: ['vocab-embed', 'lm-logits', 'ce-max', 'ce-sumexp', 'ce-target', 'ce-loss'],
  task: `## Task

Split the two ends of the model by vocabulary. The token table is the largest matrix of a small model
(\`V · d\`: 50,257 × 768 in GPT-2 small, 128,256 × 16,384 in Llama 3 405B), and its logits are the
largest activation: \`B · T · V\` floats. Each rank owns a contiguous range of \`V / p\` ids and never sees
the others' logits.

- **\`vocab_range(vocab_size, rank, world) -> (start, end)\`**: assert \`vocab_size % world == 0\`;
  rank \`r\` owns \`[r · V/p, (r+1) · V/p)\`.
- **\`VocabParallelEmbedding(num_embeddings, embedding_dim)\`**: \`self.start, self.end\` from
  \`vocab_range\`, \`self.weight\` of shape \`(end − start, embedding_dim)\`. Forward: a mask of the ids outside
  \`[start, end)\`; local ids \`ids − start\` with foreign ones replaced by 0; \`F.embedding\`; zero the
  foreign rows (\`masked_fill\`); \`reduce_from_tp\`. Exactly one rank contributes each row of the sum.
  \`from_dense\` copies rows \`[start, end)\`.
- **\`parallel_lm_logits(hidden, weight)\`**: the head tied to the embedding shard,
  \`F.linear(copy_to_tp(hidden), weight)\` → \`(B, T, V / p)\`. No gather.
- **\`VocabParallelCrossEntropy\`**, a \`torch.autograd.Function\`, per token, on \`logits (…, V / p)\` float32
  and global \`target (…)\` int64:
  - \`m\`: the local max over the last dim, then \`dist.all_reduce(…, op=ReduceOp.MAX)\`; shift
    \`z = logits − m\`.
  - the target logit: the rank that owns \`target\` gathers \`z[target − start]\`, every other rank
    contributes 0 (masked), then \`ReduceOp.SUM\`.
  - \`S = Σ exp(z)\` locally, then \`ReduceOp.SUM\`.
  - \`loss = log S − z_target\`, the same on every rank. Save \`exp(z) / S\` (this shard's softmax) and
    the mask.
  - backward: \`softmax − one_hot(target)\` on this shard (the one-hot only where this rank owns the
    target, e.g. \`scatter_add_\` of \`−1\`), times \`grad_loss.unsqueeze(-1)\`; \`None\` for the target.
- **\`vocab_parallel_cross_entropy(logits, target)\`** is its \`.apply\` (given).
- No \`dist.all_gather\` and no \`gather_from_tp\` anywhere in the file: full-vocabulary logits never exist
  on one rank, not even in the self-test, where the parent concatenates the shards each rank returned.

The self-test builds a dense tied LM (\`nn.Embedding(32, 16)\`, one step-2 \`DenseBlock\`, \`ln_f\`, logits
\`h @ wteᵀ\`) with seed 0 and its parallel twin on \`p = 2\` and \`p = 4\`. It checks that each rank's
logits are \`(B, T, 32 / p)\`, the loss on every rank against \`F.cross_entropy\` on the dense logits, the
concatenated logits, the tied table's gradient (embedding plus head, shard by shard), replicated and
sharded block gradients, three all-reduces in the model's forward (embedding, attention, MLP), and three
all-reduces of \`B · T\` floats and no all-gather in the loss. A second case feeds logits spread by 30
with one at 1,000, where a naive \`exp\` overflows float32, and compares the per-token loss and the gradient
\`softmax − one_hot\` with \`F.cross_entropy\`. Tolerance \`1e-5\`; then \`PASS\`.

> The softmax needs only two numbers from the whole vocabulary, a max and a sum, plus the target's
> logit from its one owner. Three all-reduces of one float per token replace a gather of \`V\` floats.`,
  hints: [
    'The embedding is a row-parallel layer along the vocabulary (a one-hot `(…, V)` times the table, with `V` split): a foreign id looks up row 0 (any valid row) and then has its output zeroed, so the all-reduce sums exactly one non-zero row per token. Zeroing the output, not just the index, is what makes it correct.',
    'In the loss, compute the mask and `local = (target - start).masked_fill(mask, 0)` once: forward uses it to `gather(-1, local.unsqueeze(-1))` the target logit (then zeroes it where masked), backward uses it to subtract 1 at the same place. Do the MAX all-reduce before shifting; the two SUMs can go in either order.',
    'Backward: clone the saved softmax, subtract 1 at `local` only where this rank owns the target (`scatter_add_` of `-(~mask)` as a float), scale by `grad_loss.unsqueeze(-1)`, and return `None` for the target.',
  ],
  checks: [
    {
      id: 'vocab-range',
      title: 'Each rank owns a contiguous V / p range',
      detail:
        '`vocab_range` asserts divisibility and returns `(rank * per_rank, (rank + 1) * per_rank)`; the embedding and the loss both use it, so a rank’s table rows and its logits are the same ids.',
      match: {
        python: {
          all: [/rank\s*\*\s*\w+\s*,\s*\(\s*rank\s*\+\s*1\s*\)\s*\*\s*\w+/, /vocab_size\s*%\s*world\s*==\s*0/],
        },
      },
    },
    {
      id: 'embedding-mask',
      title: 'The embedding masks foreign ids, zeroes their rows and all-reduces',
      detail:
        'Ids below `self.start` or at or above `self.end` are mapped to a valid local index and their output rows set to zero before `reduce_from_tp`, so exactly one rank contributes each token’s vector.',
      match: {
        python: {
          order: [
            /class VocabParallelEmbedding/,
            /<\s*self\.start|>=\s*self\.end/,
            /F\.embedding\(|self\.weight\[/,
            /masked_fill\(|torch\.where\(|\*\s*~|\*\s*\(\s*~/,
            /reduce_from_tp\(\s*\w+\s*\)|ReduceFromTP\.apply\(/,
          ],
        },
      },
    },
    {
      id: 'tied-head-no-gather',
      title: 'The tied head returns V / p logits, never gathered',
      detail:
        '`parallel_lm_logits` is `F.linear(copy_to_tp(hidden), weight)` on the embedding shard. No `dist.all_gather` and no `gather_from_tp` anywhere in the file: full-vocabulary logits never exist on one rank.',
      match: {
        python: {
          order: [
            /def parallel_lm_logits/,
            /copy_to_tp\(|CopyToTP\.apply\(/,
            /F\.linear\(|torch\.matmul\(|@\s*\w+\.t\(\)/,
          ],
          none: [/all_gather\(/, /gather_from_tp/, /GatherFromTP/],
        },
      },
    },
    {
      id: 'global-max',
      title: 'The max is all-reduced with MAX before the shift',
      detail:
        'Each rank takes the max of its `V / p` logits, `dist.all_reduce(…, op=dist.ReduceOp.MAX)` makes it the global max, and only then is it subtracted, so `exp` never overflows and every rank shifts by the same `m`.',
      match: {
        python: {
          all: [/dist\.all_reduce\([^\n]*ReduceOp\.MAX/],
          order: [
            /\.max\(|torch\.max\(|\.amax\(/,
            /ReduceOp\.MAX/,
            /-\s*\w+\.unsqueeze\(\s*-1\s*\)|-\s*\w+\[\s*\.\.\.\s*,\s*None\s*\]/,
          ],
        },
      },
    },
    {
      id: 'target-owner',
      title: 'Only the target’s owner contributes its logit',
      detail:
        'The target logit is picked with `gather` at the local index, set to zero on every rank that does not own the target, and summed with `ReduceOp.SUM`.',
      match: {
        python: {
          order: [
            /<\s*start|>=\s*end|<\s*self\.start/,
            /\.gather\(|torch\.gather\(/,
            /masked_fill\(|torch\.where\(|\*\s*~|\*\s*\(\s*~/,
            /dist\.all_reduce\([^\n]*SUM|dist\.all_reduce\(\s*\w+\s*\)/,
          ],
        },
      },
    },
    {
      id: 'log-sum-exp',
      title: 'Loss is log of the all-reduced sum of exps minus the target logit',
      detail:
        'The shifted logits are exponentiated and summed locally, the sum is all-reduced, and `loss = log(sum_exp) - target_logit`, the same on every rank.',
      match: {
        python: {
          order: [
            /ReduceOp\.MAX/,
            /\.exp\(|torch\.exp\(/,
            /\.sum\(\s*(?:dim\s*=\s*)?-1\s*\)/,
            /dist\.all_reduce\(/,
            /torch\.log\(|\.log\(\)/,
          ],
        },
      },
    },
    {
      id: 'custom-backward',
      title: 'Backward is softmax minus one-hot on the shard',
      detail:
        'A `torch.autograd.Function` saves this shard’s softmax; `backward` subtracts 1 at the target only on the owning rank (`scatter_add_`, `scatter_`, `index_put_` or an indexed `-=`), scales by `grad_loss` and returns `None` for the target.',
      match: {
        python: {
          all: [
            /ctx\.save_for_backward\(/,
            /def backward\(\s*ctx[^)]*\)[^\n]*:\s*\n(?:[ \t]{8,}[^\n]*\n|[ \t]*\n)*?[ \t]{8,}[^\n]*(?:scatter_add_\(|scatter_\(|index_put_\(|\]\s*-=|one_hot\()/,
            /return\s+[^\n]*,\s*None\b/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Megatron-LM tensor parallelism, part 3: the vocabulary-parallel embedding, tied head and cross-entropy."""

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from tp_block import CollectiveCounter, DenseBlock, ParallelBlock
from tp_linear import copy_to_tp, launch, reduce_from_tp, tp_rank, tp_world


def vocab_range(vocab_size: int, rank: int, world: int) -> tuple[int, int]:
    """The ids [start, end) that \`rank\` owns."""
    raise NotImplementedError("TODO: assert divisibility; the rank's contiguous range of V / p ids")


class VocabParallelEmbedding(nn.Module):
    """Rows [start, end) of the token table; foreign ids contribute zero, one all-reduce fills them in."""

    def __init__(self, num_embeddings: int, embedding_dim: int):
        super().__init__()
        # TODO: self.num_embeddings; self.start, self.end from vocab_range; self.weight of shape (end - start, dim).
        raise NotImplementedError("TODO: the vocabulary shard")

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: mask foreign ids, look up local rows, zero the foreign rows, g")

    @classmethod
    def from_dense(cls, dense: nn.Embedding) -> "VocabParallelEmbedding":
        raise NotImplementedError("TODO: copy rows [start, end) of dense.weight")


def parallel_lm_logits(hidden: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    """The tied head on this rank's rows of the token table: (B, T, d) -> (B, T, V / p). Never gathered."""
    raise NotImplementedError("TODO: f, then the local matmul against this rank's rows")


class VocabParallelCrossEntropy(torch.autograd.Function):
    """Per-token cross-entropy over logits split by vocabulary, with three all-reduces of one float per token."""

    @staticmethod
    def forward(ctx, logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        # TODO: the global max (MAX over ranks), shift; the target logit (only its owner contributes,
        # SUM over ranks); the sum of exps (SUM over ranks); loss = log(sum_exp) - target_logit.
        # Save the local softmax and what backward needs to subtract the one-hot.
        raise NotImplementedError("TODO: the vocab-parallel loss")

    @staticmethod
    def backward(ctx, grad_loss: torch.Tensor):
        raise NotImplementedError("TODO: softmax minus one-hot on this shard, times grad_loss")


def vocab_parallel_cross_entropy(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """logits (..., V / p) float32 on each rank, target (...) int64 global ids -> loss (...), the same on every rank."""
    return VocabParallelCrossEntropy.apply(logits, target)


# ---- self-test ---------------------------------------------------------------------------------

V, D, HEADS, D_FF, B, T = 32, 16, 4, 64, 2, 6


class DenseLM(nn.Module):
    """Reference: token table, one block, final LayerNorm, head tied to the table."""

    def __init__(self):
        super().__init__()
        self.wte = nn.Embedding(V, D)
        self.block = DenseBlock(D, HEADS, D_FF, block_size=T)
        self.ln_f = nn.LayerNorm(D)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        return F.linear(self.ln_f(self.block(self.wte(ids))), self.wte.weight)


class ParallelLM(nn.Module):
    def __init__(self, dense: DenseLM):
        super().__init__()
        self.wte = VocabParallelEmbedding.from_dense(dense.wte)
        self.block = ParallelBlock.from_dense(dense.block)
        self.ln_f = nn.LayerNorm(D)
        self.ln_f.load_state_dict(dense.ln_f.state_dict())

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        return parallel_lm_logits(self.ln_f(self.block(self.wte(ids))), self.wte.weight)


def _dense_case():
    torch.manual_seed(0)
    model = DenseLM()
    ids = torch.randint(0, V, (B, T))
    targets = torch.randint(0, V, (B, T))
    loose = torch.randn(B, T, V) * 30.0  # spread logits: exp() overflows float32 without the max shift
    loose[0, 0, 3] = 1000.0
    return model, ids, targets, loose


def _worker(rank: int, world: int) -> dict:
    dense, ids, targets, loose = _dense_case()
    model = ParallelLM(dense)
    with CollectiveCounter() as fwd:
        logits = model(ids)
    loss = vocab_parallel_cross_entropy(logits, targets).mean()
    loss.backward()

    shard = loose.chunk(world, dim=-1)[rank].clone().requires_grad_()
    with CollectiveCounter() as ce:
        loose_loss = vocab_parallel_cross_entropy(shard, targets)
    loose_loss.sum().backward()
    return {
        "logits": logits.detach(),
        "loss": loss.detach(),
        "grads": {n: p.grad for n, p in model.named_parameters()},
        "fwd_all_reduces": fwd.count("all_reduce"),
        "ce": (ce.count("all_reduce"), ce.count("all_gather"), ce.bytes()),
        "loose_loss": loose_loss.detach(),
        "loose_grad": shard.grad,
    }


def _check(name: str, got: torch.Tensor, want: torch.Tensor) -> None:
    assert got.shape == want.shape, f"{name}: shape {tuple(got.shape)} != {tuple(want.shape)}"
    assert torch.allclose(got, want, atol=1e-5, rtol=1e-4), f"{name}: max err {(got - want).abs().max():.2e}"


if __name__ == "__main__":
    dense, ids, targets, loose = _dense_case()
    logits_ref = dense(ids)
    loss_ref = F.cross_entropy(logits_ref.view(-1, V), targets.view(-1))
    loss_ref.backward()
    loose_ref = loose.clone().requires_grad_()
    loose_loss_ref = F.cross_entropy(loose_ref.view(-1, V), targets.view(-1), reduction="none").view(B, T)
    loose_loss_ref.sum().backward()
    assert not torch.isfinite(loose.exp()).all(), "the stability case must overflow a naive exp"

    for world in (2, 4):
        ranks = launch(_worker, world)
        for r in ranks:
            assert r["logits"].shape == (B, T, V // world), "a rank holds only V / p logits per token"
            _check(f"p={world} loss on every rank vs F.cross_entropy", r["loss"], loss_ref.detach())
            _check(f"p={world} stable per-token loss", r["loose_loss"], loose_loss_ref.detach())
        _check(f"p={world} gathered logits", torch.cat([r["logits"] for r in ranks], dim=-1), logits_ref.detach())
        _check(
            f"p={world} softmax minus one-hot, shard by shard",
            torch.cat([r["loose_grad"] for r in ranks], dim=-1),
            loose_ref.grad,
        )
        _check(
            f"p={world} tied table grad (embedding + head)",
            torch.cat([r["grads"]["wte.weight"] for r in ranks], dim=0),
            dense.wte.weight.grad,
        )
        for name in ("ln_f.weight", "ln_f.bias", "block.ln1.weight", "block.mlp.proj.bias"):
            want = dict(dense.named_parameters())[name].grad
            for r in ranks:
                _check(f"p={world} replicated {name} grad", r["grads"][name], want)
        _check(
            f"p={world} block fc grad",
            torch.cat([r["grads"]["block.mlp.fc.weight"] for r in ranks], dim=0),
            dense.block.mlp.fc.weight.grad,
        )
        assert ranks[0]["fwd_all_reduces"] == 3, "embedding + attention + MLP: three all-reduces in the forward"
        assert ranks[0]["ce"] == (3, 0, 3 * B * T * 4), f"cross-entropy collectives {ranks[0]['ce']}: want 3 of B*T floats"
        print(f"p={world}: loss and gradients match F.cross_entropy on {V} logits; each rank held {V // world}")
    print("PASS")
`,
      solution: `"""Megatron-LM tensor parallelism, part 3: the vocabulary-parallel embedding, tied head and cross-entropy."""

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F

from tp_block import CollectiveCounter, DenseBlock, ParallelBlock
from tp_linear import copy_to_tp, launch, reduce_from_tp, tp_rank, tp_world


def vocab_range(vocab_size: int, rank: int, world: int) -> tuple[int, int]:
    """The ids [start, end) that \`rank\` owns."""
    assert vocab_size % world == 0, f"vocab_size={vocab_size} is not divisible by {world} ranks"
    per_rank = vocab_size // world
    return rank * per_rank, (rank + 1) * per_rank


class VocabParallelEmbedding(nn.Module):
    """Rows [start, end) of the token table; foreign ids contribute zero, one all-reduce fills them in."""

    def __init__(self, num_embeddings: int, embedding_dim: int):
        super().__init__()
        self.num_embeddings = num_embeddings
        self.start, self.end = vocab_range(num_embeddings, tp_rank(), tp_world())
        self.weight = nn.Parameter(torch.empty(self.end - self.start, embedding_dim).normal_(0.0, 0.02))

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        foreign = (ids < self.start) | (ids >= self.end)
        local = (ids - self.start).masked_fill(foreign, 0)
        out = F.embedding(local, self.weight)
        out = out.masked_fill(foreign.unsqueeze(-1), 0.0)
        return reduce_from_tp(out)

    @classmethod
    def from_dense(cls, dense: nn.Embedding) -> "VocabParallelEmbedding":
        emb = cls(dense.num_embeddings, dense.embedding_dim)
        with torch.no_grad():
            emb.weight.copy_(dense.weight[emb.start : emb.end])
        return emb


def parallel_lm_logits(hidden: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    """The tied head on this rank's rows of the token table: (B, T, d) -> (B, T, V / p). Never gathered."""
    return F.linear(copy_to_tp(hidden), weight)


class VocabParallelCrossEntropy(torch.autograd.Function):
    """Per-token cross-entropy over logits split by vocabulary, with three all-reduces of one float per token."""

    @staticmethod
    def forward(ctx, logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        start, end = vocab_range(logits.size(-1) * tp_world(), tp_rank(), tp_world())

        logits_max = logits.max(dim=-1).values
        dist.all_reduce(logits_max, op=dist.ReduceOp.MAX)
        shifted = logits - logits_max.unsqueeze(-1)

        foreign = (target < start) | (target >= end)
        local_target = (target - start).masked_fill(foreign, 0)
        target_logit = shifted.gather(-1, local_target.unsqueeze(-1)).squeeze(-1)
        target_logit = target_logit.masked_fill(foreign, 0.0)
        dist.all_reduce(target_logit, op=dist.ReduceOp.SUM)

        exp = shifted.exp()
        sum_exp = exp.sum(dim=-1)
        dist.all_reduce(sum_exp, op=dist.ReduceOp.SUM)

        loss = torch.log(sum_exp) - target_logit
        softmax = exp / sum_exp.unsqueeze(-1)
        ctx.save_for_backward(softmax, foreign, local_target)
        return loss

    @staticmethod
    def backward(ctx, grad_loss: torch.Tensor):
        softmax, foreign, local_target = ctx.saved_tensors
        grad = softmax.clone()
        owned = (~foreign).to(grad.dtype).unsqueeze(-1)
        grad.scatter_add_(-1, local_target.unsqueeze(-1), -owned)
        return grad * grad_loss.unsqueeze(-1), None


def vocab_parallel_cross_entropy(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """logits (..., V / p) float32 on each rank, target (...) int64 global ids -> loss (...), the same on every rank."""
    return VocabParallelCrossEntropy.apply(logits, target)


# ---- self-test ---------------------------------------------------------------------------------

V, D, HEADS, D_FF, B, T = 32, 16, 4, 64, 2, 6


class DenseLM(nn.Module):
    """Reference: token table, one block, final LayerNorm, head tied to the table."""

    def __init__(self):
        super().__init__()
        self.wte = nn.Embedding(V, D)
        self.block = DenseBlock(D, HEADS, D_FF, block_size=T)
        self.ln_f = nn.LayerNorm(D)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        return F.linear(self.ln_f(self.block(self.wte(ids))), self.wte.weight)


class ParallelLM(nn.Module):
    def __init__(self, dense: DenseLM):
        super().__init__()
        self.wte = VocabParallelEmbedding.from_dense(dense.wte)
        self.block = ParallelBlock.from_dense(dense.block)
        self.ln_f = nn.LayerNorm(D)
        self.ln_f.load_state_dict(dense.ln_f.state_dict())

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        return parallel_lm_logits(self.ln_f(self.block(self.wte(ids))), self.wte.weight)


def _dense_case():
    torch.manual_seed(0)
    model = DenseLM()
    ids = torch.randint(0, V, (B, T))
    targets = torch.randint(0, V, (B, T))
    loose = torch.randn(B, T, V) * 30.0  # spread logits: exp() overflows float32 without the max shift
    loose[0, 0, 3] = 1000.0
    return model, ids, targets, loose


def _worker(rank: int, world: int) -> dict:
    dense, ids, targets, loose = _dense_case()
    model = ParallelLM(dense)
    with CollectiveCounter() as fwd:
        logits = model(ids)
    loss = vocab_parallel_cross_entropy(logits, targets).mean()
    loss.backward()

    shard = loose.chunk(world, dim=-1)[rank].clone().requires_grad_()
    with CollectiveCounter() as ce:
        loose_loss = vocab_parallel_cross_entropy(shard, targets)
    loose_loss.sum().backward()
    return {
        "logits": logits.detach(),
        "loss": loss.detach(),
        "grads": {n: p.grad for n, p in model.named_parameters()},
        "fwd_all_reduces": fwd.count("all_reduce"),
        "ce": (ce.count("all_reduce"), ce.count("all_gather"), ce.bytes()),
        "loose_loss": loose_loss.detach(),
        "loose_grad": shard.grad,
    }


def _check(name: str, got: torch.Tensor, want: torch.Tensor) -> None:
    assert got.shape == want.shape, f"{name}: shape {tuple(got.shape)} != {tuple(want.shape)}"
    assert torch.allclose(got, want, atol=1e-5, rtol=1e-4), f"{name}: max err {(got - want).abs().max():.2e}"


if __name__ == "__main__":
    dense, ids, targets, loose = _dense_case()
    logits_ref = dense(ids)
    loss_ref = F.cross_entropy(logits_ref.view(-1, V), targets.view(-1))
    loss_ref.backward()
    loose_ref = loose.clone().requires_grad_()
    loose_loss_ref = F.cross_entropy(loose_ref.view(-1, V), targets.view(-1), reduction="none").view(B, T)
    loose_loss_ref.sum().backward()
    assert not torch.isfinite(loose.exp()).all(), "the stability case must overflow a naive exp"

    for world in (2, 4):
        ranks = launch(_worker, world)
        for r in ranks:
            assert r["logits"].shape == (B, T, V // world), "a rank holds only V / p logits per token"
            _check(f"p={world} loss on every rank vs F.cross_entropy", r["loss"], loss_ref.detach())
            _check(f"p={world} stable per-token loss", r["loose_loss"], loose_loss_ref.detach())
        _check(f"p={world} gathered logits", torch.cat([r["logits"] for r in ranks], dim=-1), logits_ref.detach())
        _check(
            f"p={world} softmax minus one-hot, shard by shard",
            torch.cat([r["loose_grad"] for r in ranks], dim=-1),
            loose_ref.grad,
        )
        _check(
            f"p={world} tied table grad (embedding + head)",
            torch.cat([r["grads"]["wte.weight"] for r in ranks], dim=0),
            dense.wte.weight.grad,
        )
        for name in ("ln_f.weight", "ln_f.bias", "block.ln1.weight", "block.mlp.proj.bias"):
            want = dict(dense.named_parameters())[name].grad
            for r in ranks:
                _check(f"p={world} replicated {name} grad", r["grads"][name], want)
        _check(
            f"p={world} block fc grad",
            torch.cat([r["grads"]["block.mlp.fc.weight"] for r in ranks], dim=0),
            dense.block.mlp.fc.weight.grad,
        )
        assert ranks[0]["fwd_all_reduces"] == 3, "embedding + attention + MLP: three all-reduces in the forward"
        assert ranks[0]["ce"] == (3, 0, 3 * B * T * 4), f"cross-entropy collectives {ranks[0]['ce']}: want 3 of B*T floats"
        print(f"p={world}: loss and gradients match F.cross_entropy on {V} logits; each rank held {V // world}")
    print("PASS")
`,
    },
  },
  debrief: `This is Megatron's \`VocabParallelEmbedding\` and \`_VocabParallelCrossEntropy\` in about sixty lines.
The embedding is row parallelism along the vocabulary (a one-hot times the table, the contracted \`V\` split): one all-reduce of \`B · T · d\` assembles each
token's vector from its one owner, and its backward needs nothing, because the gradient of a sum with
respect to each term is the identity and a foreign row's gradient is zero by construction. The loss is
the log-sum-exp trick distributed: the max and the sum are the only global facts the softmax needs, so
the traffic is three all-reduces of \`B · T\` floats (12 bytes per token) instead of an all-gather of
\`V / p\` floats from each rank (about 513 KB per token in fp32 at Llama 3's vocabulary of 128,256), and no
rank ever allocates \`B · T · V\`. The backward is local because the gradient of cross-entropy is
\`softmax − one_hot\`, and both pieces of it already sit on the right shard. Tying the head to the embedding
shard is what makes the two ends line up: the rows a rank looks up are the rows it scores, and their
gradient accumulates both uses with no communication. Megatron adds label smoothing
(\`label_smoothing\` in \`VocabParallelCrossEntropy\`), computes \`exp\` in place on the logits to save one
\`B · T · V / p\` buffer, pads the vocabulary so it divides \`p\` (\`make_vocab_size_divisible_by\`), and with
sequence parallelism all-gathers the sequence-split hidden states in front of the head in place of f. Fused
cross-entropy kernels (Liger's chunked one, Apple's cut cross-entropy) go one step further: they fuse the
head matmul into the loss and never hold even the whole \`V / p\` shard of logits at once.`,
};
