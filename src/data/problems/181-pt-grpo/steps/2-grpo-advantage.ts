import type {Step} from '@/lib/types';

export const grpoAdvantageStep: Step = {
  id: 'grpo-advantage',
  title: 'Verifiable rewards and group-relative advantages',
  concept: 'pytorch',
  file: 'grpo_advantage',
  focus: ['reward', 'group-norm', 'rewards', 'group-0', 'group-1'],
  task: `## Task

Write the task the policy will learn, the rewards a program can check, and the advantage that replaces
PPO's value network (\`from grpo_rollout import TinyLM, generate_group\` for the self-test).

- **The task.** Token ids \`0…9\` are digits, \`PLUS = 10\`, \`EQ = 11\`, \`EOS = 12\`, \`VOCAB = 13\`,
  \`PROMPT_LEN = 4\`. \`make_prompts(n, generator=None, max_operand=4) -> (prompts (n, 4) long, answers
  (n,) long)\`: \`a\` and \`b\` from \`torch.randint(0, max_operand + 1, (n,), generator=generator)\`, rows
  \`[a, PLUS, b, EQ]\`, answers \`a + b\` (25 problems, answers \`0…8\`).

**Verifiable rewards**, \`(N, L)\` completions to \`(N,)\` float32, no learned reward model:

- \`accuracy_reward(completions, answers)\`: \`1.0\` where \`completions[:, 0] == answers\`;
- \`format_reward(completions, eos_id=EOS)\`: \`1.0\` where the completion is exactly one digit
  (\`< PLUS\`) followed by \`eos_id\`; \`0.0\` for every row when \`L < 2\`;
- \`compute_rewards(completions, answers, eos_id=EOS, weights=(1.0, 0.5))\`: the weighted sum, in
  \`[0, 1.5]\`.

\`group_advantages(rewards (B·G,), G, eps=1e-4, scale=True) -> (B·G,) float32\`:

- view the rewards as \`(B, G)\`, subtract each group's mean;
- with \`scale\`, divide by the group's **unbiased** std \`+ eps\`: \`(r − mean_g) / (std_g + eps)\`;
- \`scale=False\` returns \`r − mean_g\` only (Dr. GRPO);
- a group whose rewards are all equal gets advantage \`0\` for every completion, with or without
  \`scale\` (no division by zero).

The self-test checks the prompts and answers, the three rewards on hand-written completions (right and
well formed \`1.5\`, right but rambling \`1.0\`, wrong but well formed \`0.5\`), the closed form for one
success in four (\`mean 0.25\`, \`std 0.5\`, advantages \`1.5\` and \`−0.5\`), zero-sum groups with unit std,
invariance to \`10·r + 3\`, the \`scale=False\` values, a uniform policy's expected reward \`1/13 +
0.5 · 10/169 ≈ 0.107\`, and a fresh \`TinyLM\`'s rollout. It prints \`PASS\`.

:::widget grpo-advantages {"G": 8, "p": 0.3}

> The baseline is the group itself: G answers to the same prompt, scored by a program, and each one is
> judged against its siblings. No critic to train, and a prompt the policy always (or never) solves
> contributes nothing.`,
  hints: [
    'Rows `b·G … b·G + G − 1` are one group, so `rewards.view(-1, G)` has one group per row; `mean(dim=1, keepdim=True)` and `std(dim=1, keepdim=True)` broadcast back over it.',
    'A flat group has `r − mean = 0` exactly, so `0 / (0 + eps)` is already `0`: the `eps` is what makes the zero-variance case safe, no special branch needed. `torch.std` is unbiased by default (`correction=1`), as TRL uses it.',
    'Both rewards read only columns 0 and 1 of the completions: a digit is any id below `PLUS`, and a boolean tensor becomes the reward with `.float()`.',
  ],
  checks: [
    {
      id: 'group-view',
      title: 'Rewards grouped as (B, G), no critic',
      detail:
        '`rewards.view(-1, G)` (or `reshape`): consecutive rows are one prompt’s group, as `generate_group` laid them out. The baseline comes from the group, so there is no value head or critic anywhere.',
      match: {python: {all: [/\.(?:view|reshape)\(\s*-1\s*,\s*G\s*\)/], none: [/value_head|ValueHead|critic/i]}},
    },
    {
      id: 'group-stats',
      title: 'Mean and unbiased std per group',
      detail:
        '`mean` and `std` along the group dimension (`dim=1`, `keepdim=True`), with `torch.std`’s default unbiased estimate as GRPO implementations use it; `unbiased=False` gives different advantages for small G.',
      match: {
        python: {
          all: [/\.mean\([^)]*(?:dim|keepdim|\d)/, /\.std\([^)]*(?:dim\s*=|keepdim)/],
          none: [/unbiased\s*=\s*False|correction\s*=\s*0\b/],
        },
      },
    },
    {
      id: 'eps',
      title: 'std + eps in the denominator',
      detail:
        '`(r − mean) / (std + eps)`: a group where every completion scored the same has `std = 0`, and `eps` turns `0 / 0` into `0` instead of `nan`.',
      match: {python: {all: [/\+\s*eps\b/]}},
    },
    {
      id: 'scale-flag',
      title: 'scale=False subtracts the mean only',
      detail:
        'The std division sits under `if scale`: Dr. GRPO drops it because dividing by a small std up-weights prompts that are nearly always or nearly never solved.',
      match: {python: {all: [/\bif\s+(?:not\s+)?scale\b/]}},
    },
    {
      id: 'accuracy',
      title: 'Accuracy checked by comparison, not a model',
      detail:
        '`completions[:, 0] == answers`: the reward is a program over the tokens, as DeepSeek-R1’s rule-based accuracy reward is. A learned reward model can be gamed; an exact check cannot.',
      match: {
        python: {
          all: [/completions\[\s*:\s*,\s*0\s*\]\s*==\s*answers|answers\s*==\s*completions\[\s*:\s*,\s*0\s*\]/],
        },
      },
    },
    {
      id: 'format',
      title: 'Format: one digit, then EOS',
      detail:
        'A digit (`< PLUS`) at position 0 and `eos_id` at position 1: the format reward shapes how the answer is written, separately from whether it is right.',
      match: {
        python: {
          all: [
            /completions\[\s*:\s*,\s*1\s*\]\s*==\s*eos_id|eos_id\s*==\s*completions\[\s*:\s*,\s*1\s*\]/,
            /<\s*(?:PLUS|10)\b|<=\s*9\b/,
          ],
        },
      },
    },
    {
      id: 'prompts',
      title: 'Problems drawn from the generator',
      detail:
        '`torch.randint(…, generator=generator)` for both operands: the training run is reproducible under one seed, rollouts and prompts alike.',
      match: {python: {all: [/torch\.randint\((?:[^()]|\([^()]*\))*generator\s*=\s*generator/]}},
    },
  ],
  code: {
    python: {
      starter: `"""GRPO advantages: a toy task with verifiable rewards, and group-relative advantages instead of a value network."""

import torch

from grpo_rollout import TinyLM, generate_group

# The toy task: "a + b =" with single digits a, b in 0..4; the answer is the digit a + b, then EOS.
PLUS, EQ, EOS = 10, 11, 12
VOCAB = 13
PROMPT_LEN = 4


def make_prompts(n: int, generator: torch.Generator | None = None, max_operand: int = 4) -> tuple[torch.Tensor, torch.Tensor]:
    """n random problems: prompts (n, 4) long as [a, PLUS, b, EQ], answers (n,) long = a + b."""
    # TODO: a and b uniform in 0..max_operand from the generator; rows [a, PLUS, b, EQ].
    raise NotImplementedError("TODO")


def accuracy_reward(completions: torch.Tensor, answers: torch.Tensor) -> torch.Tensor:
    """1.0 where the completion's first token is the answer digit, else 0.0: (N, L), (N,) -> (N,) float32."""
    # TODO: compare the first completion token with the answer.
    raise NotImplementedError("TODO")


def format_reward(completions: torch.Tensor, eos_id: int = EOS) -> torch.Tensor:
    """1.0 where the completion is exactly one digit followed by EOS, else 0.0: (N, L) -> (N,) float32."""
    # TODO: a digit (< PLUS) at position 0 and eos_id at position 1.
    raise NotImplementedError("TODO")


def compute_rewards(
    completions: torch.Tensor, answers: torch.Tensor, eos_id: int = EOS, weights: tuple[float, float] = (1.0, 0.5)
) -> torch.Tensor:
    """Weighted sum of the verifiable rewards, accuracy then format: (N,) float32 in [0, 1.5] by default."""
    # TODO: weights[0] * accuracy + weights[1] * format.
    raise NotImplementedError("TODO")


def group_advantages(rewards: torch.Tensor, G: int, eps: float = 1e-4, scale: bool = True) -> torch.Tensor:
    """(r - mean_g) / (std_g + eps) for each group of G consecutive rewards: (B*G,) -> (B*G,) float32.

    std is the unbiased sample std of the group. scale=False returns r - mean_g (Dr. GRPO). A group whose
    rewards are all equal gets advantage 0 for every completion.
    """
    # TODO: view the rewards as (B, G); subtract each group's mean; when scale, divide by
    # the group's std + eps.
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)

    # The task: prompts are [a, +, b, =] and the answer is their sum.
    gen = torch.Generator().manual_seed(0)
    prompts, answers = make_prompts(64, gen)
    assert prompts.shape == (64, PROMPT_LEN) and prompts.dtype == torch.long
    assert torch.equal(prompts[:, 0] + prompts[:, 2], answers) and int(answers.max()) <= 8
    assert bool((prompts[:, 1] == PLUS).all() and (prompts[:, 3] == EQ).all())

    # Rewards, closed form: right and well formed, right but rambling, wrong but well formed, neither.
    comps = torch.tensor([[7, EOS, EOS], [7, 3, EOS], [5, EOS, EOS], [EOS, EOS, EOS], [PLUS, EOS, EOS]])
    ans = torch.full((5,), 7)
    assert accuracy_reward(comps, ans).tolist() == [1.0, 1.0, 0.0, 0.0, 0.0]
    assert format_reward(comps).tolist() == [1.0, 0.0, 1.0, 0.0, 0.0]
    assert compute_rewards(comps, ans).tolist() == [1.5, 1.0, 0.5, 0.0, 0.0]

    # One success among four: mean 0.25, unbiased std 0.5, so the advantages are 1.5 and -0.5.
    r = torch.tensor([1.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.5])
    adv = group_advantages(r, G=4, eps=0.0)
    assert torch.allclose(adv[:4], torch.tensor([1.5, -0.5, -0.5, -0.5]))
    # Each group's advantages sum to zero and have unit sample std.
    g = adv.view(-1, 4)
    assert torch.allclose(g.sum(1), torch.zeros(2), atol=1e-6)
    assert torch.allclose(g.std(1), torch.ones(2), atol=1e-6)
    # A group where every completion scores the same teaches nothing: zero advantage, not a division by zero.
    assert torch.equal(group_advantages(torch.full((4,), 1.5), G=4), torch.zeros(4))
    # Invariant to the reward's scale and offset when scaled; only shifted without scaling (Dr. GRPO).
    assert torch.allclose(group_advantages(10 * r + 3, 4, eps=0.0), adv, atol=1e-5)
    plain = group_advantages(r, G=4, scale=False)
    assert torch.allclose(plain, torch.tensor([0.75, -0.25, -0.25, -0.25, -0.75, -0.25, 0.25, 0.75]))
    assert torch.allclose(group_advantages(10 * r, 4, scale=False), 10 * plain)

    # Baseline: a uniform policy scores 1/13 on accuracy and (10/13)(1/13) on format.
    uniform = torch.randint(0, VOCAB, (200_000, 3), generator=gen)
    base = compute_rewards(uniform, torch.full((200_000,), 4)).mean().item()
    assert abs(base - (1 / 13 + 0.5 * 10 / 169)) < 0.005, base
    # A fresh policy's groups: per-group zero sum, and groups with one reward value carry no signal.
    policy = TinyLM(VOCAB, d_model=32, n_layer=2, n_head=2, max_len=8)
    prompts, answers = make_prompts(16, gen)
    seqs, mask = generate_group(policy, prompts, 8, 3, temperature=1.0, eos_id=EOS, generator=gen)
    rewards = compute_rewards(seqs[:, PROMPT_LEN:], answers.repeat_interleave(8))
    adv = group_advantages(rewards, G=8).view(16, 8)
    assert torch.allclose(adv.sum(1), torch.zeros(16), atol=1e-4)
    flat = rewards.view(16, 8).std(1) == 0
    assert torch.equal(adv[flat], torch.zeros_like(adv[flat]))
    print(f"uniform-policy reward {base:.3f} of 1.5; fresh policy {rewards.mean():.3f}, {int(flat.sum())} of 16 groups flat")
    print("PASS")
`,
      solution: `"""GRPO advantages: a toy task with verifiable rewards, and group-relative advantages instead of a value network."""

import torch

from grpo_rollout import TinyLM, generate_group

# The toy task: "a + b =" with single digits a, b in 0..4; the answer is the digit a + b, then EOS.
PLUS, EQ, EOS = 10, 11, 12
VOCAB = 13
PROMPT_LEN = 4


def make_prompts(n: int, generator: torch.Generator | None = None, max_operand: int = 4) -> tuple[torch.Tensor, torch.Tensor]:
    """n random problems: prompts (n, 4) long as [a, PLUS, b, EQ], answers (n,) long = a + b."""
    a = torch.randint(0, max_operand + 1, (n,), generator=generator)
    b = torch.randint(0, max_operand + 1, (n,), generator=generator)
    prompts = torch.stack([a, torch.full_like(a, PLUS), b, torch.full_like(a, EQ)], dim=1)
    return prompts, a + b


def accuracy_reward(completions: torch.Tensor, answers: torch.Tensor) -> torch.Tensor:
    """1.0 where the completion's first token is the answer digit, else 0.0: (N, L), (N,) -> (N,) float32."""
    return (completions[:, 0] == answers).float()


def format_reward(completions: torch.Tensor, eos_id: int = EOS) -> torch.Tensor:
    """1.0 where the completion is exactly one digit followed by EOS, else 0.0: (N, L) -> (N,) float32."""
    if completions.shape[1] < 2:
        return torch.zeros(completions.shape[0])
    one_digit = completions[:, 0] < PLUS
    return (one_digit & (completions[:, 1] == eos_id)).float()


def compute_rewards(
    completions: torch.Tensor, answers: torch.Tensor, eos_id: int = EOS, weights: tuple[float, float] = (1.0, 0.5)
) -> torch.Tensor:
    """Weighted sum of the verifiable rewards, accuracy then format: (N,) float32 in [0, 1.5] by default."""
    return weights[0] * accuracy_reward(completions, answers) + weights[1] * format_reward(completions, eos_id)


def group_advantages(rewards: torch.Tensor, G: int, eps: float = 1e-4, scale: bool = True) -> torch.Tensor:
    """(r - mean_g) / (std_g + eps) for each group of G consecutive rewards: (B*G,) -> (B*G,) float32.

    std is the unbiased sample std of the group. scale=False returns r - mean_g (Dr. GRPO). A group whose
    rewards are all equal gets advantage 0 for every completion.
    """
    grouped = rewards.view(-1, G)
    mean = grouped.mean(dim=1, keepdim=True)
    adv = grouped - mean
    if scale:
        adv = adv / (grouped.std(dim=1, keepdim=True) + eps)
    return adv.reshape(-1)


if __name__ == "__main__":
    torch.manual_seed(0)

    # The task: prompts are [a, +, b, =] and the answer is their sum.
    gen = torch.Generator().manual_seed(0)
    prompts, answers = make_prompts(64, gen)
    assert prompts.shape == (64, PROMPT_LEN) and prompts.dtype == torch.long
    assert torch.equal(prompts[:, 0] + prompts[:, 2], answers) and int(answers.max()) <= 8
    assert bool((prompts[:, 1] == PLUS).all() and (prompts[:, 3] == EQ).all())

    # Rewards, closed form: right and well formed, right but rambling, wrong but well formed, neither.
    comps = torch.tensor([[7, EOS, EOS], [7, 3, EOS], [5, EOS, EOS], [EOS, EOS, EOS], [PLUS, EOS, EOS]])
    ans = torch.full((5,), 7)
    assert accuracy_reward(comps, ans).tolist() == [1.0, 1.0, 0.0, 0.0, 0.0]
    assert format_reward(comps).tolist() == [1.0, 0.0, 1.0, 0.0, 0.0]
    assert compute_rewards(comps, ans).tolist() == [1.5, 1.0, 0.5, 0.0, 0.0]

    # One success among four: mean 0.25, unbiased std 0.5, so the advantages are 1.5 and -0.5.
    r = torch.tensor([1.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.5])
    adv = group_advantages(r, G=4, eps=0.0)
    assert torch.allclose(adv[:4], torch.tensor([1.5, -0.5, -0.5, -0.5]))
    # Each group's advantages sum to zero and have unit sample std.
    g = adv.view(-1, 4)
    assert torch.allclose(g.sum(1), torch.zeros(2), atol=1e-6)
    assert torch.allclose(g.std(1), torch.ones(2), atol=1e-6)
    # A group where every completion scores the same teaches nothing: zero advantage, not a division by zero.
    assert torch.equal(group_advantages(torch.full((4,), 1.5), G=4), torch.zeros(4))
    # Invariant to the reward's scale and offset when scaled; only shifted without scaling (Dr. GRPO).
    assert torch.allclose(group_advantages(10 * r + 3, 4, eps=0.0), adv, atol=1e-5)
    plain = group_advantages(r, G=4, scale=False)
    assert torch.allclose(plain, torch.tensor([0.75, -0.25, -0.25, -0.25, -0.75, -0.25, 0.25, 0.75]))
    assert torch.allclose(group_advantages(10 * r, 4, scale=False), 10 * plain)

    # Baseline: a uniform policy scores 1/13 on accuracy and (10/13)(1/13) on format.
    uniform = torch.randint(0, VOCAB, (200_000, 3), generator=gen)
    base = compute_rewards(uniform, torch.full((200_000,), 4)).mean().item()
    assert abs(base - (1 / 13 + 0.5 * 10 / 169)) < 0.005, base
    # A fresh policy's groups: per-group zero sum, and groups with one reward value carry no signal.
    policy = TinyLM(VOCAB, d_model=32, n_layer=2, n_head=2, max_len=8)
    prompts, answers = make_prompts(16, gen)
    seqs, mask = generate_group(policy, prompts, 8, 3, temperature=1.0, eos_id=EOS, generator=gen)
    rewards = compute_rewards(seqs[:, PROMPT_LEN:], answers.repeat_interleave(8))
    adv = group_advantages(rewards, G=8).view(16, 8)
    assert torch.allclose(adv.sum(1), torch.zeros(16), atol=1e-4)
    flat = rewards.view(16, 8).std(1) == 0
    assert torch.equal(adv[flat], torch.zeros_like(adv[flat]))
    print(f"uniform-policy reward {base:.3f} of 1.5; fresh policy {rewards.mean():.3f}, {int(flat.sum())} of 16 groups flat")
    print("PASS")
`,
    },
  },
  debrief: `PPO estimates each token's advantage with a learned value function, a second network as large as the policy, trained alongside it, and only as good as its fit. GRPO replaces it with a Monte Carlo baseline: sample G answers to the same prompt and use their mean reward. **The group is the baseline**, so the advantage is relative: an answer is good if it beats its siblings, and the same advantage is given to every token of the completion (outcome supervision). **Dividing by the std** puts every prompt on the same scale, which DeepSeekMath does; Dr. GRPO showed that it also weighs prompts by difficulty (with binary rewards and G = 8, a prompt solved 1 time in 8 has std 0.35 and its advantages are multiplied by 2.8, one solved 4 times in 8 has std 0.53 and gets 1.9), and drops it. **Zero-variance groups** give zero gradient, which is why DAPO's dynamic sampling over-samples and filters out prompts whose groups are all right or all wrong. **Verifiable rewards** are the R1 recipe: an accuracy check and a format check, both programs, so the policy cannot exploit a reward model's blind spots. What production adds: math answer parsers (boxed-answer extraction, symbolic equality), unit tests run in a sandbox for code, length penalties, several reward functions with weights (TRL's \`reward_funcs\` and \`reward_weights\`), and groups of 8 to 64 completions per prompt.`,
};
