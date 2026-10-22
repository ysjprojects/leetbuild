/**
 * The learning guide for supervised fine-tuning: the chat template and its loss mask, packing with
 * first-fit decreasing, document masks and restarted positions, and token-normalised gradient
 * accumulation. Rendered at `/pt-sft-packing/learn`.
 */
export const learn = `# The system at a glance

Supervised fine-tuning turns a base model, which continues any text, into an assistant, which answers a turn and stops. The recipe has been stable since [InstructGPT](https://arxiv.org/abs/2203.02155): collect conversations whose assistant turns are what you want, and train on them with the pretraining objective, next-token cross-entropy. Every frontier post-training pipeline starts here; Llama 3 alternates rounds of SFT and DPO, and RL stages begin from the SFT checkpoint.

The objective is old. The data path in front of it is where SFT goes wrong, and none of its mistakes raises an error:

:::architecture
{
  "input": "messages · [{role, content}, …]",
  "output": "one optimizer step",
  "items": [
    {"id": "g-chat", "label": "Conversation", "kind": "io", "sub": "system · user · assistant"},
    {"id": "g-template", "label": "Chat template", "sub": "render(messages, max_len)", "detail": "Llama 3 format: begin_of_text, then header, content and eot per turn."},
    {"columns": [
      [{"id": "g-ids", "label": "input_ids", "sub": "(L,) long"}],
      [{"id": "g-labels", "label": "labels", "kind": "loss", "sub": "−100 except assistant + eot"}]
    ]},
    {"id": "g-pack", "label": "Packer", "sub": "first-fit decreasing", "detail": "Whole chats into rows of seq_len tokens, longest first."},
    {"columns": [
      [{"id": "g-rows", "label": "Rows", "sub": "(R, S) ids and labels"}],
      [{"id": "g-pos", "label": "position_ids", "sub": "restart at 0 per chat"}],
      [{"id": "g-cu", "label": "cu_seqlens", "sub": "segment boundaries, int32"}]
    ]},
    {"id": "g-attn", "label": "Document-masked attention", "kind": "attention", "sub": "same segment ∧ j ≤ i", "side": {"label": "Block-diagonal mask", "sub": "(S, S) bool"}},
    {"id": "g-count", "label": "Count the targets", "sub": "N over all micro-batches"},
    {"tone": "block", "repeat": "micro-batches ×", "label": "Accumulate", "items": [
      {"id": "g-loss", "label": "Summed cross-entropy", "kind": "loss", "sub": "reduction='sum'"},
      {"id": "g-bwd", "label": "Backward of sum / N", "sub": "grads add up in .grad"}
    ]},
    {"id": "g-step", "label": "Clip, then AdamW step", "sub": "clip_grad_norm_ · step"}
  ],
  "notes": [
    {"at": "g-labels", "text": "**9** of **80** ids trained in the test chat"},
    {"at": "g-pack", "text": "16 chats in **8** rows, not 16"},
    {"at": "g-attn", "text": "Losses equal each chat alone, **≤ 1e-6**"},
    {"at": "g-count", "text": "**216 + 390 + 860** targets, one N", "side": "left"}
  ]
}
:::

Each stage has an obvious version that runs, converges, and trains a different model:

| stage | the obvious version | what it trains | the version built here |
|---|---|---|---|
| template | loss on every token | a model that also writes user turns and system prompts | labels \`-100\` outside assistant turns |
| packing | concatenate, one causal mask | chats conditioned on unrelated chats, positions that run on | block-diagonal mask, positions restart |
| accumulation | mean per micro-batch, divided by K | tokens in short micro-batches weighed up (12 % gradient error here) | summed loss over the global target count |

The rest of this guide takes them in order, with the numbers the three self-tests print.

# The chat template and the loss mask

A chat template turns a list of messages into one token sequence. The model learns the format as much as the content: at inference, the serving stack renders the conversation with the same template, appends the assistant's header, and samples until the model emits the end-of-turn token. Llama 3's format, from its [prompt format reference](https://dev.meta.ai/llama/docs/model-cards-and-prompt-formats/meta-llama-3), for the test chat:

\`\`\`text
<|begin_of_text|><|start_header_id|>system<|end_header_id|>\\n\\nBe brief.<|eot_id|>
<|start_header_id|>user<|end_header_id|>\\n\\nHi<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>\\n\\nHello!<|eot_id|>
<|start_header_id|>user<|end_header_id|>\\n\\n2+2?<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>\\n\\n4<|eot_id|>
\`\`\`

Shown one line per turn: \`\\n\\n\` stands for the two newline bytes after each header, which are the only line breaks in the sequence. With a byte vocabulary, every character is one id and each special token is one id above 255:

| piece | ids | labelled |
|---|---|---|
| \`<\\|begin_of_text\\|>\` | 1 | 0 |
| system turn: header (1 + 6 + 1 + 2), \`Be brief.\`, eot | 10 + 9 + 1 | 0 |
| user turn: header, \`Hi\`, eot | 8 + 2 + 1 | 0 |
| assistant header | 13 | 0 |
| \`Hello!\` and its eot | 6 + 1 | 7 |
| user turn: header, \`2+2?\`, eot | 8 + 4 + 1 | 0 |
| assistant header, then \`4\` and its eot | 13 + 2 | 2 |
| total | 80 | 9 |

The first label sits at index 45, after 45 ids of context. Three choices in that table are deliberate:

- **The assistant's \`<|eot_id|>\` is labelled.** It is the only signal that ends a turn. A model never graded on it keeps generating after its answer, often into an invented user turn.
- **The headers are not labelled**, the assistant's included. They are fixed by the template, so there is nothing to learn about them, and at inference the generation prompt supplies them.
- **Labels are not shifted in \`render\`.** \`labels[t]\` sits under \`input_ids[t]\`; the loss pairs \`logits[t]\` with \`labels[t + 1]\`. Shifting in one place only is what keeps the two from being shifted twice.

\`-100\` is not this project's convention: it is \`F.cross_entropy\`'s default \`ignore_index\`, so an ignored position adds nothing to the loss sum, nothing to the gradient, and nothing to the count of a mean.

Special tokens are emitted by the template and never parsed from text. If user content containing the string \`<|eot_id|>\` became id 128009, a user could close the assistant's turn and write one of their own: the chat-format version of an injection. In \`encode\` that string is 10 bytes like any other text. Truncation keeps the beginning, because the BOS, the system prompt and the first exchange condition every later label: \`max_len = 60\` keeps the first answer whole and drops the second, 7 labels instead of 9.

:::details The real ids
Llama 3 places its special tokens after its 128,000 BPE tokens: \`<|begin_of_text|>\` 128000, \`<|end_of_text|>\` 128001, \`<|finetune_right_pad_id|>\` 128004 (from Llama 3.1), \`<|start_header_id|>\` 128006, \`<|end_header_id|>\` 128007, \`<|eot_id|>\` 128009. The toy vocabulary keeps the order of use and puts them at 256 to 261. \`<|end_of_text|>\` ends a document in pretraining; \`<|eot_id|>\` ends a turn, and is what a chat model stops on.
:::

:::quiz
Q: In an assistant turn, which tokens carry labels?
- [ ] The header, the content and the eot, since all three are the assistant's
- [x] The content and the closing eot; the header is fixed by the template
- [ ] Only the content; the eot is a special token and is never trained on
> The header is the same every time and is supplied by the generation prompt at inference, so there is nothing to learn. The eot is the one token that ends the turn: without a label on it, the model never learns to stop.
:::

# Packing: filling the rows

Training runs on fixed-shape batches of \`seq_len\` tokens per row. SFT chats are short and uneven: in the self-test, 16 chats run from 80 to 395 tokens, 3,553 in all. One chat per row leaves most of each row as padding, and padding costs the same FLOPs as real tokens:

| batching | rows × 512 | slots | pad tokens | waste |
|---|---|---|---|---|
| padded: one chat per row | 16 | 8,192 | 4,639 | 56.6 % |
| packed: first-fit decreasing | 8 | 4,096 | 543 | 13.3 % |
| lower bound | ⌈3,553 / 512⌉ = 7 | 3,584 | 31 | 0.9 % |

Packing is bin packing: rows are bins, chats are items, the goal is the fewest bins. The exact problem is NP-hard. [Krell et al.](https://arxiv.org/abs/2107.02027) frame sequence packing this way and give histogram-based heuristics fast enough for millions of sequences. First-fit decreasing is the textbook baseline:

\`\`\`python
order = sorted(range(n), key=lambda i: len(examples[i][0]), reverse=True)
for i in order:                      # longest first
    r = first row with room[r] >= len(examples[i][0]), else a new row
    place example i at offset seq_len - room[r]; room[r] -= its length
\`\`\`

Longest first matters: the long chats claim rows while those rows are empty, and the short ones fill the gaps they leave. In arrival order a long chat can find every row a little too full and open a new one. First-fit decreasing never uses more than 11/9 of the optimal row count, plus a constant.

A packed row carries three things beside the ids. Here are rows of 32 tokens holding chats of 17, 12, 11 and 9 tokens, padded and packed:

:::gpu
{
  "layout": "column",
  "items": [
    {"label": "Padded · 4 rows × 32", "tone": "scope", "items": [
      {"id": "g-padded", "array": "input_ids", "sub": "one chat per row · 79 of 128 slots pad", "cols": 32, "rows": 4, "marks": [
        {"rows": [0, 0], "cols": [0, 16], "tone": "global", "label": "A · 17"},
        {"rows": [1, 1], "cols": [0, 11], "tone": "global", "label": "B · 12"},
        {"rows": [2, 2], "cols": [0, 10], "tone": "global", "label": "C · 11"},
        {"rows": [3, 3], "cols": [0, 8], "tone": "global", "label": "D · 9"},
        {"rows": [0, 0], "cols": [17, 31], "tone": "muted"},
        {"rows": [1, 1], "cols": [12, 31], "tone": "muted"},
        {"rows": [2, 2], "cols": [11, 31], "tone": "muted"},
        {"rows": [3, 3], "cols": [9, 31], "tone": "muted"}
      ]}
    ]},
    {"label": "Packed · 2 rows × 32", "tone": "scope", "layout": "column", "items": [
      {"id": "g-packed", "array": "input_ids", "sub": "first-fit decreasing · 15 of 64 slots pad", "cols": 32, "rows": 2, "marks": [
        {"rows": [0, 0], "cols": [0, 16], "tone": "global", "label": "A · 17"},
        {"rows": [0, 0], "cols": [17, 28], "tone": "global", "label": "B · 12"},
        {"rows": [0, 0], "cols": [29, 31], "tone": "muted"},
        {"rows": [1, 1], "cols": [0, 10], "tone": "global", "label": "C · 11"},
        {"rows": [1, 1], "cols": [11, 19], "tone": "global", "label": "D · 9"},
        {"rows": [1, 1], "cols": [20, 31], "tone": "muted"}
      ]},
      {"id": "g-posids", "array": "position_ids[0]", "sub": "restart at every chat", "cols": 32, "tone": "global", "cells": ["0","1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","0","1","2","3","4","5","6","7","8","9","10","11","0","1","2"]},
      {"id": "g-cuarr", "array": "cu_seqlens[0]", "sub": "int32 · padding is the last segment", "cols": 4, "tone": "global", "cells": ["0", "17", "29", "32"]}
    ]}
  ],
  "arrows": [{"from": "g-padded", "to": "g-packed", "label": "pack · 4 rows → 2"}]
}
:::

Try other lengths and row sizes. The mask on the right is the subject of the next section:

:::widget sequence-packing {"docs": 10, "seqLen": 32}

:::quiz
Q: Why does first-fit decreasing place the longest chats first?
- [ ] Long chats have more labelled tokens, so they should train first
- [x] Long chats need nearly empty rows; placed late, they find every row partly full and each opens a new one
- [ ] Sorting makes the rows equal in length, so no row needs padding
> Short items are easy to fit into the gaps left in any row; long items are not. Placing the long ones while rows are still empty, and letting the short ones fill in after, is what keeps the row count near the lower bound.
:::

# Document masks and positions

Packing is only free if no chat can tell it was packed. Two things would let it tell: the keys it attends to and the positions it is given.

The keys are fixed by the mask. Query \`i\` may attend key \`j\` when both are in the same segment and \`j ≤ i\`, so the mask is block-diagonal with one lower triangle per chat (and one for the padding tail, so that its rows are never empty and the softmax never sees a row of \`-inf\`):

\`\`\`python
lengths = cu_seqlens[1:] - cu_seqlens[:-1]
seg = torch.repeat_interleave(torch.arange(len(lengths)), lengths)  # segment id per position
mask = (seg[:, None] == seg[None, :]) & torch.tril(torch.ones(S, S, dtype=torch.bool))
\`\`\`

The positions are fixed by \`position_ids\`, which restart at 0 for every chat. The self-test runs the same tiny model three ways, in float64:

| chat 2 of a packed row, run | keys it sees | positions | per-token losses against the chat alone |
|---|---|---|---|
| alone | its own | 0 … L − 1 | (the reference) |
| packed, one causal mask, positions running on | chat 1 and its own | offset … offset + L − 1 | off by up to 1.81 nats |
| packed, document mask, positions restarted | its own | 0 … L − 1 | equal (difference 0.0 in float64) |

Krell et al. call the middle row cross-contamination: the model is trained on contexts that never occur at inference. The [Llama 3 paper](https://arxiv.org/abs/2407.21783) uses a document mask in pretraining for the same reason, and reports that it matters little for standard pretraining but is important for continued pretraining on very long sequences. The labels need one more fix for the same leak: the first label of every chat is ignored, so the last logit of chat 1 is never graded on chat 2's first token.

How much the restart of positions matters depends on the position encoding. With a learned absolute table, as in the tiny model, a chat at offset 300 would read rows 300 and up and compute different logits. With RoPE and a document mask, scores depend only on distances inside one chat, so the restart changes nothing in exact arithmetic. It still matters in practice, because Hugging Face's FlashAttention 2 path uses it as the boundary signal: wherever \`position_ids\` returns to 0, a new sequence starts, and \`cu_seqlens\` is computed from that ([the packing post](https://huggingface.co/blog/packing-with-FA2) measures up to 2× throughput from it).

A materialised mask does not scale:

| seq_len | bool mask per row, S² bytes |
|---|---|
| 512 | 256 KiB |
| 8,192 | 64 MiB |
| 131,072 | 16 GiB |

So production kernels never build it. FlashAttention's \`flash_attn_varlen_func\` takes the flattened tokens and \`cu_seqlens\` and only visits tiles inside one sequence. [FlexAttention](https://pytorch.org/blog/flexattention/) compiles a \`document_id[q] == document_id[kv]\` mask function into a block-sparse kernel that skips the blocks it rules out.

:::quiz
Q: Two chats are packed into one row with a plain causal mask but restarted position ids. Is that enough?
- [ ] Yes: restarted positions tell the model where each chat begins
- [ ] Yes, if the model uses RoPE, since RoPE only sees relative distances
- [x] No: the second chat still attends to every token of the first, a context it never has alone
> Positions change how keys are encoded, not which keys exist. Only the mask removes the first chat's keys from the second chat's softmax; with RoPE the restart even becomes redundant once the mask is right.
:::

# Gradient accumulation without the bias

A step's batch rarely fits on the device, so it is split into K micro-batches whose gradients add up in \`.grad\` before one optimizer step. Addition is exact; the question is what each micro-batch's loss is divided by. The full-batch loss is the mean over all N target tokens:

\`\`\`text
full batch          L = Σ_all ℓ / N
token-normalised    Σ_k (Σ_{targets in k} ℓ) / N            = L exactly
mean of means       (1/K) Σ_k (Σ_{targets in k} ℓ) / N_k    = L only if every N_k = N / K
\`\`\`

In the self-test the 8 packed rows split into micro-batches of 1, 2 and 5 rows holding 216, 390 and 860 target tokens. Packing evens out tokens per row, not labelled tokens per row, and assistant-only labels make the count depend on how long the answers are. The weight each token gets:

| micro-batch | targets | token-normalised weight | mean-of-means weight | relative to correct |
|---|---|---|---|---|
| 1 | 216 | 1 / 1,466 | 1 / (3 · 216) = 1 / 648 | 2.26× |
| 2 | 390 | 1 / 1,466 | 1 / 1,170 | 1.25× |
| 3 | 860 | 1 / 1,466 | 1 / 2,580 | 0.57× |

A token in the small micro-batch counts four times as much as one in the large micro-batch. The self-test measures the result: the accumulated gradient equals the full-batch gradient to 4e-16, and the mean of means is 12.1 % of the gradient's norm away from it.

This was a real bug. In October 2024 Unsloth reported that losses changed when gradient accumulation was switched on in the Hugging Face Trainer, and [Hugging Face's fix](https://huggingface.co/blog/gradient_accumulation) passes \`num_items_in_batch\`, the target count of the whole accumulation window, into the loss, which divides a summed cross-entropy by it. Two details of the loop follow from the formula:

- The count is taken **before** the first backward. The first micro-batch's gradient is already in \`.grad\` when the last runs, so its divisor must already be final.
- The clip runs **once**, on the summed gradient. Clipping each micro-batch would bound pieces of a gradient whose norm nobody computed.

Under data parallelism each rank holds its own micro-batches. The count is all-reduced across ranks too, and the loss is multiplied by the world size, because DDP averages gradients over ranks. The same choice appears inside a single batch: averaging the loss per sequence and then over sequences weighs short answers up exactly as the mean of means weighs short micro-batches up.

:::quiz
Q: Every micro-batch is packed to exactly 4 × 512 tokens. Is the mean of per-micro-batch means now exact?
- [ ] Yes: equal token counts make the means equal-weighted
- [x] No: the divisor is labelled targets, and those vary with how much of each row is assistant text
- [ ] No: packing adds padding, which the mean counts
> The mean runs over positions whose label is not \`-100\`. Packing fixes tokens per row, but the share of those tokens that are assistant answers still varies, so N_k differs and the mean of means stays biased.
:::

# What production adds

Every piece of this project has a production counterpart that does the same thing at scale:

| here | in production |
|---|---|
| \`render\` with a byte vocabulary | \`tokenizer.apply_chat_template\`, a Jinja template shipped with the model, a 128,256-token BPE |
| labels on assistant turns | \`{% generation %}\` markers and \`return_assistant_tokens_mask\`; TRL's \`assistant_only_loss=True\` |
| first-fit decreasing | TRL's \`packing=True\` with best-fit decreasing (\`packing_strategy="bfd"\`), the default |
| an \`(S, S)\` bool mask | \`flash_attn_varlen_func\` with \`cu_seqlens\`, or a FlexAttention block mask |
| \`position_ids\` restarting at 0 | the boundary signal of padding-free batches (\`DataCollatorWithFlattening\`, TRL's \`padding_free\`) |
| \`num_items_in_batch\` over micro-batches | the same name in the Trainer, all-reduced across data-parallel ranks |

[TRL](https://github.com/huggingface/trl)'s \`SFTTrainer\` puts these together: give it a conversational dataset and it applies the template, masks to the assistant, packs with best-fit decreasing and goes padding-free, and its Trainer normalises by \`num_items_in_batch\`.

What it adds beyond them is bookkeeping: on-the-fly packing of streamed datasets, truncation policies for chats longer than a row (truncate, split, or drop), LoRA adapters for memory, bf16 autocast, and evaluation on held-out chats with the same mask.

:::quiz
Q: A padding-free batch flattens every chat into one sequence with no mask tensor. What tells the attention kernel where chats begin?
- [ ] Each chat starts with a \`<|begin_of_text|>\` token, which the kernel looks for
- [x] The cumulative lengths, \`cu_seqlens\`, derived from where \`position_ids\` returns to 0
- [ ] Nothing: the kernel attends causally over the whole flattened sequence
> Varlen kernels take boundaries as \`cu_seqlens\` and never look at token values. Hugging Face computes them from the position ids, which is why packed position ids must restart at 0 for every chat.
:::

# What to take away

- SFT keeps pretraining's loss and changes the data path: a chat template, assistant-only labels, packed rows, accumulated micro-batches.
- Labels are \`-100\` everywhere except assistant content and its \`<|eot_id|>\`; the eot is how the model learns to stop, and special tokens are never parsed from user text.
- Packing removes most of the padding (56.6 % → 13.3 % here) and is invisible to the model only with a block-diagonal mask, restarted positions and an ignored first label per chat.
- Gradient accumulation is exact only when every micro-batch's summed loss is divided by the target count of all of them, known before the first backward.
- None of these mistakes raises an error; each trains a different model, so each needs a test against a reference: a chat alone, a full batch.

Primary sources: Ouyang et al., [Training language models to follow instructions with human feedback](https://arxiv.org/abs/2203.02155) (2022), and Krell et al., [Efficient Sequence Packing without Cross-contamination](https://arxiv.org/abs/2107.02027) (2021).
`;
