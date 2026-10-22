import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {dpoLogprobsStep} from './steps/1-dpo-logprobs';
import {dpoLossStep} from './steps/2-dpo-loss';
import {dpoTrainStep} from './steps/3-dpo-train';

/**
 * Deep-learning problem: Direct Preference Optimization from scratch, after the DPO authors' trainer.
 * Summed response log-probs with one forward for chosen and rejected, the loss with its cDPO and IPO
 * variants and implicit rewards, and a training loop against a frozen reference on a toy preference set.
 */
export const ptDpoProblem: Problem = {
  id: 'pt-dpo',
  title: 'DPO from scratch: log-probs, loss, frozen reference',
  tagline:
    'Align a tiny LM to preference pairs with Direct Preference Optimization: summed response log-probs in one padded forward, −log σ(β·h) with its cDPO and IPO variants, and a training loop against a frozen reference.',
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 60,
  statement: `# DPO from scratch: log-probs, loss, frozen reference

Direct Preference Optimization (Rafailov et al., Stanford, 2023) is how most open models are aligned
after supervised fine-tuning: Zephyr, Tülu 2, Llama 3's post-training and many more use it or a
variant. RLHF as InstructGPT ran it trains a reward model on human preference pairs and then optimises
the policy against that reward with PPO, a KL penalty keeping it near the SFT model. DPO shows that the
optimum of that objective can be written in terms of the policy itself, so the reward model's logistic
loss on the pairs becomes a loss on the policy: no reward model, no sampling, no value head. It sits
in the post-training stage of the stack, after pretraining and SFT, and needs only two copies of the
model: the policy being trained and a frozen reference.

You write three files after the authors' reference trainer, each importing the previous one:

- \`dpo_logprobs.py\`: \`sequence_logprobs(model, input_ids (N, T) long, attention_mask (N, T) long,
  prompt_lengths (N,) long) -> (N,) float32\`, the sum of the response tokens' log-probabilities with
  prompt and padding masked, and \`concatenated_forward(model, batch) -> (chosen_logps (B,),
  rejected_logps (B,))\`, both halves in one padded forward. \`TinyLM\` (embedding, GRU, head) and
  \`right_pad\` are given.
- \`dpo_loss.py\`: \`dpo_loss(policy_chosen_logps, policy_rejected_logps, reference_chosen_logps,
  reference_rejected_logps, beta=0.1, label_smoothing=0.0, loss_type="sigmoid" | "ipo") -> dict\` with
  \`"losses"\` \`(B,)\`, the detached implicit rewards \`β·(log π − log π_ref)\` per side, the reward
  accuracy and the reward margin.
- \`dpo_train.py\`: \`make_reference(policy)\` (a deep copy in eval mode, no grad), \`dpo_step(policy,
  reference, batch, optimizer, beta, …) -> dict[str, float]\` and \`train_dpo(policy, pairs, steps=150,
  …) -> (reference, history)\` on a toy preference set: sort three digits ascending, not descending.

## What you build here

1. **Sequence log-probs**: the shift by one, \`log_softmax\` in float32, \`gather\`, the prompt and padding
   mask, the sum per row, and chosen and rejected as \`2B\` rows of one forward.
2. **The loss**: the margin \`h\` of the policy's log-ratio over the reference's, \`−log σ(β·h)\`, label
   smoothing (conservative DPO), IPO's \`(h − 1/(2β))²\`, and the implicit rewards with their accuracy and
   margin.
3. **Training**: a frozen reference, the reference forward without a graph, one AdamW step per batch
   with clipping, and the metrics a DPO run logs.

## Run it on your machine

Put the three files in one directory and run \`python dpo_logprobs.py\`, \`python dpo_loss.py\` and
\`python dpo_train.py\` (PyTorch 2.x, CPU only, about 1, 1 and 2 seconds on a laptop). Each prints
\`PASS\`: the log-probs match a slow per-token loop to \`1e-4\`, the loss matches its closed forms and its
gradient is \`−β·σ(−β·h)\`, and training starts at \`ln 2\`, reaches a reward accuracy of 1.0 on all 32
pairs with a growing margin, and leaves every reference parameter bit-identical.

## Left out on purpose

The SFT stage before DPO (here the reference is a random \`TinyLM\`), tokenisation and chat templates,
a real preference dataset (Anthropic HH, UltraFeedback), Hugging Face models, \`trl\` and its
\`DPOTrainer\`, LoRA, bf16 and FSDP, precomputing the reference log-probs, length-normalised IPO and
SimPO, online and iterative DPO, KTO, ORPO, and evaluation by sampling and judging.`,
  figures: [
    {
      title: 'One DPO step',
      architecture: {
        input: 'policy π_θ (the SFT model) · preference pairs',
        output: 'updated policy · reference unchanged',
        items: [
          {
            id: 'freeze',
            label: 'Freeze the reference',
            sub: 'deepcopy · eval() · no grad',
            detail:
              '`make_reference(policy)`, once, before the first step: `copy.deepcopy`, `.eval()`, `.requires_grad_(False)`. Same weights as the policy at step 0, so `h = 0` and the first loss is `ln 2`.',
          },
          {
            tone: 'block',
            repeat: 'steps ×',
            label: 'One DPO step',
            items: [
              {
                id: 'pairs',
                label: 'Preference batch',
                kind: 'io',
                sub: 'B × (prompt x, y_w, y_l)',
                shape: 'B triples of token lists',
                detail:
                  'Fixed, offline pairs: a prompt, the chosen response `y_w` and the rejected one `y_l`. DPO never samples from the policy.',
              },
              {
                id: 'concat',
                label: 'Concatenate and pad',
                sub: '2B rows: x+y_w, then x+y_l',
                shape: '(2B, T) ids · mask',
                detail:
                  '`concatenated_forward`: every prompt + chosen, then every prompt + rejected, right padded to one width, with `prompt_lengths` for the mask.',
              },
              {
                columns: [
                  [
                    {
                      id: 'policy',
                      label: 'Policy forward',
                      kind: 'attention',
                      sub: 'π_θ · with grad',
                      detail: 'The model being trained, in train mode; its activations are kept for the backward.',
                    },
                    {
                      id: 'pi-logps',
                      label: 'Policy log-probs',
                      sub: 'log π(y_w|x), log π(y_l|x)',
                      shape: '(B,), (B,)',
                      detail:
                        '`sequence_logprobs` split at `B`: the summed log-probabilities of each response, prompt and padding masked.',
                    },
                  ],
                  [
                    {
                      id: 'reference',
                      label: 'Reference forward',
                      sub: 'π_ref · torch.no_grad()',
                      detail:
                        'The frozen copy, under `torch.no_grad()`: no graph, no gradient, no optimizer state. Its log-probs never change, so production computes them once before training.',
                    },
                    {
                      id: 'ref-logps',
                      label: 'Reference log-probs',
                      sub: 'log ref(y_w|x), log ref(y_l|x)',
                      shape: '(B,), (B,)',
                    },
                  ],
                ],
              },
              {
                id: 'margin',
                label: 'Log-ratio margin h',
                sub: '(π_w − π_l) − (ref_w − ref_l)',
                shape: '(B,)',
                detail:
                  'How much more the policy prefers `y_w` over `y_l` than the reference did. The implicit rewards `β·(log π − log π_ref)` per side are logged from the same four numbers, detached.',
              },
              {
                id: 'loss',
                label: 'DPO loss',
                kind: 'loss',
                sub: '−log σ(β·h) · mean over B',
                side: {
                  label: 'cDPO, IPO',
                  sub: 'ε smoothing · (h − 1/2β)²',
                  detail:
                    '`label_smoothing = ε` mixes in the flipped pair: `−(1−ε)·log σ(βh) − ε·log σ(−βh)`. `loss_type="ipo"` regresses `h` to `1/(2β)` instead.',
                },
                detail:
                  'Logistic regression on `h`. Its gradient with respect to `h` is `−β·σ(−β·h)`: large for a mis-ranked pair, small once the pair is ranked well.',
              },
              {
                id: 'backward',
                label: 'Backward',
                sub: 'loss.backward() · into π_θ only',
                detail:
                  'The gradient is `−β·σ(−β·h)·(∇ log π(y_w) − ∇ log π(y_l))`: raise the chosen, lower the rejected, weighted by how wrong the ranking is.',
              },
              {
                id: 'adamw',
                label: 'AdamW step',
                sub: 'clip_grad_norm_(1.0) · step()',
                detail: '`torch.optim.AdamW(policy.parameters(), …)`: the reference is not in the optimizer.',
              },
            ],
          },
        ],
        notes: [
          {at: 'freeze', text: 'Step 0: **h = 0**, loss **ln 2 = 0.693**'},
          {at: 'concat', text: '**One** forward per model for 2B rows'},
          {at: 'reference', text: '**No** graph, **no** optimizer state'},
          {at: 'margin', text: 'Logged: rewards **β·(log π − log ref)**'},
          {at: 'loss', text: 'β = **0.1**: the KL coefficient'},
        ],
      },
    },
    {
      title: 'Sequence log-probability',
      architecture: {
        input: '(2B, T) ids · mask · prompt_lengths',
        output: 'chosen_logps (B,) · rejected_logps (B,)',
        items: [
          {
            id: 'lm',
            label: 'Causal LM forward',
            kind: 'attention',
            sub: 'model(input_ids, attention_mask)',
            shape: '(2B, T, V)',
            detail:
              'Any causal LM: here `TinyLM` (embedding, one GRU layer, a 16-way head); a Hugging Face model returns the same tensor as `.logits`.',
          },
          {
            columns: [
              [
                {
                  id: 'shift-logits',
                  label: 'Drop the last position',
                  sub: 'logits[:, :-1].float()',
                  shape: '(2B, T−1, V)',
                  detail: 'Row `t` predicts token `t + 1`; the last row predicts past the end and is dropped.',
                },
                {
                  id: 'log-softmax',
                  label: 'Log-softmax over V',
                  kind: 'norm',
                  sub: 'torch.log_softmax(dim=-1)',
                  detail: 'In float32: bf16 logits would round away the small policy and reference differences.',
                },
              ],
              [
                {
                  id: 'shift-labels',
                  label: 'Labels, shifted by one',
                  sub: 'input_ids[:, 1:]',
                  shape: '(2B, T−1)',
                  detail: 'The token actually at each predicted position; the first token is never predicted.',
                },
              ],
            ],
          },
          {
            id: 'gather',
            label: 'Pick each label’s log-prob',
            sub: 'gather(logps, 2, labels[..., None])',
            shape: '(2B, T−1)',
            detail: 'One number per position: `log p(token t + 1 | tokens 0..t)`.',
          },
          {
            id: 'mask-sum',
            label: 'Mask and sum',
            sub: '(per_token · mask).sum(-1)',
            shape: '(2B,)',
            side: {
              label: 'Response mask',
              sub: 'mask[:, 1:] & pos ≥ prompt_len',
              detail:
                'Aligned with the labels: 1 on response tokens, 0 on the prompt and on padding. Built with `torch.arange` against `prompt_lengths[:, None]`.',
            },
            detail: 'The sum is `log π(y | x)` of the whole response: a product of token probabilities, in log space.',
          },
          {
            id: 'split',
            label: 'Split chosen | rejected',
            kind: 'io',
            sub: 'logps[:B], logps[B:]',
          },
        ],
        notes: [
          {at: 'shift-logits', text: 'Row t predicts token **t + 1**', side: 'left'},
          {at: 'log-softmax', text: 'In **float32**, even for a bf16 model'},
          {at: 'mask-sum', text: 'Prompt and padding count **0**'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Direct Preference Optimization: Your Language Model is Secretly a Reward Model',
      url: 'https://arxiv.org/abs/2305.18290',
      by: 'Rafael Rafailov et al.',
      date: '2023-05-29',
      venue: 'NeurIPS 2023',
      takes:
        'The derivation from the KL-regularised RLHF objective to `−log σ(β·h)`, the implicit reward `β·log(π/π_ref)` and the gradient weight `σ(−β·h)` that `dpo_loss` implements.',
    },
    {
      kind: 'paper',
      title: 'A General Theoretical Paradigm to Understand Learning from Human Preferences',
      url: 'https://arxiv.org/abs/2310.12036',
      by: 'Mohammad Gheshlaghi Azar et al.',
      date: '2023-10-18',
      venue: 'AISTATS 2024',
      takes:
        'IPO: why DPO overfits deterministic preferences, and the squared loss `(h − 1/(2β))²` behind `loss_type="ipo"`.',
    },
    {
      kind: 'paper',
      title: 'Training language models to follow instructions with human feedback',
      url: 'https://arxiv.org/abs/2203.02155',
      by: 'Long Ouyang et al.',
      date: '2022-03-04',
      venue: 'NeurIPS 2022',
      takes:
        'The RLHF pipeline DPO replaces: SFT, a Bradley–Terry reward model on human comparisons, then PPO with a KL penalty to the SFT model.',
    },
    {
      kind: 'code',
      title: 'direct-preference-optimization',
      url: 'https://github.com/eric-mitchell/direct-preference-optimization',
      by: 'Eric Mitchell',
      date: '2023-06-22',
      venue: 'GitHub',
      takes:
        'The reference trainer this problem follows: `_get_batch_logps`, `concatenated_forward` and `preference_loss` with `label_smoothing` and `ipo`.',
    },
    {
      kind: 'code',
      title: 'TRL',
      url: 'https://github.com/huggingface/trl',
      by: 'Hugging Face',
      date: '2020-03-27',
      venue: 'GitHub',
      takes:
        'The production `DPOTrainer`: `loss_type="sigmoid"` and `"ipo"` (on length-averaged log-probs), `precompute_ref_log_probs`, and the base model as the reference of a LoRA policy.',
    },
    {
      kind: 'post',
      title: 'Illustrating Reinforcement Learning from Human Feedback (RLHF)',
      url: 'https://huggingface.co/blog/rlhf',
      by: 'Nathan Lambert et al.',
      date: '2022-12-09',
      venue: 'Hugging Face blog',
      takes:
        'The three-stage RLHF pipeline and its KL penalty against the initial model, the context the guide sets DPO in.',
    },
  ],
  steps: [dpoLogprobsStep, dpoLossStep, dpoTrainStep],
  learn,
};
