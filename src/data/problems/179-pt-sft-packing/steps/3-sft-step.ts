import type {Step} from '@/lib/types';

export const sftStepStep: Step = {
  id: 'sft-step',
  title: 'Gradient accumulation normalised by target tokens',
  concept: 'pytorch',
  file: 'sft_step',
  focus: ['count', 'loss-sum', 'backward', 'clip-step'],
  task: `## Task

Write \`sft_step.py\` (\`from sft_packing import TinyCausalLM, batch_logits, conversations, pack\` and \`from sft_template import IGNORE_INDEX, render\`). A step's batch rarely fits in memory, so it is split into micro-batches whose gradients add up in \`.grad\`. The step must equal one full-batch step: the mean loss over every target token of the whole batch.

\`\`\`text
full batch          L = (Σ over all targets ℓ) / N          N = targets in all micro-batches
token-normalised    Σ_k (Σ over targets in k of ℓ) / N   =  L
mean of means       (1/K) Σ_k (Σ over targets in k of ℓ) / N_k   ≠  L unless every N_k = N / K
\`\`\`

- \`count_targets(batch) -> int\`: the labels other than \`IGNORE_INDEX\` after the shift, in \`batch["labels"][:, 1:]\`.
- \`token_loss_sum(model, batch) -> 0-d tensor\`: \`F.cross_entropy\` of \`logits[:, :-1]\` against \`labels[:, 1:]\` with \`ignore_index=IGNORE_INDEX\` and \`reduction="sum"\`.
- \`accumulate_gradients(model, micro_batches) -> float\`: first \`num_items_in_batch\`, the sum of \`count_targets\` over **all** micro-batches, before any backward; then, per micro-batch, \`(token_loss_sum(model, mb) / num_items_in_batch).backward()\`. It returns the summed loss over \`num_items_in_batch\` as a Python float, and adds to \`.grad\` without zeroing it.
- \`sft_step(model, optimizer, micro_batches, max_grad_norm=1.0) -> float\`: \`optimizer.zero_grad(set_to_none=True)\`, then \`accumulate_gradients(model, micro_batches)\`, then \`torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)\`, then \`optimizer.step()\`. Clipping sees the whole accumulated gradient, never one micro-batch's.
- **Forbidden:** each micro-batch's mean loss divided by the number of micro-batches. That is the mean of means: every micro-batch weighs the same whatever its target count, so a token in a short micro-batch counts for more.
- **Self-test**: the 16 packed chats are split into micro-batches of 1, 2 and 5 rows, with 216, 390 and 860 target tokens. In float64 the accumulated gradient equals the full-batch gradient (\`F.cross_entropy\`'s default mean over all 1,466 targets) within 1e-6 and the loss within 1e-9, and one row per micro-batch gives the same gradient. The mean of means is off by more than 1 % of the gradient's norm (12.1 % here). 40 \`sft_step\` calls with AdamW (lr 3e-3) at least halve the loss.

> Gradient accumulation is a sum split over time. The only division that keeps it exact is by a count known before the first micro-batch runs.`,
  hints: [
    'Compute `num_items_in_batch` in its own pass over `micro_batches`, before the loop that calls `backward`: the count must include micro-batches that have not run yet.',
    '`F.cross_entropy(logits[:, :-1].reshape(-1, V), batch["labels"][:, 1:].reshape(-1), ignore_index=IGNORE_INDEX, reduction="sum")`: ignored positions add 0 to the sum and to the gradient.',
    'Add `loss_sum.item()` to a float so no graph outlives its micro-batch. Clip after `accumulate_gradients` returns and before `optimizer.step()`.',
  ],
  checks: [
    {
      id: 'sum-reduction',
      title: 'Per-token losses are summed',
      detail:
        '`reduction="sum"` in `token_loss_sum`: a micro-batch contributes its total, and the one division happens by the global count.',
      match: {python: {all: [/reduction\s*=\s*["']sum["']/]}},
    },
    {
      id: 'count-targets',
      title: 'Targets are the labels that are not ignored',
      detail:
        '`count_targets` counts `labels[:, 1:] != IGNORE_INDEX`: padding, prompts and headers are not targets, and they vary a lot between micro-batches.',
      match: {python: {all: [/(?:!=|\.ne\()\s*(?:IGNORE_INDEX|-100)\b|>=\s*0\b/]}},
    },
    {
      id: 'global-normaliser',
      title: 'Divided by the count over all micro-batches',
      detail:
        "`num_items_in_batch` is the target count of every micro-batch together, and each summed loss is divided by it, as Hugging Face's fix does.",
      match: {python: {all: [/num_items_in_batch\s*=/, /\/\s*num_items_in_batch\b/]}},
    },
    {
      id: 'count-first',
      title: 'The count comes before the first backward',
      detail:
        '`num_items_in_batch` is assigned before any `.backward()`: dividing by a running count would weigh the first micro-batch by its own size only.',
      match: {python: {order: [/num_items_in_batch\s*=/, /\.backward\(\)/]}},
    },
    {
      id: 'clip-then-step',
      title: 'Accumulate, clip the total, then step',
      detail:
        '`sft_step` calls `accumulate_gradients(model, micro_batches)`, then `clip_grad_norm_(model.parameters(), max_grad_norm)`, then `optimizer.step()`: one clip of the full gradient.',
      match: {
        python: {
          all: [/clip_grad_norm_\(\s*model\.parameters\(\)\s*,\s*max_grad_norm\s*\)/],
          order: [
            /accumulate_gradients\(\s*model\s*,\s*micro_batches\s*\)/,
            /clip_grad_norm_\(/,
            /optimizer\.step\(\)/,
          ],
        },
      },
    },
    {
      id: 'no-trainer',
      title: 'No trainer library',
      detail: 'No `trl`, `transformers` or `accelerate`: the accumulation loop is the thing written here.',
      match: {python: {none: [/\bfrom\s+trl\b|\bimport\s+trl\b/, /\btransformers\b/, /\baccelerate\b/]}},
    },
  ],
  code: {
    python: {
      starter: `"""SFT, part 3: one optimizer step over several micro-batches, the loss normalised by every target token in all of them."""

import torch
import torch.nn.functional as F

from sft_packing import TinyCausalLM, batch_logits, conversations, pack
from sft_template import IGNORE_INDEX, render


def count_targets(batch: dict) -> int:
    """Labelled next-token targets in a batch: the positions the loss is taken over."""
    raise NotImplementedError("TODO: count the labels that are not ignored, after the shift")


def token_loss_sum(model: TinyCausalLM, batch: dict) -> torch.Tensor:
    """Sum (not mean) of the cross-entropy of logits[t] against labels[t + 1] over every labelled target; 0-d."""
    raise NotImplementedError("TODO: summed cross-entropy of shifted logits against shifted labels")


def accumulate_gradients(model: TinyCausalLM, micro_batches: list) -> float:
    """Adds to every .grad the gradient of the token-mean loss over all micro-batches together; returns that loss."""
    # TODO: count the targets of every micro-batch before any backward.
    # TODO: per micro-batch: backward of its summed loss divided by that global count.
    raise NotImplementedError("TODO: normalise every micro-batch by the token count of all of them")


def sft_step(model: TinyCausalLM, optimizer: torch.optim.Optimizer, micro_batches: list, max_grad_norm: float = 1.0) -> float:
    """zero_grad, accumulate over the micro-batches, clip the global norm, one optimizer step. Returns the loss."""
    raise NotImplementedError("TODO: zero_grad, accumulate, clip, step")


def merge(micro_batches: list) -> dict:
    """The micro-batches as one batch: rows stacked."""
    out = {key: torch.cat([mb[key] for mb in micro_batches]) for key in ("input_ids", "labels", "position_ids")}
    out["cu_seqlens"] = [cu for mb in micro_batches for cu in mb["cu_seqlens"]]
    return out


def rows(batch: dict, a: int, b: int) -> dict:
    """Rows a..b-1 of a packed batch."""
    out = {key: batch[key][a:b] for key in ("input_ids", "labels", "position_ids")}
    out["cu_seqlens"] = batch["cu_seqlens"][a:b]
    return out


def grads(model: TinyCausalLM) -> torch.Tensor:
    return torch.cat([p.grad.reshape(-1) for p in model.parameters()])


if __name__ == "__main__":
    torch.manual_seed(0)
    S = 512
    batch = pack([render(chat, max_len=S) for chat in conversations(16)], S)
    R = batch["input_ids"].shape[0]
    micro_batches = [rows(batch, 0, 1), rows(batch, 1, 3), rows(batch, 3, R)]
    counts = [count_targets(mb) for mb in micro_batches]
    assert len(set(counts)) == len(counts), counts  # unequal token counts are the case that matters
    full = merge(micro_batches)
    model = TinyCausalLM(max_pos=S).double()

    # Reference: the whole batch at once, mean over every target token.
    model.zero_grad(set_to_none=True)
    logits = batch_logits(model, full)
    V = logits.shape[-1]
    ref = F.cross_entropy(logits[:, :-1].reshape(-1, V), full["labels"][:, 1:].reshape(-1), ignore_index=IGNORE_INDEX)
    ref.backward()
    g_full = grads(model)

    model.zero_grad(set_to_none=True)
    loss = accumulate_gradients(model, micro_batches)
    g_acc = grads(model)
    err = (g_acc - g_full).abs().max().item()
    assert err <= 1e-6 and abs(loss - ref.item()) <= 1e-9, (err, loss, ref.item())

    # One row per micro-batch is the same gradient again.
    model.zero_grad(set_to_none=True)
    accumulate_gradients(model, [rows(batch, r, r + 1) for r in range(R)])
    assert (grads(model) - g_full).abs().max().item() <= 1e-6

    # The naive loop: each micro-batch's own token mean, divided by the number of micro-batches.
    model.zero_grad(set_to_none=True)
    naive_loss = 0.0
    for mb in micro_batches:
        lg = batch_logits(model, mb)
        mean = F.cross_entropy(lg[:, :-1].reshape(-1, V), mb["labels"][:, 1:].reshape(-1), ignore_index=IGNORE_INDEX)
        (mean / len(micro_batches)).backward()
        naive_loss += mean.item() / len(micro_batches)
    g_naive = grads(model)
    off = ((g_naive - g_full).norm() / g_full.norm()).item()
    assert off > 1e-2, off

    # A few real steps on the packed batch: the loss on assistant tokens falls.
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    losses = [sft_step(model, opt, micro_batches) for _ in range(40)]
    assert losses[-1] < 0.5 * losses[0], (losses[0], losses[-1])

    print(f"micro-batch target tokens {counts}, {sum(counts)} in all")
    print(f"accumulated vs full batch: max gradient difference {err:.1e}, loss {loss:.4f} = {ref.item():.4f}")
    print(f"naive mean of means: loss {naive_loss:.4f}, gradient off by {off:.1%} of its norm")
    print(f"sft_step x 40: loss {losses[0]:.3f} -> {losses[-1]:.3f}")
    print("PASS")
`,
      solution: `"""SFT, part 3: one optimizer step over several micro-batches, the loss normalised by every target token in all of them."""

import torch
import torch.nn.functional as F

from sft_packing import TinyCausalLM, batch_logits, conversations, pack
from sft_template import IGNORE_INDEX, render


def count_targets(batch: dict) -> int:
    """Labelled next-token targets in a batch: the positions the loss is taken over."""
    return int((batch["labels"][:, 1:] != IGNORE_INDEX).sum())


def token_loss_sum(model: TinyCausalLM, batch: dict) -> torch.Tensor:
    """Sum (not mean) of the cross-entropy of logits[t] against labels[t + 1] over every labelled target; 0-d."""
    logits = batch_logits(model, batch)
    V = logits.shape[-1]
    return F.cross_entropy(
        logits[:, :-1].reshape(-1, V),
        batch["labels"][:, 1:].reshape(-1),
        ignore_index=IGNORE_INDEX,
        reduction="sum",
    )


def accumulate_gradients(model: TinyCausalLM, micro_batches: list) -> float:
    """Adds to every .grad the gradient of the token-mean loss over all micro-batches together; returns that loss."""
    num_items_in_batch = sum(count_targets(mb) for mb in micro_batches)
    total = 0.0
    for mb in micro_batches:
        loss_sum = token_loss_sum(model, mb)
        (loss_sum / num_items_in_batch).backward()
        total += loss_sum.item()
    return total / num_items_in_batch


def sft_step(model: TinyCausalLM, optimizer: torch.optim.Optimizer, micro_batches: list, max_grad_norm: float = 1.0) -> float:
    """zero_grad, accumulate over the micro-batches, clip the global norm, one optimizer step. Returns the loss."""
    optimizer.zero_grad(set_to_none=True)
    loss = accumulate_gradients(model, micro_batches)
    torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
    optimizer.step()
    return loss


def merge(micro_batches: list) -> dict:
    """The micro-batches as one batch: rows stacked."""
    out = {key: torch.cat([mb[key] for mb in micro_batches]) for key in ("input_ids", "labels", "position_ids")}
    out["cu_seqlens"] = [cu for mb in micro_batches for cu in mb["cu_seqlens"]]
    return out


def rows(batch: dict, a: int, b: int) -> dict:
    """Rows a..b-1 of a packed batch."""
    out = {key: batch[key][a:b] for key in ("input_ids", "labels", "position_ids")}
    out["cu_seqlens"] = batch["cu_seqlens"][a:b]
    return out


def grads(model: TinyCausalLM) -> torch.Tensor:
    return torch.cat([p.grad.reshape(-1) for p in model.parameters()])


if __name__ == "__main__":
    torch.manual_seed(0)
    S = 512
    batch = pack([render(chat, max_len=S) for chat in conversations(16)], S)
    R = batch["input_ids"].shape[0]
    micro_batches = [rows(batch, 0, 1), rows(batch, 1, 3), rows(batch, 3, R)]
    counts = [count_targets(mb) for mb in micro_batches]
    assert len(set(counts)) == len(counts), counts  # unequal token counts are the case that matters
    full = merge(micro_batches)
    model = TinyCausalLM(max_pos=S).double()

    # Reference: the whole batch at once, mean over every target token.
    model.zero_grad(set_to_none=True)
    logits = batch_logits(model, full)
    V = logits.shape[-1]
    ref = F.cross_entropy(logits[:, :-1].reshape(-1, V), full["labels"][:, 1:].reshape(-1), ignore_index=IGNORE_INDEX)
    ref.backward()
    g_full = grads(model)

    model.zero_grad(set_to_none=True)
    loss = accumulate_gradients(model, micro_batches)
    g_acc = grads(model)
    err = (g_acc - g_full).abs().max().item()
    assert err <= 1e-6 and abs(loss - ref.item()) <= 1e-9, (err, loss, ref.item())

    # One row per micro-batch is the same gradient again.
    model.zero_grad(set_to_none=True)
    accumulate_gradients(model, [rows(batch, r, r + 1) for r in range(R)])
    assert (grads(model) - g_full).abs().max().item() <= 1e-6

    # The naive loop: each micro-batch's own token mean, divided by the number of micro-batches.
    model.zero_grad(set_to_none=True)
    naive_loss = 0.0
    for mb in micro_batches:
        lg = batch_logits(model, mb)
        mean = F.cross_entropy(lg[:, :-1].reshape(-1, V), mb["labels"][:, 1:].reshape(-1), ignore_index=IGNORE_INDEX)
        (mean / len(micro_batches)).backward()
        naive_loss += mean.item() / len(micro_batches)
    g_naive = grads(model)
    off = ((g_naive - g_full).norm() / g_full.norm()).item()
    assert off > 1e-2, off

    # A few real steps on the packed batch: the loss on assistant tokens falls.
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    losses = [sft_step(model, opt, micro_batches) for _ in range(40)]
    assert losses[-1] < 0.5 * losses[0], (losses[0], losses[-1])

    print(f"micro-batch target tokens {counts}, {sum(counts)} in all")
    print(f"accumulated vs full batch: max gradient difference {err:.1e}, loss {loss:.4f} = {ref.item():.4f}")
    print(f"naive mean of means: loss {naive_loss:.4f}, gradient off by {off:.1%} of its norm")
    print(f"sft_step x 40: loss {losses[0]:.3f} -> {losses[-1]:.3f}")
    print("PASS")
`,
    },
  },
  debrief: `This is a real bug. In the Hugging Face Trainer, losses changed when gradient accumulation was switched on: first reported in 2021, rediscovered by Benjamin Marie in October 2024. Unsloth traced it to the loss normalisation and shipped a fix in its own trainer on 15 October, and Hugging Face fixed \`transformers\` the next day. Each model's default loss took the mean over its micro-batch, and the Trainer divided that by the number of accumulation steps: the mean of means. The fix passes \`num_items_in_batch\`, the target count of the whole accumulation window, into the loss and divides a summed cross-entropy by it, which is what \`accumulate_gradients\` does. The two agree only when every micro-batch has the same number of targets, and SFT data is the case where they never do. Assistant-only labels make the target count depend on how long the answers are (216 to 860 here), and packing evens out tokens per row, not labelled tokens per row. With the mean of means, a token in the short micro-batch counts four times as much as one in the long one, and the gradient here is 12 % off its true direction and length.

Two details of the loop matter. The count is taken **before** any backward, because the first micro-batch's gradient is already in \`.grad\` when the last one runs. The clip runs **once**, on the sum: clipping each micro-batch would bound pieces of a gradient whose norm nobody computed.

What production adds: under data parallelism every rank holds its own micro-batches, so the count is all-reduced across ranks as well, and the loss is multiplied by the world size because DDP averages gradients over ranks. The same choice appears without accumulation: averaging per sequence and then over sequences (sequence-level normalisation) weighs short answers up, a choice RL losses such as DAPO's token-level policy loss revisit. The Trainer logs the token-normalised loss, so curves with and without accumulation match.`,
};
