import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {chatTemplateStep} from './steps/1-chat-template';
import {packingStep} from './steps/2-packing';
import {sftStepStep} from './steps/3-sft-step';

/**
 * Deep-learning project: supervised fine-tuning's data path in PyTorch. The Llama 3 chat template with
 * assistant-only labels, first-fit-decreasing packing with per-document positions and a block-diagonal
 * causal mask, and gradient accumulation normalised by the target tokens of every micro-batch.
 */
export const ptSftPackingProblem: Problem = {
  id: 'pt-sft-packing',
  title: 'Supervised fine-tuning: template, packing, loss',
  tagline:
    'Render chats in the Llama 3 format with labels on assistant turns only, pack them into rows that no chat can see across, and accumulate micro-batches into the exact full-batch gradient.',
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 60,
  statement: `# Supervised fine-tuning: chat template, packing, token-normalised loss

Supervised fine-tuning (SFT) is the first stage of post-training. A pretrained base model is trained on demonstrations of the behaviour wanted, conversations whose assistant turns were written or chosen by people. InstructGPT (Ouyang et al., OpenAI, 2022) starts with it, fine-tuning GPT-3 on labeler-written demonstrations for about 13k prompts before reward modelling and PPO. Llama 3's post-training alternates SFT with DPO over several rounds. The objective is pretraining's next-token cross-entropy; what changes is the data path in front of it:

- every conversation is rendered with the model's chat template;
- the loss is taken on the assistant's tokens only;
- many short chats are packed into fixed rows;
- micro-batches are accumulated into one optimizer step.

TRL's \`SFTTrainer\` and the Hugging Face \`Trainer\` implement this path. Each piece has an obvious version that runs without error and trains a different model: one that learns to write user turns, chats that read each other, micro-batches that weigh tokens unequally.

You write three files, each importing the previous one:

- \`sft_template.py\`: a byte tokenizer, \`encode(text) -> list[int]\` (UTF-8 bytes, ids 0 to 255) and \`decode(ids) -> str\`, with Llama 3's six special tokens at ids 256 to 261 (\`BOS_ID\`, \`EOS_ID\`, \`START_HEADER_ID\`, \`END_HEADER_ID\`, \`EOT_ID\`, \`PAD_ID\`), \`VOCAB_SIZE = 262\` and \`IGNORE_INDEX = -100\`; \`header(role) -> list[int]\`; and \`render(messages, max_len, add_generation_prompt=False) -> (input_ids, labels)\`, both \`(L,)\` \`torch.long\` with \`L ≤ max_len\`, the labels \`-100\` except on assistant content and its \`<|eot_id|>\`.
- \`sft_packing.py\`: \`pack(examples, seq_len) -> dict\` with \`input_ids\`, \`labels\` and \`position_ids\` of shape \`(R, seq_len)\` \`torch.long\`, \`cu_seqlens\` (R \`int32\` tensors) and \`docs\`; and \`document_causal_mask(cu_seqlens, seq_len) -> (seq_len, seq_len)\` \`bool\`. Given: \`TinyCausalLM\` (embedding, one single-head attention layer that honours a mask and position ids, a head), \`batch_logits\`, \`pad_rows\` and \`padding_waste\`.
- \`sft_step.py\`: \`count_targets(batch) -> int\`, \`token_loss_sum(model, batch)\` (a 0-d tensor), \`accumulate_gradients(model, micro_batches) -> float\` and \`sft_step(model, optimizer, micro_batches, max_grad_norm=1.0) -> float\`.

## What you build here

1. **The chat template**: the Llama 3 format byte for byte, special tokens that text cannot forge, labels on assistant turns and their \`<|eot_id|>\` only, a generation prompt, truncation that keeps the beginning.
2. **Packing**: first-fit decreasing into fixed rows, positions that restart per document, \`cu_seqlens\`, and a block-diagonal causal mask, so each packed chat computes exactly the losses it computes alone.
3. **The SFT step**: gradient accumulation whose loss is divided by the target tokens of all micro-batches, then one clip and one AdamW step.

## Run it on your machine

Put the three files in one directory and run \`python sft_template.py\`, \`python sft_packing.py\` and \`python sft_step.py\` (PyTorch 2.x on a CPU; about 1 s, 1 s and 3 s). Each prints \`PASS\`:

- the template, when a five-turn chat gives the exact 80 ids of the Llama 3 format with 9 labelled tokens;
- packing, when 16 chats fill 8 rows instead of 16 (padding 56.6 % → 13.3 %) and every packed chat's per-token losses equal its losses alone within 1e-6, while one causal mask over the row changes them;
- the step, when the gradient accumulated over micro-batches of 216, 390 and 860 target tokens equals the full-batch gradient within 1e-6, and the mean of per-micro-batch means does not.

## Left out on purpose

- A real tokenizer: Llama 3's 128,256-token BPE, and the Jinja template behind \`apply_chat_template\`, with its tool calls and dated system header.
- Varlen attention kernels (\`flash_attn_varlen_func\`, FlexAttention block masks), which skip the masked tiles instead of materialising an \`(S, S)\` mask.
- Streaming datasets with on-the-fly packing, LoRA, mixed precision, and the all-reduce of the target count across data-parallel ranks.
- Preference stages after SFT (DPO, RLHF).`,
  figures: [
    {
      title: 'SFT data path',
      architecture: {
        input: 'messages · [{role, content}, …]',
        output: 'one optimizer step per batch',
        items: [
          {
            id: 'conversation',
            label: 'Conversation',
            kind: 'io',
            sub: 'system · user · assistant turns',
            detail:
              'A list of `{"role", "content"}` messages. The test chat has five: system, user, assistant, user, assistant.',
          },
          {
            id: 'template',
            label: 'Llama 3 chat template',
            sub: 'render(messages, max_len)',
            detail:
              '`<|begin_of_text|>` once, then per turn `<|start_header_id|>role<|end_header_id|>`, two newlines, the content bytes and `<|eot_id|>`. Cut to `max_len`, keeping the beginning.',
          },
          {
            columns: [
              [
                {
                  id: 'input-ids',
                  label: 'input_ids',
                  sub: '(L,) long · bytes + 6 specials',
                  shape: '(L,)',
                  detail:
                    'Ids 0 to 255 are UTF-8 bytes; 256 to 261 are the special tokens, emitted only by the template. Text that spells `<|eot_id|>` stays 10 bytes.',
                },
              ],
              [
                {
                  id: 'loss-mask',
                  label: 'labels',
                  kind: 'loss',
                  sub: '−100 except assistant + eot',
                  shape: '(L,)',
                  detail:
                    '`labels[t] = input_ids[t]` on assistant content and its `<|eot_id|>`, `-100` on the BOS, every header and every system and user token. Not shifted: the loss pairs `logits[t]` with `labels[t + 1]`.',
                },
              ],
            ],
          },
          {
            id: 'packer',
            label: 'Packer',
            sub: 'first-fit decreasing into seq_len',
            side: {
              label: 'pad_rows',
              sub: 'one chat per row',
              detail: 'The padded baseline the self-test compares against: 16 rows and 56.6 % padding.',
            },
            detail:
              'Chats longest first, each whole into the first row with room; a chat longer than `seq_len` raises. The first label of every chat is set to `-100`.',
          },
          {
            columns: [
              [
                {
                  id: 'rows',
                  label: 'Rows',
                  sub: 'ids, labels · (R, S) long',
                  shape: '(R, S)',
                  detail: 'Filled with `PAD_ID` and `-100` first, then each chat copied in at its offset.',
                },
              ],
              [
                {
                  id: 'positions',
                  label: 'position_ids',
                  sub: '0 … len − 1 per chat',
                  shape: '(R, S)',
                  detail:
                    'Restart at every chat, so a chat at offset 300 reads the position rows it would read alone. The padding tail counts from 0 too.',
                },
              ],
              [
                {
                  id: 'cu-seqlens',
                  label: 'cu_seqlens',
                  sub: '[0, l1, l1 + l2, …, S] int32',
                  detail:
                    'Segment boundaries per row, the padding tail its own last segment: the layout varlen attention kernels take.',
                },
              ],
            ],
          },
          {
            id: 'doc-mask',
            label: 'Document-masked attention',
            kind: 'attention',
            sub: 'TinyCausalLM · one layer',
            shape: '(R, S, 262)',
            side: {
              label: 'Block-diagonal mask',
              sub: 'same segment ∧ j ≤ i',
              detail:
                '`document_causal_mask(cu_seqlens, S)`: `(S, S)` bool, one lower triangle per segment, `False` across segments.',
            },
            detail:
              'Scores outside the mask are set to `-inf` before the softmax, so no chat sees another. Per-token losses equal each chat run alone.',
          },
          {
            id: 'count',
            label: 'Count the targets',
            sub: 'N = Σ labels[:, 1:] ≠ −100',
            detail: '`num_items_in_batch`, over every micro-batch of the step, before the first backward.',
          },
          {
            tone: 'block',
            repeat: 'micro-batches ×',
            label: 'Gradient accumulation',
            items: [
              {
                id: 'loss-sum',
                label: 'Summed cross-entropy',
                kind: 'loss',
                sub: "reduction='sum'",
                detail: 'Shifted logits against shifted labels, `ignore_index=-100`: ignored positions add 0.',
              },
              {
                id: 'backward',
                label: 'Backward of sum / N',
                sub: '(loss_sum / N).backward()',
                detail: 'Gradients add up in `.grad`; after the last micro-batch they equal the full-batch gradient.',
              },
            ],
          },
          {
            id: 'clip-step',
            label: 'Clip, then step',
            sub: 'clip_grad_norm_ · AdamW',
            detail: 'One clip of the whole accumulated gradient, then `optimizer.step()`.',
          },
        ],
        notes: [
          {at: 'loss-mask', text: '**9** of **80** ids trained in the test chat'},
          {at: 'packer', text: '16 chats in **8** rows, not 16'},
          {at: 'rows', text: 'Padding **56.6 %** → **13.3 %**', side: 'left'},
          {at: 'doc-mask', text: 'Losses equal each chat alone, **≤ 1e-6**'},
          {at: 'count', text: '**216 + 390 + 860** targets, one N', side: 'left'},
        ],
      },
    },
    {
      title: 'Packed rows',
      gpu: {
        layout: 'column',
        items: [
          {
            label: 'Padded · 4 rows × 32',
            tone: 'scope',
            items: [
              {
                id: 'padded-ids',
                array: 'input_ids',
                sub: 'one chat per row · 79 of 128 slots pad',
                cols: 32,
                rows: 4,
                marks: [
                  {rows: [0, 0], cols: [0, 16], tone: 'global', label: 'A · 17'},
                  {rows: [1, 1], cols: [0, 11], tone: 'global', label: 'B · 12'},
                  {rows: [2, 2], cols: [0, 10], tone: 'global', label: 'C · 11'},
                  {rows: [3, 3], cols: [0, 8], tone: 'global', label: 'D · 9'},
                  {rows: [0, 0], cols: [17, 31], tone: 'muted'},
                  {rows: [1, 1], cols: [12, 31], tone: 'muted'},
                  {rows: [2, 2], cols: [11, 31], tone: 'muted'},
                  {rows: [3, 3], cols: [9, 31], tone: 'muted'},
                ],
                detail:
                  'Padded batching: every chat gets a row of its own, and 79 of the 128 slots (61.7 %) are padding.',
              },
            ],
          },
          {
            label: 'Packed · 2 rows × 32',
            tone: 'scope',
            layout: 'column',
            items: [
              {
                id: 'packed-ids',
                array: 'input_ids',
                sub: 'first-fit decreasing · 15 of 64 slots pad',
                cols: 32,
                rows: 2,
                marks: [
                  {rows: [0, 0], cols: [0, 16], tone: 'global', label: 'A · 17'},
                  {rows: [0, 0], cols: [17, 28], tone: 'global', label: 'B · 12'},
                  {rows: [0, 0], cols: [29, 31], tone: 'muted'},
                  {rows: [1, 1], cols: [0, 10], tone: 'global', label: 'C · 11'},
                  {rows: [1, 1], cols: [11, 19], tone: 'global', label: 'D · 9'},
                  {rows: [1, 1], cols: [20, 31], tone: 'muted'},
                ],
                detail:
                  'Longest first: A opens row 0, B fits beside it, C does not and opens row 1, D joins C. 15 of 64 slots (23.4 %) are padding.',
              },
              {
                id: 'pos-ids',
                array: 'position_ids[0]',
                sub: 'restart at every chat',
                cols: 32,
                tone: 'global',
                cells: [
                  '0',
                  '1',
                  '2',
                  '3',
                  '4',
                  '5',
                  '6',
                  '7',
                  '8',
                  '9',
                  '10',
                  '11',
                  '12',
                  '13',
                  '14',
                  '15',
                  '16',
                  '0',
                  '1',
                  '2',
                  '3',
                  '4',
                  '5',
                  '6',
                  '7',
                  '8',
                  '9',
                  '10',
                  '11',
                  '0',
                  '1',
                  '2',
                ],
                detail:
                  'A reads positions 0 to 16, B 0 to 11, the padding 0 to 2: each as if it were alone in the row.',
              },
              {
                id: 'cu-array',
                array: 'cu_seqlens[0]',
                sub: 'int32 · padding is the last segment',
                cols: 4,
                tone: 'global',
                cells: ['0', '17', '29', '32'],
                detail:
                  'Segment boundaries of row 0. The mask lets query `i` see key `j` only when both fall between the same two boundaries.',
              },
            ],
          },
        ],
        arrows: [{from: 'padded-ids', to: 'packed-ids', label: 'pack · 4 rows → 2'}],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Training language models to follow instructions with human feedback',
      url: 'https://arxiv.org/abs/2203.02155',
      by: 'Long Ouyang et al.',
      date: '2022-03-04',
      venue: 'NeurIPS 2022',
      takes:
        'The SFT stage itself: next-token cross-entropy on labeler-written demonstrations before reward modelling and PPO, the loss that `render` masks and `sft_step` optimises.',
    },
    {
      kind: 'paper',
      title:
        'Efficient Sequence Packing without Cross-contamination: Accelerating Large Language Models without Impacting Performance',
      url: 'https://arxiv.org/abs/2107.02027',
      by: 'Mario Michael Krell et al.',
      date: '2021-06-29',
      venue: 'arXiv',
      takes:
        'Packing as bin packing and the cross-contamination a plain causal mask causes, which `pack` and `document_causal_mask` avoid with restarted positions and a block-diagonal mask.',
    },
    {
      kind: 'paper',
      title: 'The Llama 3 Herd of Models',
      url: 'https://arxiv.org/abs/2407.21783',
      by: 'Aaron Grattafiori et al.',
      date: '2024-07-31',
      venue: 'arXiv',
      takes:
        'The document mask that keeps sequences packed into one row from attending to each other, and the header and end-of-turn tokens of the chat format `render` emits.',
    },
    {
      kind: 'code',
      title: 'TRL',
      url: 'https://github.com/huggingface/trl',
      by: 'Hugging Face',
      date: '2020-03-27',
      venue: 'GitHub',
      takes:
        'The `SFTTrainer` whose core this rebuilds: `assistant_only_loss`, best-fit-decreasing `packing` and `padding_free` batches.',
    },
    {
      kind: 'post',
      title: 'Improving Hugging Face Training Efficiency Through Packing with Flash Attention 2',
      url: 'https://huggingface.co/blog/packing-with-FA2',
      by: 'Rhui Dih Lee et al.',
      date: '2024-08-21',
      venue: 'Hugging Face blog',
      takes:
        'Packing without padding by restarting `position_ids` at 0 per example and handing `cu_seqlens` to FlashAttention 2, the layout `pack` produces.',
    },
    {
      kind: 'post',
      title: 'Fixing Gradient Accumulation',
      url: 'https://huggingface.co/blog/gradient_accumulation',
      by: 'Lysandre et al.',
      date: '2024-10-16',
      venue: 'Hugging Face blog',
      takes:
        'The fix `accumulate_gradients` implements: divide the summed loss by `num_items_in_batch`, the targets of every micro-batch, not average per-micro-batch means.',
    },
  ],
  steps: [chatTemplateStep, packingStep, sftStepStep],
  learn,
};
