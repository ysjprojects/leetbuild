import type {Step} from '@/lib/types';

export const chatTemplateStep: Step = {
  id: 'chat-template',
  title: 'Chat template and assistant-only labels',
  concept: 'pytorch',
  file: 'sft_template',
  focus: ['conversation', 'template', 'input-ids', 'loss-mask'],
  task: `## Task

Write \`sft_template.py\`: a byte-level tokenizer and the Llama 3 chat format, with the labels that let the loss see only what the assistant says.

- **Vocabulary** (given as constants, \`VOCAB_SIZE = 262\`): ids 0 to 255 are the UTF-8 bytes, and Llama 3's special tokens follow. \`BOS_ID = 256\` is \`<|begin_of_text|>\` (128000 in Llama 3), \`EOS_ID = 257\` is \`<|end_of_text|>\` (128001), \`START_HEADER_ID = 258\` and \`END_HEADER_ID = 259\` are \`<|start_header_id|>\` and \`<|end_header_id|>\` (128006, 128007), \`EOT_ID = 260\` is \`<|eot_id|>\` (128009) and \`PAD_ID = 261\` is \`<|finetune_right_pad_id|>\` (128004, named in Llama 3.1). \`IGNORE_INDEX = -100\` is the label \`F.cross_entropy\` skips by default.
- \`encode(text) -> list[int]\`: the UTF-8 bytes of \`text\`. A special-token string typed inside text stays bytes (\`"<|eot_id|>"\` is 10 ids, never 260): only the template emits special ids.
- \`decode(ids) -> str\`: the inverse; ids ≥ 256 come back as their strings, byte runs decode with \`errors="replace"\`.
- \`header(role) -> list[int]\`: \`START_HEADER_ID\`, the role's bytes, \`END_HEADER_ID\`, then \`"\\n\\n"\`.
- \`render(messages, max_len, add_generation_prompt=False) -> (input_ids, labels)\`, for \`messages\` a list of \`{"role": "system" | "user" | "assistant", "content": str}\`: \`BOS_ID\` once, then per message \`header(role) + encode(content) + [EOT_ID]\`.
- **Labels**: \`labels[t] = input_ids[t]\` on every assistant turn's content and its \`<|eot_id|>\`; \`IGNORE_INDEX\` on the BOS, on every header (the assistant's too) and on every system and user token. They are not shifted here: the loss pairs \`logits[t]\` with \`labels[t + 1]\`.
- **Generation prompt**: \`add_generation_prompt=True\` appends \`header("assistant")\` with ignored labels, the prefix a model completes at inference.
- **Truncation**: cut both to \`max_len\` keeping the beginning, and return two \`(L,)\` \`torch.long\` tensors, \`L ≤ max_len\`.
- **Self-test** on the chat system "Be brief.", user "Hi", assistant "Hello!", user "2+2?", assistant "4". It decodes to the exact Llama 3 string, is 80 ids long, starts \`[256, 258, 115, 121]\` and ends \`[10, 52, 260]\`. It keeps 9 labels (\`Hello!<|eot_id|>4<|eot_id|>\`), the first at index 45. A generation prompt trains on nothing, \`max_len=20\` returns the first 20 ids and \`max_len=60\` keeps 7 labels. \`"<|eot_id|>é"\` as user text yields one eot id, and \`é\` is two bytes.

> The ids decide what the model reads; the labels decide what it is graded on. The \`<|eot_id|>\` it is graded on is how it learns to stop.`,
  hints: [
    'Build two Python lists side by side, `ids` and `labels`, and extend both by the same length for every piece. They stay aligned without any index arithmetic.',
    'Split each message into a head, `header(role)`, and a body, its content bytes plus `EOT_ID`. The head is always ignored; the body is copied into the labels for an assistant and ignored for anyone else.',
    'Truncate once, at the end, both lists with `[:max_len]`, then `torch.tensor(ids, dtype=torch.long)`. To decode, collect byte ids in a run and flush it with `bytes(run).decode("utf-8", errors="replace")` at every special id.',
  ],
  checks: [
    {
      id: 'utf8-bytes',
      title: 'Text is its UTF-8 bytes',
      detail:
        '`encode` returns `list(text.encode("utf-8"))`: one id per byte, so any string round-trips and no text can produce a special id.',
      match: {python: {all: [/\.encode\(\s*["']utf-?8["']\s*\)/]}},
    },
    {
      id: 'header',
      title: 'A header is start id, role, end id, two newlines',
      detail:
        '`[START_HEADER_ID] + encode(role) + [END_HEADER_ID]` followed by `"\\n\\n"`: the exact Llama 3 turn header, so a model trained here meets the same ids at inference.',
      match: {
        python: {all: [/\[\s*START_HEADER_ID\s*\]/, /\[\s*END_HEADER_ID\s*\]/, /["']\\n\\n["']|\[\s*10\s*,\s*10\s*\]/]},
      },
    },
    {
      id: 'bos-once',
      title: 'One begin_of_text, before the turns',
      detail:
        'The sequence starts `[BOS_ID]` before the loop over `messages`; a BOS per turn would teach the model a format it never sees.',
      match: {python: {order: [/\[\s*BOS_ID\s*\]/, /for\s+\w+\s+in\s+messages\b/]}},
    },
    {
      id: 'eot-per-turn',
      title: 'Every turn ends in an eot id',
      detail:
        'Each message body is `encode(content) + [EOT_ID]`: the eot closes system, user and assistant turns alike.',
      match: {python: {all: [/\+\s*\[\s*EOT_ID\s*\]|\.append\(\s*EOT_ID\s*\)/]}},
    },
    {
      id: 'assistant-only',
      title: 'Labels only on assistant turns',
      detail:
        'The role is compared with `"assistant"` and everything else gets `[IGNORE_INDEX] * n`: training on system and user tokens teaches the model to write prompts.',
      match: {
        python: {
          all: [/==\s*["']assistant["']|["']assistant["']\s*==|!=\s*["']assistant["']/, /\[\s*IGNORE_INDEX\s*\]\s*\*/],
        },
      },
    },
    {
      id: 'generation-prompt',
      title: 'A generation prompt is an assistant header',
      detail:
        '`if add_generation_prompt:` appends `header("assistant")` with ignored labels, the prefix the model completes at inference.',
      match: {python: {all: [/if\s+add_generation_prompt\b/]}},
    },
    {
      id: 'truncate-head',
      title: 'Truncation keeps the beginning',
      detail:
        'Both lists are cut with `[:max_len]`. Keeping the end (`[-max_len:]`) drops the BOS and the system prompt, and leaves labels the model cannot condition on.',
      match: {
        python: {
          all: [/\[\s*:\s*max_len\s*\]/],
          none: [/\[\s*-\s*max_len\s*:/, /\[\s*len\([^\]]*\)\s*-\s*max_len\s*:/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""SFT data, part 1: a byte-level tokenizer and the Llama 3 chat template with an assistant-only loss mask."""

import torch

IGNORE_INDEX = -100  # F.cross_entropy's default ignore_index: a label that contributes no loss and no gradient

# Llama 3's special tokens (128000, 128001, 128006, 128007, 128009, 128004 there), here ids 256..261 after the bytes.
SPECIAL_TOKENS = [
    "<|begin_of_text|>",
    "<|end_of_text|>",
    "<|start_header_id|>",
    "<|end_header_id|>",
    "<|eot_id|>",
    "<|finetune_right_pad_id|>",
]
SPECIAL_IDS = {tok: 256 + i for i, tok in enumerate(SPECIAL_TOKENS)}
BOS_ID = SPECIAL_IDS["<|begin_of_text|>"]
EOS_ID = SPECIAL_IDS["<|end_of_text|>"]
START_HEADER_ID = SPECIAL_IDS["<|start_header_id|>"]
END_HEADER_ID = SPECIAL_IDS["<|end_header_id|>"]
EOT_ID = SPECIAL_IDS["<|eot_id|>"]
PAD_ID = SPECIAL_IDS["<|finetune_right_pad_id|>"]
VOCAB_SIZE = 256 + len(SPECIAL_TOKENS)


def encode(text: str) -> list[int]:
    """UTF-8 bytes of \`text\`, one id per byte (0..255). Special-token strings inside text stay plain bytes."""
    raise NotImplementedError("TODO: encode text as its UTF-8 bytes")


def decode(ids) -> str:
    """Inverse of \`encode\` for byte ids; ids >= 256 come back as their special-token strings."""
    raise NotImplementedError("TODO: bytes back to text, ids >= 256 as their special-token strings")


def header(role: str) -> list[int]:
    """\`<|start_header_id|>role<|end_header_id|>\\\\n\\\\n\` as ids."""
    raise NotImplementedError("TODO: the start-header id, the role bytes, the end-header id, two newlines")


def render(messages: list[dict], max_len: int, add_generation_prompt: bool = False):
    """Llama 3 chat format. Returns (input_ids, labels), both (L,) torch.long with L <= max_len.

    labels[t] == input_ids[t] on every assistant turn's content and its closing eot token, IGNORE_INDEX
    elsewhere. Labels are not shifted here: the loss pairs logits[t] with labels[t + 1].
    """
    # TODO: begin_of_text once; for every message its header, its content and an eot id.
    # TODO: labels copy the ids on assistant content and its eot only; IGNORE_INDEX elsewhere.
    # TODO: add_generation_prompt appends an assistant header with nothing to learn.
    # TODO: truncate keeping the beginning; return two torch.long tensors.
    raise NotImplementedError("TODO: the Llama 3 template with assistant-only labels, cut to max_len")


CONVERSATION = [
    {"role": "system", "content": "Be brief."},
    {"role": "user", "content": "Hi"},
    {"role": "assistant", "content": "Hello!"},
    {"role": "user", "content": "2+2?"},
    {"role": "assistant", "content": "4"},
]

if __name__ == "__main__":
    ids, labels = render(CONVERSATION, max_len=4096)
    text = (
        "<|begin_of_text|>"
        "<|start_header_id|>system<|end_header_id|>\\n\\nBe brief.<|eot_id|>"
        "<|start_header_id|>user<|end_header_id|>\\n\\nHi<|eot_id|>"
        "<|start_header_id|>assistant<|end_header_id|>\\n\\nHello!<|eot_id|>"
        "<|start_header_id|>user<|end_header_id|>\\n\\n2+2?<|eot_id|>"
        "<|start_header_id|>assistant<|end_header_id|>\\n\\n4<|eot_id|>"
    )
    assert ids.dtype == torch.long and labels.dtype == torch.long and ids.shape == labels.shape
    assert decode(ids) == text, decode(ids)
    # 1 bos + 5 headers (4 ids each plus the role's bytes) + content bytes + 5 eot ids.
    headers = 5 * 4 + len("system") + 2 * len("user") + 2 * len("assistant")
    assert len(ids) == 1 + headers + (9 + 2 + 6 + 4 + 1) + 5 == 80, len(ids)
    assert ids[:4].tolist() == [256, 258, 115, 121], ids[:4].tolist()  # bos, start_header, "s", "y"
    assert ids[-3:].tolist() == [10, 52, 260], ids[-3:].tolist()  # "\\n", "4", eot

    kept = labels != IGNORE_INDEX
    assert int(kept.sum()) == len("Hello!") + 1 + len("4") + 1 == 9, int(kept.sum())
    assert torch.equal(labels[kept], ids[kept])
    assert decode(ids[kept]) == "Hello!<|eot_id|>4<|eot_id|>", decode(ids[kept])
    assert int((ids[kept] == EOT_ID).sum()) == 2  # both assistant turns end in a labelled eot
    assert int((ids == EOT_ID).sum()) == 5  # the other three eot tokens are not trained on
    assert int(kept.nonzero()[0]) == 45  # bos 1 + system turn 20 + user turn 11 + assistant header 13
    assert labels[:45].eq(IGNORE_INDEX).all()

    gen_ids, gen_labels = render(CONVERSATION[:2], max_len=4096, add_generation_prompt=True)
    assert decode(gen_ids).endswith("Hi<|eot_id|><|start_header_id|>assistant<|end_header_id|>\\n\\n")
    assert gen_labels.eq(IGNORE_INDEX).all()  # a prompt for generation trains on nothing

    short_ids, short_labels = render(CONVERSATION, max_len=20)
    assert torch.equal(short_ids, ids[:20]) and torch.equal(short_labels, labels[:20])  # the beginning is kept
    cut_ids, cut_labels = render(CONVERSATION, max_len=60)
    assert int((cut_labels != IGNORE_INDEX).sum()) == 7  # the first answer survives whole, the second is cut

    inj_ids, inj_labels = render([{"role": "user", "content": "<|eot_id|>é"}], max_len=4096)
    assert int((inj_ids == EOT_ID).sum()) == 1  # a special token typed as text is 10 bytes, not id 260
    assert len(encode("é")) == 2 and decode(encode("é")) == "é"

    print(f"{len(ids)} ids, {int(kept.sum())} trained on ({int(kept.sum()) / len(ids):.0%}), vocab {VOCAB_SIZE}")
    print("PASS")
`,
      solution: `"""SFT data, part 1: a byte-level tokenizer and the Llama 3 chat template with an assistant-only loss mask."""

import torch

IGNORE_INDEX = -100  # F.cross_entropy's default ignore_index: a label that contributes no loss and no gradient

# Llama 3's special tokens (128000, 128001, 128006, 128007, 128009, 128004 there), here ids 256..261 after the bytes.
SPECIAL_TOKENS = [
    "<|begin_of_text|>",
    "<|end_of_text|>",
    "<|start_header_id|>",
    "<|end_header_id|>",
    "<|eot_id|>",
    "<|finetune_right_pad_id|>",
]
SPECIAL_IDS = {tok: 256 + i for i, tok in enumerate(SPECIAL_TOKENS)}
BOS_ID = SPECIAL_IDS["<|begin_of_text|>"]
EOS_ID = SPECIAL_IDS["<|end_of_text|>"]
START_HEADER_ID = SPECIAL_IDS["<|start_header_id|>"]
END_HEADER_ID = SPECIAL_IDS["<|end_header_id|>"]
EOT_ID = SPECIAL_IDS["<|eot_id|>"]
PAD_ID = SPECIAL_IDS["<|finetune_right_pad_id|>"]
VOCAB_SIZE = 256 + len(SPECIAL_TOKENS)


def encode(text: str) -> list[int]:
    """UTF-8 bytes of \`text\`, one id per byte (0..255). Special-token strings inside text stay plain bytes."""
    return list(text.encode("utf-8"))


def decode(ids) -> str:
    """Inverse of \`encode\` for byte ids; ids >= 256 come back as their special-token strings."""
    out, run = [], []
    for i in (int(t) for t in ids):
        if i < 256:
            run.append(i)
            continue
        out.append(bytes(run).decode("utf-8", errors="replace"))
        run = []
        out.append(SPECIAL_TOKENS[i - 256])
    out.append(bytes(run).decode("utf-8", errors="replace"))
    return "".join(out)


def header(role: str) -> list[int]:
    """\`<|start_header_id|>role<|end_header_id|>\\\\n\\\\n\` as ids."""
    return [START_HEADER_ID] + encode(role) + [END_HEADER_ID] + encode("\\n\\n")


def render(messages: list[dict], max_len: int, add_generation_prompt: bool = False):
    """Llama 3 chat format. Returns (input_ids, labels), both (L,) torch.long with L <= max_len.

    labels[t] == input_ids[t] on every assistant turn's content and its closing eot token, IGNORE_INDEX
    elsewhere. Labels are not shifted here: the loss pairs logits[t] with labels[t + 1].
    """
    ids = [BOS_ID]
    labels = [IGNORE_INDEX]
    for m in messages:
        head = header(m["role"])
        body = encode(m["content"]) + [EOT_ID]
        ids += head + body
        labels += [IGNORE_INDEX] * len(head)
        if m["role"] == "assistant":
            labels += body
        else:
            labels += [IGNORE_INDEX] * len(body)
    if add_generation_prompt:
        head = header("assistant")
        ids += head
        labels += [IGNORE_INDEX] * len(head)
    ids, labels = ids[:max_len], labels[:max_len]
    return torch.tensor(ids, dtype=torch.long), torch.tensor(labels, dtype=torch.long)


CONVERSATION = [
    {"role": "system", "content": "Be brief."},
    {"role": "user", "content": "Hi"},
    {"role": "assistant", "content": "Hello!"},
    {"role": "user", "content": "2+2?"},
    {"role": "assistant", "content": "4"},
]

if __name__ == "__main__":
    ids, labels = render(CONVERSATION, max_len=4096)
    text = (
        "<|begin_of_text|>"
        "<|start_header_id|>system<|end_header_id|>\\n\\nBe brief.<|eot_id|>"
        "<|start_header_id|>user<|end_header_id|>\\n\\nHi<|eot_id|>"
        "<|start_header_id|>assistant<|end_header_id|>\\n\\nHello!<|eot_id|>"
        "<|start_header_id|>user<|end_header_id|>\\n\\n2+2?<|eot_id|>"
        "<|start_header_id|>assistant<|end_header_id|>\\n\\n4<|eot_id|>"
    )
    assert ids.dtype == torch.long and labels.dtype == torch.long and ids.shape == labels.shape
    assert decode(ids) == text, decode(ids)
    # 1 bos + 5 headers (4 ids each plus the role's bytes) + content bytes + 5 eot ids.
    headers = 5 * 4 + len("system") + 2 * len("user") + 2 * len("assistant")
    assert len(ids) == 1 + headers + (9 + 2 + 6 + 4 + 1) + 5 == 80, len(ids)
    assert ids[:4].tolist() == [256, 258, 115, 121], ids[:4].tolist()  # bos, start_header, "s", "y"
    assert ids[-3:].tolist() == [10, 52, 260], ids[-3:].tolist()  # "\\n", "4", eot

    kept = labels != IGNORE_INDEX
    assert int(kept.sum()) == len("Hello!") + 1 + len("4") + 1 == 9, int(kept.sum())
    assert torch.equal(labels[kept], ids[kept])
    assert decode(ids[kept]) == "Hello!<|eot_id|>4<|eot_id|>", decode(ids[kept])
    assert int((ids[kept] == EOT_ID).sum()) == 2  # both assistant turns end in a labelled eot
    assert int((ids == EOT_ID).sum()) == 5  # the other three eot tokens are not trained on
    assert int(kept.nonzero()[0]) == 45  # bos 1 + system turn 20 + user turn 11 + assistant header 13
    assert labels[:45].eq(IGNORE_INDEX).all()

    gen_ids, gen_labels = render(CONVERSATION[:2], max_len=4096, add_generation_prompt=True)
    assert decode(gen_ids).endswith("Hi<|eot_id|><|start_header_id|>assistant<|end_header_id|>\\n\\n")
    assert gen_labels.eq(IGNORE_INDEX).all()  # a prompt for generation trains on nothing

    short_ids, short_labels = render(CONVERSATION, max_len=20)
    assert torch.equal(short_ids, ids[:20]) and torch.equal(short_labels, labels[:20])  # the beginning is kept
    cut_ids, cut_labels = render(CONVERSATION, max_len=60)
    assert int((cut_labels != IGNORE_INDEX).sum()) == 7  # the first answer survives whole, the second is cut

    inj_ids, inj_labels = render([{"role": "user", "content": "<|eot_id|>é"}], max_len=4096)
    assert int((inj_ids == EOT_ID).sum()) == 1  # a special token typed as text is 10 bytes, not id 260
    assert len(encode("é")) == 2 and decode(encode("é")) == "é"

    print(f"{len(ids)} ids, {int(kept.sum())} trained on ({int(kept.sum()) / len(ids):.0%}), vocab {VOCAB_SIZE}")
    print("PASS")
`,
    },
  },
  debrief: `The labels are the whole of SFT's difference from pretraining. The objective is the same next-token cross-entropy; what changes is which positions count. InstructGPT's SFT stage fine-tuned GPT-3 on labeler-written demonstrations, and most chat SFT recipes compute the loss on the responses only (TRL offers it as \`assistant_only_loss\`): a loss on the user turns spends capacity on modelling users and teaches the model to continue a conversation as either side. \`-100\` is not a convention of this file: it is \`F.cross_entropy\`'s default \`ignore_index\`, so the ignored positions add nothing to the loss sum, nothing to the gradient, and nothing to the count of the mean.

**The eot is labelled, the header is not.** The header is fixed by the template, so there is nothing to learn about it, and at inference the generation prompt supplies it. The \`<|eot_id|>\` after an answer is the one token that tells the serving loop to stop; a model never trained on it rambles into a fake user turn. **Specials are never parsed from text**: if a user can type \`<|eot_id|>\` and have it become id 128009, they can close the assistant's turn and write their own. tiktoken refuses special strings in \`encode\` unless they are allowed explicitly, for that reason. **Truncation keeps the beginning** because the BOS, the system prompt and the first exchange are what every later label is conditioned on; a cut answer still trains on the tokens it keeps.

What production adds: a Jinja chat template shipped with the tokenizer and applied by \`tokenizer.apply_chat_template\` (Llama 3's also trims each message, and from 3.1 adds a knowledge-cutoff date and tool definitions to the system header); masks taken from \`{% generation %}\` markers in the template (\`return_assistant_tokens_mask=True\`), which TRL's \`SFTTrainer\` uses for \`assistant_only_loss=True\`; and a 128,256-token BPE vocabulary, so English text takes about a quarter as many ids as it has bytes.`,
};
