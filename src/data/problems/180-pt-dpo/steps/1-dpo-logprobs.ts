import type {Step} from '@/lib/types';

export const dpoLogprobsStep: Step = {
  id: 'dpo-logprobs',
  title: 'Sequence log-probs: shift, gather, mask, one forward',
  concept: 'pytorch',
  file: 'dpo_logprobs',
  focus: ['lm', 'shift-logits', 'log-softmax', 'shift-labels', 'gather', 'mask-sum', 'split'],
  task: `## Task

DPO never samples. Everything it needs from a model is one number per (prompt, response) pair:
\`log π(y | x)\`, the sum over the response tokens of the log-probability the model gave each one. Write
that number, for chosen and rejected responses in one forward pass. \`TinyLM\` (an embedding, one GRU
layer, a vocabulary head) and \`right_pad\` are given; any causal LM whose \`model(input_ids,
attention_mask)\` returns \`(N, T, V)\` logits works the same way.

\`sequence_logprobs(model, input_ids, attention_mask, prompt_lengths) -> (N,) float32\`:

- \`input_ids\`, \`attention_mask\`: \`(N, T)\` long, right padded; \`prompt_lengths\`: \`(N,)\` long.
- Row \`t\` of the logits predicts token \`t + 1\`: take \`logits[:, :-1]\` and \`input_ids[:, 1:]\`.
- \`torch.log_softmax\` over the vocabulary in float32 (\`.float()\` first: bf16 logits lose the small
  differences DPO lives on), then \`torch.gather\` the label's entry: \`(N, T - 1)\` per-token log-probs.
- Mask: a label at position \`p\` counts only if \`attention_mask[:, 1:]\` is 1 there **and**
  \`p >= prompt_length\` (build \`p\` with \`torch.arange\`). Prompt and padding contribute exactly 0.
- Sum over the last axis. Not the mean: DPO's log-ratio is of whole sequences.

\`concatenated_forward(model, batch) -> (chosen_logps, rejected_logps)\`, each \`(B,)\`:

- \`batch\` holds token lists \`{"prompt": [...], "chosen": [...], "rejected": [...]}\`, \`B\` of each.
- Build \`2B\` rows, prompt + chosen for every pair and then prompt + rejected, pad them with one
  \`right_pad\`, run **one** \`sequence_logprobs\`, and split the result at \`B\`.
- Forbidden: \`trl\` and any loss helper that hides the shift or the mask.

The self-test scores three pairs of different lengths and compares every number with a slow reference:
one forward per response token on the unpadded prefix, log-softmax written as \`x - logsumexp(x)\` in
float64 (tolerance \`1e-4\`). It checks that a pair batched alone gives the same numbers (padding and
the other rows change nothing), that moving the prompt boundary changes the sum, and prints \`PASS\`.

> A preference pair becomes two numbers, \`log π(y_w | x)\` and \`log π(y_l | x)\`, and the only ways to get
> them wrong are an off-by-one shift and a mask that lets the prompt or the padding in.`,
  hints: [
    'Shift once and keep the mask aligned with the labels, not the logits: `labels = input_ids[:, 1:]`, `loss_mask = attention_mask[:, 1:].bool()`. Label position `p` (counting from 1) is the token at index `p` of the row.',
    'The prompt test is a broadcast: `torch.arange(1, T)[None, :] >= prompt_lengths[:, None]` is `(N, T - 1)`. Then `torch.gather(logps, 2, labels.unsqueeze(-1)).squeeze(-1)` gives one log-prob per label.',
    'In `concatenated_forward`, `prompts + prompts` lines up with `batch["chosen"] + batch["rejected"]`; the prompt lengths are `[len(p) for p in prompts + prompts]`, and the split is `logps[:B], logps[B:]`.',
  ],
  checks: [
    {
      id: 'shift',
      title: 'Logits and labels shifted by one',
      detail:
        '`logits[:, :-1]` against `input_ids[:, 1:]`: row `t` of the logits is the prediction for token `t + 1`. Without the shift every token is scored by the position that has already seen it.',
      match: {python: {all: [/\[\s*:\s*,\s*:\s*-1\s*(?:,\s*:\s*)?\]/, /input_ids\s*\[\s*:\s*,\s*1\s*:\s*\]/]}},
    },
    {
      id: 'log-softmax',
      title: 'Log-softmax over the vocabulary, in float32',
      detail:
        '`torch.log_softmax(logits.float(), dim=-1)`: normalised log-probabilities, computed in float32 so a bf16 model does not round away the differences between policy and reference.',
      match: {python: {all: [/log_softmax\(/, /\.float\(\)|dtype\s*=\s*torch\.float32/]}},
    },
    {
      id: 'gather',
      title: 'The label’s log-probability gathered',
      detail:
        '`torch.gather(logps, 2, labels.unsqueeze(-1))` picks one entry per position, the token that is actually there. `trl` and its helpers are not used.',
      match: {python: {all: [/\.gather\(|torch\.gather\(/], none: [/from trl\b|import trl\b/]}},
    },
    {
      id: 'prompt-mask',
      title: 'Prompt tokens masked by position',
      detail:
        'A position index from `torch.arange` compared with `prompt_lengths[:, None]`: the prompt is the same for chosen and rejected, and scoring it would add noise to both sides of the log-ratio.',
      match: {
        python: {
          all: [/arange\(/, /prompt_lengths\s*\[\s*:\s*,\s*None\s*\]|prompt_lengths\.(?:unsqueeze|view|reshape)\(/],
        },
      },
    },
    {
      id: 'pad-mask',
      title: 'Padding masked through the shifted attention mask',
      detail:
        '`attention_mask[:, 1:]`, aligned with the labels: a padded row must give the same sum as the row alone, so padding contributes exactly 0.',
      match: {python: {all: [/attention_mask\s*\[\s*:\s*,\s*1\s*:\s*\]/]}},
    },
    {
      id: 'sum',
      title: 'Summed over the response, one number per row',
      detail:
        '`(per_token * loss_mask).sum(-1)`: `log π(y | x)` of the whole response is a sum of token log-probabilities. A mean is a different objective (length-normalised).',
      match: {
        python: {
          all: [/\.sum\(\s*(?:-1|dim\s*=\s*-1|1|dim\s*=\s*1)\s*\)/],
          none: [/\.mean\(\s*(?:-1|dim\s*=\s*-1|1|dim\s*=\s*1)\s*\)/],
        },
      },
    },
    {
      id: 'one-forward',
      title: 'Chosen and rejected in one forward',
      detail:
        '`batch["chosen"] + batch["rejected"]` (or a `torch.cat` of the two) as `2B` rows through one `sequence_logprobs` call, split at `B`: one launch per model per step, and both halves padded the same way.',
      match: {
        python: {all: [/batch\["chosen"\]\s*\+\s*batch\["rejected"\]|torch\.cat\(\s*\[?[^\n]*chosen[^\n]*rejected/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""DPO, part 1: the summed log-probability of each response under a causal LM, chosen and rejected in one forward."""

import torch
import torch.nn as nn

PAD_ID = 0


class TinyLM(nn.Module):
    """A causal language model small enough to train on a CPU: embedding, one GRU layer, a vocabulary head.

    Any causal LM fits the functions below as long as \`model(input_ids, attention_mask)\` returns
    logits of shape (N, T, V) where row t predicts token t + 1 (a Hugging Face model's \`.logits\`).
    """

    def __init__(self, vocab_size: int = 16, d_model: int = 32) -> None:
        super().__init__()
        self.embed = nn.Embedding(vocab_size, d_model)
        self.rnn = nn.GRU(d_model, d_model, batch_first=True)
        self.head = nn.Linear(d_model, vocab_size)

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor | None = None) -> torch.Tensor:
        # Causal by construction, and the padding is on the right, so attention_mask is not needed here.
        h, _ = self.rnn(self.embed(input_ids))
        return self.head(h)


def right_pad(seqs: list[list[int]], pad_id: int = PAD_ID) -> tuple[torch.Tensor, torch.Tensor]:
    """Stack token lists into (N, T) long ids and a (N, T) long mask, padded on the right to the longest."""
    width = max(len(s) for s in seqs)
    ids = torch.full((len(seqs), width), pad_id, dtype=torch.long)
    mask = torch.zeros((len(seqs), width), dtype=torch.long)
    for i, s in enumerate(seqs):
        ids[i, : len(s)] = torch.tensor(s, dtype=torch.long)
        mask[i, : len(s)] = 1
    return ids, mask


def sequence_logprobs(
    model: nn.Module, input_ids: torch.Tensor, attention_mask: torch.Tensor, prompt_lengths: torch.Tensor
) -> torch.Tensor:
    """log p(response | prompt) per row: the sum over response tokens of log p(token | everything before it).

    input_ids, attention_mask: (N, T) long, right padded. prompt_lengths: (N,) long, the number of
    prompt tokens at the start of each row. Returns (N,) float32.
    """
    raise NotImplementedError("TODO: shift by one, log-softmax, gather the labels, mask prompt and padding, sum per row")


def concatenated_forward(model: nn.Module, batch: dict[str, list[list[int]]]) -> tuple[torch.Tensor, torch.Tensor]:
    """One forward over 2B rows (every chosen, then every rejected); returns (chosen_logps, rejected_logps), each (B,)."""
    raise NotImplementedError("TODO: prompt + response rows, chosen then rejected, one right_pad, one forward, split")


if __name__ == "__main__":
    import math

    torch.manual_seed(0)
    model = TinyLM()
    batch = {
        "prompt": [[1, 5, 7], [1, 9], [1, 4, 4, 6, 2]],
        "chosen": [[3, 3, 2], [8, 10, 11, 12], [2]],
        "rejected": [[6], [12, 2], [9, 9, 9, 15]],
    }

    def slow_logp(prompt: list[int], response: list[int]) -> float:
        """One forward per response token on the unpadded prefix, log-softmax written out by hand."""
        total = 0.0
        for t in range(len(response)):
            prefix = torch.tensor([prompt + response[:t]], dtype=torch.long)
            row = model(prefix)[0, -1].double()
            total += (row[response[t]] - torch.logsumexp(row, dim=0)).item()
        return total

    with torch.no_grad():
        chosen, rejected = concatenated_forward(model, batch)
        assert chosen.shape == (3,) and rejected.shape == (3,), (chosen.shape, rejected.shape)
        assert chosen.dtype == torch.float32
        for i in range(3):
            want_c = slow_logp(batch["prompt"][i], batch["chosen"][i])
            want_r = slow_logp(batch["prompt"][i], batch["rejected"][i])
            assert abs(chosen[i].item() - want_c) < 1e-4, (i, chosen[i].item(), want_c)
            assert abs(rejected[i].item() - want_r) < 1e-4, (i, rejected[i].item(), want_r)

        # Batched on its own, a pair gives the same numbers: padding and the other rows change nothing.
        solo_c, solo_r = concatenated_forward(model, {k: v[1:2] for k, v in batch.items()})
        assert abs(solo_c.item() - chosen[1].item()) < 1e-5 and abs(solo_r.item() - rejected[1].item()) < 1e-5

        # The prompt never counts: from position 3 the row is chosen[0]; from position 1 it adds two terms.
        ids, mask = right_pad([[1, 5, 7, 3, 3, 2]])
        whole = sequence_logprobs(model, ids, mask, torch.tensor([1]))
        part = sequence_logprobs(model, ids, mask, torch.tensor([3]))
        assert abs(part.item() - chosen[0].item()) < 1e-5
        assert whole.item() < part.item(), "two more tokens must lower the log-probability"

    # Every response token's log-probability is negative, so a sum over k tokens is below 0.
    assert (chosen < 0).all() and (rejected < 0).all()
    assert math.isfinite(chosen.sum().item())
    print(f"chosen {[round(v, 3) for v in chosen.tolist()]} rejected {[round(v, 3) for v in rejected.tolist()]}")
    print("PASS")
`,
      solution: `"""DPO, part 1: the summed log-probability of each response under a causal LM, chosen and rejected in one forward."""

import torch
import torch.nn as nn

PAD_ID = 0


class TinyLM(nn.Module):
    """A causal language model small enough to train on a CPU: embedding, one GRU layer, a vocabulary head.

    Any causal LM fits the functions below as long as \`model(input_ids, attention_mask)\` returns
    logits of shape (N, T, V) where row t predicts token t + 1 (a Hugging Face model's \`.logits\`).
    """

    def __init__(self, vocab_size: int = 16, d_model: int = 32) -> None:
        super().__init__()
        self.embed = nn.Embedding(vocab_size, d_model)
        self.rnn = nn.GRU(d_model, d_model, batch_first=True)
        self.head = nn.Linear(d_model, vocab_size)

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor | None = None) -> torch.Tensor:
        # Causal by construction, and the padding is on the right, so attention_mask is not needed here.
        h, _ = self.rnn(self.embed(input_ids))
        return self.head(h)


def right_pad(seqs: list[list[int]], pad_id: int = PAD_ID) -> tuple[torch.Tensor, torch.Tensor]:
    """Stack token lists into (N, T) long ids and a (N, T) long mask, padded on the right to the longest."""
    width = max(len(s) for s in seqs)
    ids = torch.full((len(seqs), width), pad_id, dtype=torch.long)
    mask = torch.zeros((len(seqs), width), dtype=torch.long)
    for i, s in enumerate(seqs):
        ids[i, : len(s)] = torch.tensor(s, dtype=torch.long)
        mask[i, : len(s)] = 1
    return ids, mask


def sequence_logprobs(
    model: nn.Module, input_ids: torch.Tensor, attention_mask: torch.Tensor, prompt_lengths: torch.Tensor
) -> torch.Tensor:
    """log p(response | prompt) per row: the sum over response tokens of log p(token | everything before it).

    input_ids, attention_mask: (N, T) long, right padded. prompt_lengths: (N,) long, the number of
    prompt tokens at the start of each row. Returns (N,) float32.
    """
    logits = model(input_ids, attention_mask)
    logits = logits[:, :-1, :].float()
    labels = input_ids[:, 1:]
    loss_mask = attention_mask[:, 1:].bool()
    label_pos = torch.arange(1, input_ids.shape[1], device=input_ids.device)
    loss_mask = loss_mask & (label_pos[None, :] >= prompt_lengths[:, None])
    logps = torch.log_softmax(logits, dim=-1)
    per_token = torch.gather(logps, 2, labels.unsqueeze(-1)).squeeze(-1)
    return (per_token * loss_mask).sum(-1)


def concatenated_forward(model: nn.Module, batch: dict[str, list[list[int]]]) -> tuple[torch.Tensor, torch.Tensor]:
    """One forward over 2B rows (every chosen, then every rejected); returns (chosen_logps, rejected_logps), each (B,)."""
    prompts = batch["prompt"]
    n = len(prompts)
    responses = batch["chosen"] + batch["rejected"]
    rows = [p + r for p, r in zip(prompts + prompts, responses)]
    input_ids, attention_mask = right_pad(rows)
    prompt_lengths = torch.tensor([len(p) for p in prompts + prompts], dtype=torch.long)
    logps = sequence_logprobs(model, input_ids, attention_mask, prompt_lengths)
    return logps[:n], logps[n:]


if __name__ == "__main__":
    import math

    torch.manual_seed(0)
    model = TinyLM()
    batch = {
        "prompt": [[1, 5, 7], [1, 9], [1, 4, 4, 6, 2]],
        "chosen": [[3, 3, 2], [8, 10, 11, 12], [2]],
        "rejected": [[6], [12, 2], [9, 9, 9, 15]],
    }

    def slow_logp(prompt: list[int], response: list[int]) -> float:
        """One forward per response token on the unpadded prefix, log-softmax written out by hand."""
        total = 0.0
        for t in range(len(response)):
            prefix = torch.tensor([prompt + response[:t]], dtype=torch.long)
            row = model(prefix)[0, -1].double()
            total += (row[response[t]] - torch.logsumexp(row, dim=0)).item()
        return total

    with torch.no_grad():
        chosen, rejected = concatenated_forward(model, batch)
        assert chosen.shape == (3,) and rejected.shape == (3,), (chosen.shape, rejected.shape)
        assert chosen.dtype == torch.float32
        for i in range(3):
            want_c = slow_logp(batch["prompt"][i], batch["chosen"][i])
            want_r = slow_logp(batch["prompt"][i], batch["rejected"][i])
            assert abs(chosen[i].item() - want_c) < 1e-4, (i, chosen[i].item(), want_c)
            assert abs(rejected[i].item() - want_r) < 1e-4, (i, rejected[i].item(), want_r)

        # Batched on its own, a pair gives the same numbers: padding and the other rows change nothing.
        solo_c, solo_r = concatenated_forward(model, {k: v[1:2] for k, v in batch.items()})
        assert abs(solo_c.item() - chosen[1].item()) < 1e-5 and abs(solo_r.item() - rejected[1].item()) < 1e-5

        # The prompt never counts: from position 3 the row is chosen[0]; from position 1 it adds two terms.
        ids, mask = right_pad([[1, 5, 7, 3, 3, 2]])
        whole = sequence_logprobs(model, ids, mask, torch.tensor([1]))
        part = sequence_logprobs(model, ids, mask, torch.tensor([3]))
        assert abs(part.item() - chosen[0].item()) < 1e-5
        assert whole.item() < part.item(), "two more tokens must lower the log-probability"

    # Every response token's log-probability is negative, so a sum over k tokens is below 0.
    assert (chosen < 0).all() and (rejected < 0).all()
    assert math.isfinite(chosen.sum().item())
    print(f"chosen {[round(v, 3) for v in chosen.tolist()]} rejected {[round(v, 3) for v in rejected.tolist()]}")
    print("PASS")
`,
    },
  },
  debrief: `This is \`_get_batch_logps\` and \`concatenated_forward\` from the DPO authors' reference trainer; TRL's \`DPOTrainer\` does the same work before its loss. **The shift** is the one fact about causal LMs that everything rests on: the logit at position \`t\` is the model's guess for token \`t + 1\`, so the last logit predicts nothing and the first token is never predicted. **The mask** has two jobs. Padding must contribute 0, or a short response batched next to a long one would get a different score than alone; the self-test checks exactly that. The prompt must contribute 0 because DPO compares two responses to the same prompt: the prompt's log-probability is identical on both sides and cancels in theory, but counting it adds its noise to every number and, for prompts much longer than responses, swamps them. **The sum** is what the derivation asks for: \`π(y | x)\` is a product over tokens, its log a sum. Length-normalised variants (IPO as TRL runs it, SimPO) average instead; that changes the objective, not a detail. **One forward** for chosen and rejected halves the number of model launches and, under FSDP, the number of all-gathers; it also pads both halves to one width, so they see identical numerics. Production adds: labels with \`-100\` on the prompt (the same mask, built at tokenisation), truncation rules for over-long prompts, padding-free packing with per-row position ids, and computing the reference log-probs once before training when the reference never changes.`,
};
