import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {grpoRolloutStep} from './steps/1-grpo-rollout';
import {grpoAdvantageStep} from './steps/2-grpo-advantage';
import {grpoLossStep} from './steps/3-grpo-loss';
import {grpoTrainStep} from './steps/4-grpo-train';

/**
 * Deep-learning project: a GRPO trainer from scratch, after DeepSeekMath: group rollouts with a mask
 * through EOS, verifiable rewards and group-relative advantages, the clipped surrogate with a k3 KL
 * penalty, and the outer loop with μ inner steps that teaches a tiny policy addition on a CPU.
 */
export const ptGrpoProblem: Problem = {
  id: 'pt-grpo',
  title: 'A GRPO trainer from scratch',
  tagline:
    'Train a tiny language model with DeepSeekMath’s GRPO: G sampled answers per prompt, rewards a program checks, advantages normalised within each group, a clipped objective with a k3 KL penalty, and no value network.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 120,
  statement: `# A GRPO trainer from scratch

Group Relative Policy Optimization (GRPO) is the reinforcement-learning algorithm DeepSeek introduced
with DeepSeekMath (Shao et al., 2024) and used to train DeepSeek-R1's reasoning (2025). It sits after
pre-training and supervised fine-tuning: the model answers prompts, a program checks the answers, and
the model is pushed towards the answers that scored better. It is PPO without the value network: instead
of a learned critic estimating how good each state is, GRPO samples **G answers to the same prompt**
and uses their mean reward as the baseline, so an answer's advantage is how much it beat its siblings.
TRL's \`GRPOTrainer\`, verl and OpenRLHF implement it, and Dr. GRPO and DAPO are
variants of it.

You write four files, each importing the previous one:

\`grpo_rollout.py\`:

- \`TinyLM(vocab_size, d_model=32, n_layer=2, n_head=2, max_len=16)\`, a causal Transformer whose
  \`forward(idx (N, T) long)\` returns logits \`(N, T, V)\`;
- \`completion_mask(completions, eos_id) -> (N, L) float32\`, ones through the first EOS;
- \`generate_group(policy, prompts (B, P), G, max_new_tokens, temperature, eos_id, generator) ->
  (seqs (B·G, P + L) long, mask (B·G, L) float32)\`, prompt \`b\`'s group in rows \`b·G … b·G + G − 1\`;
- \`token_logprobs(model, input_ids, prompt_len, temperature=1.0) -> (N, L) float32\`.

\`grpo_advantage.py\`:

- the task: \`make_prompts(n, generator) -> (prompts (n, 4), answers (n,))\` for \`a + b =\` with
  \`a, b ∈ 0…4\`, vocabulary of 13 (digits, \`+\`, \`=\`, EOS);
- the rewards: \`accuracy_reward\`, \`format_reward\` and \`compute_rewards(…, weights=(1.0, 0.5))\`, each
  \`(N,)\` float32;
- \`group_advantages(rewards (B·G,), G, eps=1e-4, scale=True) -> (B·G,)\`.

\`grpo_loss.py\`:

- \`grpo_loss(logp, old_logp, ref_logp, advantages, mask, clip_eps=0.2, beta=0.04, agg="seq-mean") ->
  (loss, {"clip_frac", "kl"})\`, all per-token tensors \`(N, L)\` float32.

\`grpo_train.py\`:

- \`grpo_train(policy, iters, batch_prompts=32, G=8, mu=2, lr=3e-3, …) -> (ref, history)\`, the loop
  that trains \`TinyLM\` from random weights.

## What you build here

1. **Rollouts**: a tiny causal policy, G sampled completions per prompt in consecutive rows, a mask
   through the first EOS, and per-token log-probs by shift-and-gather.
2. **Rewards and advantages**: a toy task with an accuracy and a format reward, and \`(r − mean_g) /
   (std_g + ε)\` per group, or the mean-only Dr. GRPO variant.
3. **The loss**: the ratio \`π_θ / π_old\`, PPO's clipped surrogate, the k3 KL estimate to a frozen
   reference weighted by \`β\`, per-sequence or per-token aggregation, and the clip fraction and KL.
4. **The trainer**: sample, score without a graph, reward, normalise, then μ clipped AdamW steps on the
   same rollouts, until the policy answers \`a + b\` correctly.

## Run it on your machine

Put the four files in one directory and run \`python grpo_rollout.py\`, \`python grpo_advantage.py\`,
\`python grpo_loss.py\` and \`python grpo_train.py\` (PyTorch 2.x, CPU only). The first three take about a
second each; the trainer takes about 6 s for 200 iterations of 32 prompts × 8 completions. Each prints
\`PASS\`: the rollout's against a per-prefix loop, the advantages against closed forms, the loss's gradients
against the policy gradient and the clipping rule and its KL estimate against the exact KL, and the
trainer by taking the mean reward from about 0.13 to above 1.2 of 1.5 while the reference stays fixed.

## Left out on purpose

A pretrained model, a tokenizer and chat templates; a KV cache during sampling and a separate rollout
engine (vLLM) with weight syncing; left-padded prompts of different lengths; learned reward models and
process rewards; DAPO's clip-higher and dynamic sampling (discussed in the debriefs); the reference
refreshed every outer iteration as in DeepSeekMath's Algorithm 1; and FSDP or ZeRO sharding of the
policy, reference and optimizer across GPUs.`,
  figures: [
    {
      title: 'One GRPO iteration',
      architecture: {
        input: 'TinyLM · random init',
        output: 'updated policy π_θ',
        items: [
          {
            id: 'ref-copy',
            label: 'Frozen reference π_ref',
            kind: 'embed',
            sub: 'deepcopy · requires_grad_(False)',
            detail:
              'A copy of the policy taken before the first update, never given to the optimizer. The KL penalty measures how far the policy has drifted from it.',
          },
          {
            tone: 'block',
            repeat: 'iters ×',
            label: 'One iteration',
            items: [
              {
                id: 'prompts',
                label: 'Prompt batch q',
                kind: 'io',
                sub: 'make_prompts · [a, +, b, =]',
                shape: '(B, 4)',
                detail: '`B = 32` problems `a + b =` with `a, b ∈ 0…4`, drawn from the seeded generator.',
              },
              {
                id: 'rollout',
                label: 'Sample G answers each',
                kind: 'attention',
                sub: 'generate_group(π_old) · no_grad',
                shape: 'seqs (B·G, 4 + L)',
                detail:
                  'The current policy, frozen as `π_old` for this iteration, samples `G = 8` completions per prompt at temperature 1. Rows `b·G … b·G + G − 1` are prompt `b`’s group; the mask covers each completion through its first EOS.',
              },
              {
                columns: [
                  [
                    {
                      id: 'reward',
                      label: 'Verifiable rewards',
                      sub: 'accuracy + 0.5 · format',
                      shape: 'r (B·G,)',
                      detail:
                        'Programs, not a reward model: 1 when the first token is the right digit, plus 0.5 when the completion is one digit then EOS.',
                    },
                    {
                      id: 'group-norm',
                      label: 'Group normalisation',
                      kind: 'norm',
                      sub: '(r − mean_g) / (std_g + ε)',
                      shape: 'A (B·G,)',
                      detail:
                        'Rewards viewed as `(B, G)`; each completion is scored against its own group. This replaces PPO’s value model and GAE. A group with one reward value gets `A = 0`.',
                    },
                  ],
                  [
                    {
                      id: 'old-logp',
                      label: 'Old log-probs',
                      sub: 'token_logprobs(π_old) · no_grad',
                      shape: '(B·G, L)',
                      detail:
                        'The probability each token was sampled with: the denominator of the ratio for all μ inner steps.',
                    },
                  ],
                  [
                    {
                      id: 'ref-logp',
                      label: 'Reference log-probs',
                      sub: 'token_logprobs(π_ref) · no_grad',
                      shape: '(B·G, L)',
                      detail: 'The frozen copy scores the same tokens, for the per-token KL estimate.',
                    },
                  ],
                ],
              },
              {
                tone: 'dotted',
                repeat: 'μ ×',
                label: 'Inner steps, same rollouts',
                items: [
                  {
                    id: 'new-logp',
                    label: 'Policy log-probs',
                    kind: 'attention',
                    sub: 'token_logprobs(π_θ) · with graph',
                    shape: 'logp (B·G, L)',
                    detail:
                      'The only pass with an autograd graph: one teacher-forced forward over the finished sequences.',
                  },
                  {
                    id: 'ratio',
                    label: 'Ratio ρ',
                    sub: 'exp(logp − old_logp)',
                    detail:
                      'Exactly 1 at the first inner step; it drifts as the policy is updated on the same samples.',
                  },
                  {
                    columns: [
                      [
                        {
                          id: 'surrogate',
                          label: 'Clipped surrogate',
                          sub: 'min(ρA, clip(ρ, 1 ± ε)A)',
                          detail:
                            'PPO’s pessimistic bound: no gradient once a token has moved more than `ε = 0.2` in the direction its advantage asks for.',
                        },
                      ],
                      [
                        {
                          id: 'kl',
                          label: 'KL penalty, k3',
                          sub: 'e^(ref−logp) − (ref−logp) − 1',
                          detail:
                            'Schulman’s k3 estimate of `KL(π_θ ‖ π_ref)` per sampled token: unbiased and never negative. Added to the loss, not to the reward.',
                        },
                      ],
                    ],
                  },
                  {
                    id: 'loss',
                    label: 'GRPO loss',
                    kind: 'loss',
                    sub: '−surrogate + β · k3 · seq-mean',
                    detail:
                      '`seq-mean` averages each completion over its tokens, then over completions; `token-mean` (DAPO) averages over every token of the batch.',
                  },
                  {
                    id: 'adamw',
                    label: 'AdamW step',
                    sub: 'clip_grad_norm_ 1.0 · π_θ only',
                    detail:
                      '`lr = 3e-3`, `betas = (0.9, 0.99)`, no weight decay; the reference is not in the optimizer.',
                  },
                ],
              },
            ],
          },
        ],
        notes: [
          {at: 'rollout', text: '**G = 8** completions per prompt'},
          {at: 'group-norm', text: '**No value model**: the group mean is the baseline'},
          {at: 'surrogate', text: 'Clip **ε = 0.2**'},
          {at: 'kl', text: '**β = 0.04**', side: 'left'},
          {at: 'adamw', text: '**μ = 2** steps per rollout batch'},
        ],
      },
    },
    {
      title: 'The rollout batch',
      gpu: {
        layout: 'column',
        align: 'start',
        items: [
          {
            id: 'group-0',
            label: 'Prompt 0 · 3 + 1 = · rows 0 to 3',
            count: 'A = 1.16 · .39 · −.39 · −1.16',
            detail:
              'Rewards 1.5, 1.0, 0.5, 0: mean 0.75, unbiased std 0.65, so `A = (r − 0.75) / 0.65`. The four advantages sum to 0.',
            items: [
              {
                id: 'seqs',
                array: 'seqs[0:4]',
                sub: 'prompt | completion',
                cols: 7,
                rows: 4,
                cells: [
                  ...['3', '+', '1', '=', '4', 'E', 'E'],
                  ...['3', '+', '1', '=', '4', '7', 'E'],
                  ...['3', '+', '1', '=', '2', 'E', 'E'],
                  ...['3', '+', '1', '=', '+', '3', '9'],
                ],
                marks: [
                  {cols: [6, 6], rows: [0, 0], tone: 'muted'},
                  {cols: [6, 6], rows: [2, 2], tone: 'muted'},
                ],
                detail:
                  '`seqs` is `(B·G, 4 + L)`: prompt `b`’s group in rows `b·G … b·G + G − 1` (`repeat_interleave(G, dim=0)`). `E` is EOS; a row that has stopped keeps receiving EOS (grey). Row 3 never stopped and was cut at `max_new_tokens = 3`.',
              },
              {
                id: 'mask',
                array: 'mask[0:4]',
                sub: 'through 1st EOS',
                cols: 3,
                rows: 4,
                cells: [...['1', '1', '0'], ...['1', '1', '1'], ...['1', '1', '0'], ...['1', '1', '1']],
                marks: [
                  {cols: [2, 2], rows: [0, 0], tone: 'muted'},
                  {cols: [2, 2], rows: [2, 2], tone: 'muted'},
                ],
                detail:
                  '`completion_mask`, `(B·G, L)` float32: ones through the first EOS, which the completion owns (the policy chose to stop), zeros on the padding after it.',
              },
              {
                id: 'rewards',
                array: 'r',
                sub: 'reward',
                cols: 1,
                rows: 4,
                cells: ['1.5', '1', '.5', '0'],
                detail:
                  'Right and well formed 1.5; right with an extra token 1.0; wrong but well formed 0.5; `+` is not a digit, 0.',
              },
            ],
          },
          {
            id: 'group-1',
            label: 'Prompt 1 · 2 + 2 = · rows 4 to 7',
            count: 'flat: A = 0 · 0 · 0 · 0',
            detail:
              'Every completion scored 1.5, so the std is 0, `r − mean = 0` exactly and every advantage is 0: this prompt contributes no gradient, only the KL term acts on it.',
            items: [
              {
                array: 'seqs[4:8]',
                sub: 'prompt | completion',
                cols: 7,
                rows: 4,
                cells: [
                  ...['2', '+', '2', '=', '4', 'E', 'E'],
                  ...['2', '+', '2', '=', '4', 'E', 'E'],
                  ...['2', '+', '2', '=', '4', 'E', 'E'],
                  ...['2', '+', '2', '=', '4', 'E', 'E'],
                ],
                marks: [{cols: [6, 6], rows: [0, 3], tone: 'muted'}],
              },
              {
                array: 'mask[4:8]',
                sub: 'through 1st EOS',
                cols: 3,
                rows: 4,
                cells: [...['1', '1', '0'], ...['1', '1', '0'], ...['1', '1', '0'], ...['1', '1', '0']],
                marks: [{cols: [2, 2], rows: [0, 3], tone: 'muted'}],
              },
              {array: 'r', sub: 'reward', cols: 1, rows: 4, cells: ['1.5', '1.5', '1.5', '1.5']},
            ],
          },
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models',
      url: 'https://arxiv.org/abs/2402.03300',
      by: 'Zhihong Shao et al.',
      date: '2024-02-05',
      venue: 'arXiv',
      takes:
        'GRPO itself: `G` outputs per question as the baseline instead of a value model, the clipped per-token objective with `seq-mean` aggregation, the k3 KL term added to the loss, and the `μ` inner steps `grpo_train` runs.',
    },
    {
      kind: 'paper',
      title: 'Proximal Policy Optimization Algorithms',
      url: 'https://arxiv.org/abs/1707.06347',
      by: 'John Schulman et al.',
      date: '2017-07-20',
      venue: 'arXiv',
      takes:
        'The clipped surrogate `min(ρA, clip(ρ, 1 − ε, 1 + ε)A)` with `ε = 0.2`, and several epochs of updates on one batch of samples: `grpo_loss` keeps the first unchanged and `grpo_train` the second as `μ`.',
    },
    {
      kind: 'paper',
      title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
      url: 'https://arxiv.org/abs/2501.12948',
      by: 'DeepSeek-AI',
      date: '2025-01-22',
      venue: 'Nature 2025',
      takes:
        'GRPO with rule-based rewards and no supervised warm-up (R1-Zero): the accuracy and format rewards that `compute_rewards` sums.',
    },
    {
      kind: 'paper',
      title: 'Understanding R1-Zero-Like Training: A Critical Perspective',
      url: 'https://arxiv.org/abs/2503.20783',
      by: 'Zichen Liu et al.',
      date: '2025-03-26',
      venue: 'COLM 2025',
      takes:
        'Dr. GRPO: the difficulty bias of dividing by the group std and the length bias of per-sequence means, hence `scale=False` in `group_advantages`.',
    },
    {
      kind: 'paper',
      title: 'DAPO: An Open-Source LLM Reinforcement Learning System at Scale',
      url: 'https://arxiv.org/abs/2503.14476',
      by: 'Qiying Yu et al.',
      date: '2025-03-18',
      venue: 'NeurIPS 2025',
      takes:
        'Token-level aggregation, `agg="token-mean"` in `grpo_loss`, and the clip-higher and dynamic-sampling fixes the debriefs discuss.',
    },
    {
      kind: 'code',
      title: 'TRL',
      url: 'https://github.com/huggingface/trl',
      by: 'Hugging Face',
      date: '2020-03-27',
      venue: 'GitHub',
      takes:
        '`GRPOTrainer`: `std + 1e-4`, log-probs at the sampling temperature, `num_iterations` as `μ`, and `loss_type` (`grpo`, `bnpo`, `dr_grpo`, `dapo`) for the aggregations.',
    },
  ],
  steps: [grpoRolloutStep, grpoAdvantageStep, grpoLossStep, grpoTrainStep],
  learn,
};
