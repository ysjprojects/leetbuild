import type {Step} from '@/lib/types';

export const grpoTrainStep: Step = {
  id: 'grpo-train',
  title: 'The training loop: rollouts, rewards, μ clipped steps',
  concept: 'pytorch',
  file: 'grpo_train',
  focus: ['ref-copy', 'prompts', 'rollout', 'reward', 'group-norm', 'loss', 'adamw'],
  task: `## Task

Assemble the three files into GRPO's outer loop and train \`TinyLM\` on the addition task from scratch,
with no supervised warm-up: every bit of skill comes from the reward. Import from the earlier steps
(\`from grpo_rollout import TinyLM, generate_group, token_logprobs\`, \`from grpo_advantage import …\`,
\`from grpo_loss import grpo_loss\`). No \`trl\`.

\`grpo_train(policy, iters, batch_prompts=32, G=8, mu=2, lr=3e-3, clip_eps=0.2, beta=0.04,
agg="seq-mean", scale=True, max_new_tokens=3, temperature=1.0, generator=None) -> (ref, history)\`:

Before the loop:

- \`ref = copy.deepcopy(policy)\`, in eval mode with \`requires_grad_(False)\`: the frozen reference;
- \`torch.optim.AdamW(policy.parameters(), lr=lr, betas=(0.9, 0.99), weight_decay=0.0)\`.

Each of \`iters\` iterations:

1. \`make_prompts(batch_prompts, generator)\`;
2. under \`torch.no_grad()\`: \`generate_group\` with the current policy, then \`old_logp =
   token_logprobs(policy, …)\` and \`ref_logp = token_logprobs(ref, …)\`;
3. \`compute_rewards\` on \`seqs[:, PROMPT_LEN:]\` against \`answers.repeat_interleave(G)\`, then
   \`group_advantages(rewards, G, scale=scale)\`;
4. \`for _ in range(mu)\`: \`logp = token_logprobs(policy, …)\` with a graph, \`grpo_loss(…)\`,
   \`zero_grad\`, \`backward\`, \`clip_grad_norm_(…, 1.0)\`, \`step\`, on the **same** rollouts;
5. append \`{"reward": rewards.mean(), "loss": …, "clip_frac": …, "kl": …}\` to \`history\`.

The self-test (single-threaded; about 6 s on a laptop CPU) trains a fresh \`TinyLM(VOCAB, 32, 2, 2,
max_len=8)\` for 200 iterations of 32 prompts × 8 completions. It asserts:
- the first iteration's mean reward is below \`0.3\` (a uniform policy scores \`≈ 0.107\` of \`1.5\`);
- the mean of the last 10 iterations is above \`1.2\`;
- greedy decoding answers at least 75% of the 25 problems exactly (\`digit, EOS\`);
- the run took under 60 s;
- every tensor of the reference equals the policy's initial state, the policy's does not, and the final
  KL is positive.

It prints \`PASS\`.

> On-policy RL is a loop of two phases with different rules: sampling runs without a graph and fixes
> \`π_old\`; the μ optimisation steps reuse those samples, and clipping is what keeps them honest once the
> policy has moved.`,
  hints: [
    'Order inside an iteration: sample and score under `no_grad` first, then rewards and advantages (plain tensors, no graph), then the inner loop, the only place with a graph.',
    'The answers have one entry per prompt but the completions have G: `answers.repeat_interleave(G)` lines them up with the rows `generate_group` produced.',
    'The reference is a `copy.deepcopy(policy)` taken before the optimizer ever steps; the optimizer only knows `policy.parameters()`, so the reference cannot move. With `mu = 1`, `old_logp` equals `logp.detach()` and the ratio is exactly 1.',
  ],
  checks: [
    {
      id: 'frozen-ref',
      title: 'A frozen copy is the reference',
      detail:
        '`copy.deepcopy(policy)` before training, with `requires_grad_(False)`: the KL penalty measures drift from where RL started, so the reference must never be updated.',
      match: {python: {all: [/deepcopy\(\s*policy\s*\)/, /requires_grad_\(\s*False\s*\)/]}},
    },
    {
      id: 'no-grad-rollout',
      title: 'Rollout, old and reference log-probs without a graph',
      detail:
        '`with torch.no_grad():` around `generate_group`, `token_logprobs(policy, …)` and `token_logprobs(ref, …)`: `π_old` and `π_ref` are constants for the inner steps, so the ratio’s gradient flows through `logp` only.',
      match: {
        python: {
          all: [/token_logprobs\(\s*ref\b/],
          order: [/with\s+torch\.no_grad\(\)\s*:/, /generate_group\(/, /token_logprobs\(\s*policy\b/],
        },
      },
    },
    {
      id: 'fresh-rollouts',
      title: 'New prompts and rollouts every iteration',
      detail:
        '`make_prompts` then `generate_group` inside `for … in range(iters)`: GRPO is on-policy, each iteration samples from the policy as it is now.',
      match: {python: {order: [/for\s+\w+\s+in\s+range\(\s*iters\s*\)/, /make_prompts\(/, /generate_group\(/]}},
    },
    {
      id: 'group-adv',
      title: 'Rewards, then group advantages',
      detail:
        '`compute_rewards` against `answers.repeat_interleave(G)`, then `group_advantages`: one answer per row, and one advantage per completion.',
      match: {
        python: {
          all: [/answers\.repeat_interleave\(\s*G\b/],
          order: [/compute_rewards\(/, /group_advantages\(/],
        },
      },
    },
    {
      id: 'mu-steps',
      title: 'μ optimizer steps on the same rollouts',
      detail:
        '`for … in range(mu)`: re-score with a graph, `grpo_loss`, `backward`, `step`. After the first step the ratio leaves 1, which is what the clipping is for.',
      match: {
        python: {
          order: [
            /for\s+\w+\s+in\s+range\(\s*mu\s*\)/,
            /token_logprobs\(\s*policy\b/,
            /grpo_loss\(/,
            /\.backward\(\)/,
            /\.step\(\)/,
          ],
        },
      },
    },
    {
      id: 'adamw',
      title: 'AdamW on the policy only, no trl',
      detail:
        '`torch.optim.AdamW(policy.parameters(), …)`: the reference is not in the optimizer. The loop is written here, not imported from `trl`.',
      match: {
        python: {
          all: [/torch\.optim\.AdamW\(\s*policy\.parameters\(\)/],
          none: [/from\s+trl\b|import\s+trl\b/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""The GRPO loop: roll out groups, score them, normalise within each group, and take mu clipped steps."""

import copy
import time

import torch
import torch.nn as nn

from grpo_advantage import EOS, EQ, PLUS, PROMPT_LEN, VOCAB, compute_rewards, group_advantages, make_prompts
from grpo_loss import grpo_loss
from grpo_rollout import TinyLM, generate_group, token_logprobs


def grpo_train(
    policy: nn.Module,
    iters: int,
    batch_prompts: int = 32,
    G: int = 8,
    mu: int = 2,
    lr: float = 3e-3,
    clip_eps: float = 0.2,
    beta: float = 0.04,
    agg: str = "seq-mean",
    scale: bool = True,
    max_new_tokens: int = 3,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> tuple[nn.Module, list[dict[str, float]]]:
    """Train policy in place with GRPO on the addition task; returns the frozen reference and per-iteration stats."""
    # TODO: freeze a deep copy of the policy as the reference; AdamW on the policy. Per iteration:
    # sample prompts, roll out G completions and score old and reference log-probs without a graph,
    # rewards -> group advantages, then mu clipped GRPO steps on the same rollouts.
    raise NotImplementedError("TODO")


@torch.no_grad()
def greedy_accuracy(policy: nn.Module) -> float:
    """Share of all 25 problems whose greedy completion is exactly the answer digit and EOS."""
    a, b = torch.meshgrid(torch.arange(5), torch.arange(5), indexing="ij")
    a, b = a.reshape(-1), b.reshape(-1)
    seqs = torch.stack([a, torch.full_like(a, PLUS), b, torch.full_like(a, EQ)], dim=1)
    for _ in range(2):
        seqs = torch.cat([seqs, policy(seqs)[:, -1].argmax(-1, keepdim=True)], dim=1)
    return ((seqs[:, 4] == a + b) & (seqs[:, 5] == EOS)).float().mean().item()


if __name__ == "__main__":
    torch.set_num_threads(1)  # tiny matmuls: more threads only add overhead
    torch.manual_seed(0)
    policy = TinyLM(VOCAB, d_model=32, n_layer=2, n_head=2, max_len=8)
    before = copy.deepcopy(policy.state_dict())
    start_acc = greedy_accuracy(policy)

    t0 = time.perf_counter()
    ref, history = grpo_train(policy, iters=200, batch_prompts=32, G=8, mu=2, generator=torch.Generator().manual_seed(0))
    seconds = time.perf_counter() - t0
    rewards = [h["reward"] for h in history]
    first, last = rewards[0], sum(rewards[-10:]) / 10
    acc = greedy_accuracy(policy)
    print(f"mean reward {first:.3f} -> {last:.3f} of 1.5 in {seconds:.1f} s; greedy accuracy {start_acc:.2f} -> {acc:.2f}")
    print(f"last iteration: kl {history[-1]['kl']:.3f}, clip fraction {history[-1]['clip_frac']:.3f}")

    # Learning: from a near-uniform policy to mostly right, well-formed answers, inside the budget.
    assert first < 0.3 and last > 1.2, (first, last)
    assert acc >= 0.75, acc
    assert seconds < 60, seconds
    # The reference never moved; the policy did, and drifted away from it.
    assert all(torch.equal(before[k], v) for k, v in ref.state_dict().items())
    assert not all(torch.equal(before[k], v) for k, v in policy.state_dict().items())
    assert not any(p.requires_grad for p in ref.parameters()) and history[-1]["kl"] > 0
    print("PASS")
`,
      solution: `"""The GRPO loop: roll out groups, score them, normalise within each group, and take mu clipped steps."""

import copy
import time

import torch
import torch.nn as nn

from grpo_advantage import EOS, EQ, PLUS, PROMPT_LEN, VOCAB, compute_rewards, group_advantages, make_prompts
from grpo_loss import grpo_loss
from grpo_rollout import TinyLM, generate_group, token_logprobs


def grpo_train(
    policy: nn.Module,
    iters: int,
    batch_prompts: int = 32,
    G: int = 8,
    mu: int = 2,
    lr: float = 3e-3,
    clip_eps: float = 0.2,
    beta: float = 0.04,
    agg: str = "seq-mean",
    scale: bool = True,
    max_new_tokens: int = 3,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> tuple[nn.Module, list[dict[str, float]]]:
    """Train policy in place with GRPO on the addition task; returns the frozen reference and per-iteration stats."""
    ref = copy.deepcopy(policy).eval()  # pi_ref: the policy as it was before RL, frozen
    ref.requires_grad_(False)
    optimizer = torch.optim.AdamW(policy.parameters(), lr=lr, betas=(0.9, 0.99), weight_decay=0.0)
    history = []
    for _ in range(iters):
        prompts, answers = make_prompts(batch_prompts, generator)
        with torch.no_grad():  # pi_old and pi_ref are constants for the mu steps below
            seqs, mask = generate_group(policy, prompts, G, max_new_tokens, temperature, EOS, generator)
            old_logp = token_logprobs(policy, seqs, PROMPT_LEN, temperature)
            ref_logp = token_logprobs(ref, seqs, PROMPT_LEN, temperature)
        rewards = compute_rewards(seqs[:, PROMPT_LEN:], answers.repeat_interleave(G), EOS)
        advantages = group_advantages(rewards, G, scale=scale)
        for _ in range(mu):  # mu steps on the same rollouts: the ratio drifts from 1 and clipping engages
            logp = token_logprobs(policy, seqs, PROMPT_LEN, temperature)
            loss, metrics = grpo_loss(logp, old_logp, ref_logp, advantages, mask, clip_eps, beta, agg)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            optimizer.step()
        history.append({"reward": rewards.mean().item(), "loss": loss.item(), **metrics})
    return ref, history


@torch.no_grad()
def greedy_accuracy(policy: nn.Module) -> float:
    """Share of all 25 problems whose greedy completion is exactly the answer digit and EOS."""
    a, b = torch.meshgrid(torch.arange(5), torch.arange(5), indexing="ij")
    a, b = a.reshape(-1), b.reshape(-1)
    seqs = torch.stack([a, torch.full_like(a, PLUS), b, torch.full_like(a, EQ)], dim=1)
    for _ in range(2):
        seqs = torch.cat([seqs, policy(seqs)[:, -1].argmax(-1, keepdim=True)], dim=1)
    return ((seqs[:, 4] == a + b) & (seqs[:, 5] == EOS)).float().mean().item()


if __name__ == "__main__":
    torch.set_num_threads(1)  # tiny matmuls: more threads only add overhead
    torch.manual_seed(0)
    policy = TinyLM(VOCAB, d_model=32, n_layer=2, n_head=2, max_len=8)
    before = copy.deepcopy(policy.state_dict())
    start_acc = greedy_accuracy(policy)

    t0 = time.perf_counter()
    ref, history = grpo_train(policy, iters=200, batch_prompts=32, G=8, mu=2, generator=torch.Generator().manual_seed(0))
    seconds = time.perf_counter() - t0
    rewards = [h["reward"] for h in history]
    first, last = rewards[0], sum(rewards[-10:]) / 10
    acc = greedy_accuracy(policy)
    print(f"mean reward {first:.3f} -> {last:.3f} of 1.5 in {seconds:.1f} s; greedy accuracy {start_acc:.2f} -> {acc:.2f}")
    print(f"last iteration: kl {history[-1]['kl']:.3f}, clip fraction {history[-1]['clip_frac']:.3f}")

    # Learning: from a near-uniform policy to mostly right, well-formed answers, inside the budget.
    assert first < 0.3 and last > 1.2, (first, last)
    assert acc >= 0.75, acc
    assert seconds < 60, seconds
    # The reference never moved; the policy did, and drifted away from it.
    assert all(torch.equal(before[k], v) for k, v in ref.state_dict().items())
    assert not all(torch.equal(before[k], v) for k, v in policy.state_dict().items())
    assert not any(p.requires_grad for p in ref.parameters()) and history[-1]["kl"] > 0
    print("PASS")
`,
    },
  },
  debrief: `This is Algorithm 1 of DeepSeekMath at toy scale: for each iteration, freeze \`π_old\`, sample G outputs per question, compute rewards and group-relative advantages, then take μ gradient steps on the GRPO objective. The paper also refreshes the reference to the current policy every outer step and retrains the reward model; with a programmatic reward and one short run, neither matters here. **The two phases** differ in everything: sampling is many cheap forward passes without a graph, optimisation is one teacher-forced pass with one, and the log-probs from the first are the constants of the second. **μ > 1** reuses each expensive rollout for several updates, and clipping is what makes that safe; at μ = 1 the ratio is exactly 1, clipping never fires and GRPO reduces to REINFORCE with a group baseline plus the KL term, which is TRL's default. **No warm-up**: the uniform policy already hits the reward 1 time in 13, enough non-flat groups to get going, which is the R1-Zero observation in miniature; a task where the base model never succeeds gives only zero advantages and never starts. What production adds: vLLM for rollouts with weights synced every step, the policy, reference and optimizer sharded with FSDP or DeepSpeed ZeRO, rollouts generated asynchronously while the trainer steps, gradient accumulation across many prompts per update, dynamic sampling to skip flat groups, and evaluation on held-out problems instead of the training mean reward.`,
};
