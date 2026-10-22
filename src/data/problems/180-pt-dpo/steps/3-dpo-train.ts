import type {Step} from '@/lib/types';

export const dpoTrainStep: Step = {
  id: 'dpo-train',
  title: 'Training: a frozen reference, the DPO step, the metrics',
  concept: 'pytorch',
  file: 'dpo_train',
  focus: ['freeze', 'pairs', 'policy', 'reference', 'ref-logps', 'backward', 'adamw'],
  task: `## Task

Put steps 1 and 2 in a loop (\`from dpo_logprobs import TinyLM, concatenated_forward\`,
\`from dpo_loss import dpo_loss\`). \`toy_preferences\`, \`collate\` and \`evaluate\` are given: 32 pairs
over a 16-token vocabulary, prompt \`[1, a, b, c]\` with three distinct digits, chosen = the digits
sorted ascending then EOS, rejected = sorted descending then EOS.

- \`make_reference(policy) -> nn.Module\`: \`copy.deepcopy(policy)\`, then \`.eval()\` (no dropout: the
  reference must give the same number for the same pair every time) and \`.requires_grad_(False)\`.
- \`dpo_step(policy, reference, batch, optimizer, beta=0.1, label_smoothing=0.0, loss_type="sigmoid",
  max_grad_norm=1.0) -> dict[str, float]\`: the reference's log-probs under \`with torch.no_grad():\` (no
  graph, no activations kept); the policy's log-probs with grad; \`dpo_loss\` on the four and the mean of
  \`"losses"\` over the batch.
- In \`dpo_step\`, then: \`optimizer.zero_grad(set_to_none=True)\` → \`loss.backward()\` →
  \`torch.nn.utils.clip_grad_norm_(policy.parameters(), max_grad_norm)\` → \`optimizer.step()\`, and return
  \`loss\`, \`reward_accuracy\`, \`reward_margin\`, \`chosen_reward\`, \`rejected_reward\` as floats.
- \`train_dpo(policy, pairs, steps=150, batch_size=16, lr=1e-2, beta=0.1, label_smoothing=0.0,
  loss_type="sigmoid", seed=0) -> (reference, history)\`: the reference made once from the starting
  policy, \`torch.optim.AdamW(policy.parameters(), lr=lr, weight_decay=0.0)\` (the reference is not in
  it), then \`steps\` calls of \`dpo_step\` on \`random.Random(seed).sample(pairs, batch_size)\`.
- Forbidden: \`trl\`, \`DPOTrainer\`.

The self-test trains a fresh \`TinyLM\` for 150 steps (about 2 s on a laptop CPU). It checks that the
first loss is \`ln 2\` (policy = reference, so \`h = 0\`) and the first margin 0 within \`1e-5\`, that
every reference parameter is bit-identical to the starting policy and none requires grad, that the
final reward accuracy over all 32 pairs is exactly 1.0, that the margin over the last 10 steps exceeds
the margin over steps 1 to 10 by more than 0.5 and ends above 1.0, and that the loss fell below
\`0.3 · ln 2\`. It prints \`PASS\`.

> The reference is the anchor: the loss only ever sees the policy's preferences relative to it, so it
> must be the starting policy, exactly, for the whole run.`,
  hints: [
    '`make_reference` is three lines, and the order does not matter; `requires_grad_(False)` on the module sets it on every parameter.',
    'Inside `dpo_step`, the reference forward goes in `with torch.no_grad():`; the policy forward does not. Pass `beta`, `label_smoothing` and `loss_type` through to `dpo_loss` and take `out["losses"].mean()`.',
    'Build the optimizer from `policy.parameters()` after the reference exists, and draw batches with `rng = random.Random(seed)` then `collate(rng.sample(pairs, batch_size))` so the run is repeatable.',
  ],
  checks: [
    {
      id: 'deepcopy',
      title: 'The reference is a deep copy of the policy',
      detail:
        '`copy.deepcopy(policy)`: the same weights in separate tensors. Assigning `reference = policy` would move the reference with every step and keep `h` at 0 forever.',
      match: {python: {all: [/copy\.deepcopy\(|\bdeepcopy\(/]}},
    },
    {
      id: 'frozen',
      title: 'Reference in eval mode, no parameter requires grad',
      detail:
        '`.eval()` so dropout cannot change its numbers, and `requires_grad_(False)` so no gradient is ever computed or stored for it.',
      match: {python: {all: [/requires_grad_\(\s*False\s*\)|requires_grad\s*=\s*False/, /\.eval\(\)/]}},
    },
    {
      id: 'no-grad',
      title: 'Reference log-probs without a graph',
      detail:
        'The reference call to `concatenated_forward` sits inside `with torch.no_grad():` (or `torch.inference_mode()`): its activations are not kept for a backward that will never use them.',
      match: {
        python: {
          all: [/with torch\.(?:no_grad|inference_mode)\(\)\s*:\s*\n\s*[^\n]*concatenated_forward\(\s*ref/],
        },
      },
    },
    {
      id: 'loss-mean',
      title: 'The loss is the mean over pairs',
      detail:
        'A loss variable assigned from `out["losses"].mean()` (or `losses.mean()`): one scalar per batch, so the step size does not grow with the batch.',
      match: {python: {all: [/\w*loss\w*\s*=\s*[^\n]*losses"?\]?\.mean\(\)/]}},
    },
    {
      id: 'step-order',
      title: 'zero_grad → backward → clip → step',
      detail:
        '`optimizer.zero_grad`, `loss.backward()`, `clip_grad_norm_(policy.parameters(), max_grad_norm)`, `optimizer.step()`, in that order.',
      match: {
        python: {
          all: [/clip_grad_norm_\(\s*policy\.parameters\(\)/],
          order: [/zero_grad\(/, /\.backward\(\)/, /clip_grad_norm_\(/, /optimizer\.step\(\)/],
        },
      },
    },
    {
      id: 'optimizer',
      title: 'The optimizer holds the policy only',
      detail: '`torch.optim.AdamW(policy.parameters(), …)`: the reference has no optimizer state and is never stepped.',
      match: {python: {all: [/optim\.\w+\(\s*policy\.parameters\(\)/]}},
    },
    {
      id: 'builds-on',
      title: 'Built on steps 1 and 2, not on TRL',
      detail:
        'Imports `concatenated_forward` from `dpo_logprobs` and `dpo_loss` from `dpo_loss`; `trl` and `DPOTrainer` are not used.',
      match: {
        python: {
          all: [/from dpo_logprobs import/, /from dpo_loss import dpo_loss/],
          none: [/from trl\b|import trl\b|DPOTrainer/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""DPO, part 3: a frozen reference, the training step, and a toy preference set a tiny LM learns in seconds."""

import copy
import random

import torch
import torch.nn as nn

from dpo_logprobs import TinyLM, concatenated_forward
from dpo_loss import dpo_loss

EOS_ID = 15


def make_reference(policy: nn.Module) -> nn.Module:
    """A frozen copy of the starting policy: same weights, eval mode, no parameter requires grad."""
    raise NotImplementedError("TODO: deep copy, eval mode, no parameter requires grad")


def toy_preferences(n: int, seed: int = 0) -> list[dict[str, list[int]]]:
    """n pairs over a 16-token vocabulary: prompt [1, a, b, c], chosen = sorted ascending + EOS, rejected = descending + EOS."""
    rng = random.Random(seed)
    pairs = []
    for _ in range(n):
        digits = rng.sample(range(2, 12), 3)
        pairs.append(
            {
                "prompt": [1] + digits,
                "chosen": sorted(digits) + [EOS_ID],
                "rejected": sorted(digits, reverse=True) + [EOS_ID],
            }
        )
    return pairs


def collate(pairs: list[dict[str, list[int]]]) -> dict[str, list[list[int]]]:
    """A list of pairs to the column batch \`concatenated_forward\` reads."""
    return {key: [p[key] for p in pairs] for key in ("prompt", "chosen", "rejected")}


def dpo_step(
    policy: nn.Module,
    reference: nn.Module,
    batch: dict[str, list[list[int]]],
    optimizer: torch.optim.Optimizer,
    beta: float = 0.1,
    label_smoothing: float = 0.0,
    loss_type: str = "sigmoid",
    max_grad_norm: float = 1.0,
) -> dict[str, float]:
    """One optimizer step on one batch of pairs; returns the loss and the reward metrics as floats."""
    raise NotImplementedError("TODO: reference log-probs without a graph, policy log-probs, mean DPO loss, zero_grad, backward, clip, step")


@torch.no_grad()
def evaluate(policy: nn.Module, reference: nn.Module, pairs: list[dict[str, list[int]]], beta: float = 0.1) -> dict[str, float]:
    """Reward accuracy and margin of the current policy over every pair, without a graph."""
    policy.eval()
    batch = collate(pairs)
    pol_chosen, pol_rejected = concatenated_forward(policy, batch)
    ref_chosen, ref_rejected = concatenated_forward(reference, batch)
    out = dpo_loss(pol_chosen, pol_rejected, ref_chosen, ref_rejected, beta)
    policy.train()
    return {
        "loss": out["losses"].mean().item(),
        "reward_accuracy": out["reward_accuracy"].item(),
        "reward_margin": out["reward_margin"].item(),
    }


def train_dpo(
    policy: nn.Module,
    pairs: list[dict[str, list[int]]],
    steps: int = 150,
    batch_size: int = 16,
    lr: float = 1e-2,
    beta: float = 0.1,
    label_smoothing: float = 0.0,
    loss_type: str = "sigmoid",
    seed: int = 0,
) -> tuple[nn.Module, list[dict[str, float]]]:
    """Freeze a reference from the starting policy, then \`steps\` DPO steps on random batches; returns (reference, history)."""
    raise NotImplementedError("TODO: freeze the reference, AdamW over the policy, \`steps\` dpo_step calls on random batches")


if __name__ == "__main__":
    import math
    import time

    torch.manual_seed(0)
    pairs = toy_preferences(32)
    policy = TinyLM()
    start = {k: v.clone() for k, v in policy.state_dict().items()}

    t0 = time.perf_counter()
    reference, history = train_dpo(policy, pairs, steps=150, beta=0.1)
    seconds = time.perf_counter() - t0

    # Step 0: the policy is the reference, so h = 0 and the loss is ln 2 (up to float32 rounding).
    assert abs(history[0]["loss"] - math.log(2.0)) < 1e-5, history[0]["loss"]
    assert abs(history[0]["reward_margin"]) < 1e-5, history[0]["reward_margin"]

    # The reference is the starting policy, frozen: not one parameter moved, none takes a gradient.
    assert all(torch.equal(v, start[k]) for k, v in reference.state_dict().items()), "the reference moved"
    assert not any(p.requires_grad for p in reference.parameters()) and not reference.training
    assert any(not torch.equal(v, start[k]) for k, v in policy.state_dict().items()), "the policy never moved"

    final = evaluate(policy, reference, pairs, beta=0.1)
    assert final["reward_accuracy"] == 1.0, final
    early = sum(h["reward_margin"] for h in history[1:11]) / 10
    late = sum(h["reward_margin"] for h in history[-10:]) / 10
    assert late > early + 0.5 and final["reward_margin"] > 1.0, (early, late, final)
    assert final["loss"] < 0.3 * math.log(2.0), final

    print(
        f"{len(history)} steps in {seconds:.1f} s: loss {history[0]['loss']:.3f} -> {final['loss']:.3f}, "
        f"accuracy {final['reward_accuracy']:.2f}, margin {early:.2f} -> {final['reward_margin']:.2f}"
    )
    print("PASS")
`,
      solution: `"""DPO, part 3: a frozen reference, the training step, and a toy preference set a tiny LM learns in seconds."""

import copy
import random

import torch
import torch.nn as nn

from dpo_logprobs import TinyLM, concatenated_forward
from dpo_loss import dpo_loss

EOS_ID = 15


def make_reference(policy: nn.Module) -> nn.Module:
    """A frozen copy of the starting policy: same weights, eval mode, no parameter requires grad."""
    reference = copy.deepcopy(policy)
    reference.eval()
    reference.requires_grad_(False)
    return reference


def toy_preferences(n: int, seed: int = 0) -> list[dict[str, list[int]]]:
    """n pairs over a 16-token vocabulary: prompt [1, a, b, c], chosen = sorted ascending + EOS, rejected = descending + EOS."""
    rng = random.Random(seed)
    pairs = []
    for _ in range(n):
        digits = rng.sample(range(2, 12), 3)
        pairs.append(
            {
                "prompt": [1] + digits,
                "chosen": sorted(digits) + [EOS_ID],
                "rejected": sorted(digits, reverse=True) + [EOS_ID],
            }
        )
    return pairs


def collate(pairs: list[dict[str, list[int]]]) -> dict[str, list[list[int]]]:
    """A list of pairs to the column batch \`concatenated_forward\` reads."""
    return {key: [p[key] for p in pairs] for key in ("prompt", "chosen", "rejected")}


def dpo_step(
    policy: nn.Module,
    reference: nn.Module,
    batch: dict[str, list[list[int]]],
    optimizer: torch.optim.Optimizer,
    beta: float = 0.1,
    label_smoothing: float = 0.0,
    loss_type: str = "sigmoid",
    max_grad_norm: float = 1.0,
) -> dict[str, float]:
    """One optimizer step on one batch of pairs; returns the loss and the reward metrics as floats."""
    policy.train()
    with torch.no_grad():
        ref_chosen, ref_rejected = concatenated_forward(reference, batch)
    pol_chosen, pol_rejected = concatenated_forward(policy, batch)
    out = dpo_loss(pol_chosen, pol_rejected, ref_chosen, ref_rejected, beta, label_smoothing, loss_type)
    loss = out["losses"].mean()
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(policy.parameters(), max_grad_norm)
    optimizer.step()
    return {
        "loss": loss.item(),
        "reward_accuracy": out["reward_accuracy"].item(),
        "reward_margin": out["reward_margin"].item(),
        "chosen_reward": out["chosen_rewards"].mean().item(),
        "rejected_reward": out["rejected_rewards"].mean().item(),
    }


@torch.no_grad()
def evaluate(policy: nn.Module, reference: nn.Module, pairs: list[dict[str, list[int]]], beta: float = 0.1) -> dict[str, float]:
    """Reward accuracy and margin of the current policy over every pair, without a graph."""
    policy.eval()
    batch = collate(pairs)
    pol_chosen, pol_rejected = concatenated_forward(policy, batch)
    ref_chosen, ref_rejected = concatenated_forward(reference, batch)
    out = dpo_loss(pol_chosen, pol_rejected, ref_chosen, ref_rejected, beta)
    policy.train()
    return {
        "loss": out["losses"].mean().item(),
        "reward_accuracy": out["reward_accuracy"].item(),
        "reward_margin": out["reward_margin"].item(),
    }


def train_dpo(
    policy: nn.Module,
    pairs: list[dict[str, list[int]]],
    steps: int = 150,
    batch_size: int = 16,
    lr: float = 1e-2,
    beta: float = 0.1,
    label_smoothing: float = 0.0,
    loss_type: str = "sigmoid",
    seed: int = 0,
) -> tuple[nn.Module, list[dict[str, float]]]:
    """Freeze a reference from the starting policy, then \`steps\` DPO steps on random batches; returns (reference, history)."""
    reference = make_reference(policy)
    optimizer = torch.optim.AdamW(policy.parameters(), lr=lr, weight_decay=0.0)
    rng = random.Random(seed)
    history = []
    for _ in range(steps):
        batch = collate(rng.sample(pairs, batch_size))
        history.append(dpo_step(policy, reference, batch, optimizer, beta, label_smoothing, loss_type))
    return reference, history


if __name__ == "__main__":
    import math
    import time

    torch.manual_seed(0)
    pairs = toy_preferences(32)
    policy = TinyLM()
    start = {k: v.clone() for k, v in policy.state_dict().items()}

    t0 = time.perf_counter()
    reference, history = train_dpo(policy, pairs, steps=150, beta=0.1)
    seconds = time.perf_counter() - t0

    # Step 0: the policy is the reference, so h = 0 and the loss is ln 2 (up to float32 rounding).
    assert abs(history[0]["loss"] - math.log(2.0)) < 1e-5, history[0]["loss"]
    assert abs(history[0]["reward_margin"]) < 1e-5, history[0]["reward_margin"]

    # The reference is the starting policy, frozen: not one parameter moved, none takes a gradient.
    assert all(torch.equal(v, start[k]) for k, v in reference.state_dict().items()), "the reference moved"
    assert not any(p.requires_grad for p in reference.parameters()) and not reference.training
    assert any(not torch.equal(v, start[k]) for k, v in policy.state_dict().items()), "the policy never moved"

    final = evaluate(policy, reference, pairs, beta=0.1)
    assert final["reward_accuracy"] == 1.0, final
    early = sum(h["reward_margin"] for h in history[1:11]) / 10
    late = sum(h["reward_margin"] for h in history[-10:]) / 10
    assert late > early + 0.5 and final["reward_margin"] > 1.0, (early, late, final)
    assert final["loss"] < 0.3 * math.log(2.0), final

    print(
        f"{len(history)} steps in {seconds:.1f} s: loss {history[0]['loss']:.3f} -> {final['loss']:.3f}, "
        f"accuracy {final['reward_accuracy']:.2f}, margin {early:.2f} -> {final['reward_margin']:.2f}"
    )
    print("PASS")
`,
    },
  },
  debrief: `The loop is short because DPO moved all of RLHF's machinery into the loss. PPO-based RLHF keeps four models in memory (policy, reference, reward model, value head), samples completions every step, scores them, estimates advantages and runs several clipped updates per batch. DPO keeps two models, never samples, and takes one supervised-looking step per batch of fixed pairs. **The reference** must be the starting policy, frozen: the loss sees only \`log π − log π_ref\`, so a reference that moves (a shared object, dropout, a stray optimizer entry) silently changes the objective. At step 0 the policy equals the reference, \`h = 0\` for every pair, the loss is exactly \`ln 2\` and the accuracy is noise; the self-test pins that. **What to watch**: reward accuracy saturates fast (here within about 10 steps) and says little afterwards; the margin keeps growing. Note the chosen reward too: in this run it ends slightly negative while the rejected reward falls to about −7, so the policy made both responses less likely and the rejected one far less. That is the well-known DPO failure where the chosen log-prob drops; RPO adds an SFT term on the chosen response against it. Production adds: an SFT stage first (the reference is the SFT model, not a random one), the reference log-probs precomputed in one pass, LoRA so the reference is the base weights with adapters off, bf16 and FSDP, a learning rate around \`1e-6\` with warmup (the DPO paper's setting), one or two epochs over the data, and evaluation by sampling and judging rather than by reward accuracy.`,
};
