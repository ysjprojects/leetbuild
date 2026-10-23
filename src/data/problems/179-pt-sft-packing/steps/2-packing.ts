import type {Step} from '@/lib/types';

export const packingStep: Step = {
  id: 'packing',
  title: 'Packing with document masks and per-document positions',
  concept: 'pytorch',
  file: 'sft_packing',
  focus: ['packer', 'rows', 'positions', 'cu-seqlens', 'doc-mask', 'padded-ids', 'packed-ids', 'pos-ids', 'cu-array'],
  task: `## Task

Write \`sft_packing.py\` (\`from sft_template import IGNORE_INDEX, PAD_ID, VOCAB_SIZE, render\`). Padding every chat to \`seq_len\` spends much of each batch on pad tokens. Packing several chats into one row fills it, but only if no token can see another chat and every chat keeps its own positions.

- \`pack(examples, seq_len) -> dict\`, where \`examples\` is a list of \`(input_ids, labels)\` pairs from \`render\`. It returns \`input_ids\`, \`labels\` and \`position_ids\` of shape \`(R, seq_len)\` \`torch.long\`, \`cu_seqlens\` and \`docs\`.
- **First-fit decreasing**: visit the examples longest first (ties by index) and put each whole into the first row with at least its length free; open a new row otherwise. An example longer than \`seq_len\` raises \`ValueError\` (truncate it in \`render\`).
- **Rows**: \`input_ids\` starts as \`PAD_ID\` everywhere and \`labels\` as \`IGNORE_INDEX\`; copy each document in at its offset. The label at each document's first slot is \`IGNORE_INDEX\`, so the previous document's last token is never trained to predict it.
- **\`position_ids\`**: \`0 … len − 1\` for every document, restarting at each boundary. The padding tail counts \`0, 1, …\` too.
- **\`cu_seqlens\`**: per row, an \`int32\` tensor of segment boundaries \`[0, l1, l1 + l2, …, seq_len]\`, the padding tail (when there is one) its own last segment. It is the per-row form of what FlashAttention's \`flash_attn_varlen_func\` takes. \`docs\` lists, per row, the indices of its examples in placement order.
- \`document_causal_mask(cu_seqlens, seq_len) -> (seq_len, seq_len) bool\`: \`True\` where query \`i\` may attend to key \`j\`, which means the same segment and \`j ≤ i\`. It is block-diagonal, each block lower-triangular. Build it with tensor ops (a segment id per position, then one comparison), not a Python double loop.
- **Forbidden**: \`F.scaled_dot_product_attention\`, \`flash_attn\` and FlexAttention. The mask is the point.
- **Given**: \`pad_rows\` (one example per row, for comparison), \`padding_waste\`, \`TinyCausalLM\` (a token plus learned position embedding, one single-head attention layer that fills \`~mask\` with \`-inf\`, and a head), \`batch_logits\` (the model over a batch, one mask per row), \`conversations(n)\` and \`token_losses\`.
- **Self-test** on 16 chats of 80 to 395 tokens at \`seq_len = 512\`. Every example is placed once, \`ceil(3,553 / 512) = 7 ≤ R < 16\`, positions restart, and the mask equals a slow loop on row 0. In float64, the per-token losses of every packed document equal the same document run alone (≤ 1e-6), while one causal mask over the whole row with running positions shifts document 2's losses by more than 1e-3. Padded batching wastes 56.6 % of its slots, packing 13.3 %.

:::widget sequence-packing {"docs": 10, "seqLen": 32}

> Packing is free only if the model cannot tell. Each document must see exactly the keys and the positions it would see alone, and the mask and the position ids are the two places that guarantee it.`,
  hints: [
    'Sort indices, not examples: `sorted(range(len(examples)), key=lambda i: len(examples[i][0]), reverse=True)`. Keep a list of free slots per row; `next((r for r in range(len(rows)) if room[r] >= n), None)` finds the first fit.',
    "Allocate with `torch.full((R, seq_len), PAD_ID, dtype=torch.long)` and the same with `IGNORE_INDEX`, then slice-assign per document: `input_ids[r, a:b] = ids`, `position_ids[r, a:b] = torch.arange(b - a)`, and append `b` to the row's boundaries.",
    'For the mask: segment lengths are `cu[1:] - cu[:-1]`, and `torch.repeat_interleave` turns them into a segment id per position. Query `i` may see key `j` when their ids are equal and `j ≤ i`: one broadcast comparison, and `torch.tril` for the second condition.',
  ],
  checks: [
    {
      id: 'ffd',
      title: 'Longest documents are placed first',
      detail:
        'The examples are visited in decreasing length (`reverse=True`) and each goes into the first row it fits: first-fit decreasing, the bin-packing baseline that leaves the short documents to fill the gaps.',
      match: {python: {all: [/reverse\s*=\s*True|key\s*=\s*lambda[^:\n]*:\s*-/]}},
    },
    {
      id: 'too-long',
      title: 'A document longer than a row is refused',
      detail:
        '`raise ValueError(…)` when an example has more than `seq_len` tokens. Splitting it silently across rows would cut a conversation in two with no context for the second half.',
      match: {python: {all: [/raise\s+ValueError\(/]}},
    },
    {
      id: 'pad-fill',
      title: 'Rows start as padding with ignored labels',
      detail:
        '`input_ids` is filled with `PAD_ID` and `labels` with `IGNORE_INDEX` before the documents are copied in, so every slot nobody claims is padding that the loss skips.',
      match: {
        python: {
          all: [
            /(?:torch\.full\(|\.new_full\(|\.fill_\().*\bPAD_ID\b/,
            /(?:torch\.full\(|\.new_full\(|\.fill_\().*\bIGNORE_INDEX\b/,
          ],
        },
      },
    },
    {
      id: 'boundary-label',
      title: "Each document's first label is ignored",
      detail:
        "A slice assignment sets `labels[r, start] = IGNORE_INDEX`: otherwise the previous document's last token is trained to predict the next document's first, across a boundary the mask hides.",
      match: {python: {all: [/\]\s*=\s*IGNORE_INDEX\b/]}},
    },
    {
      id: 'positions',
      title: 'Positions restart at every document',
      detail:
        '`position_ids[r, a:b] = torch.arange(b - a)`: a document packed at offset 300 must see positions 0, 1, 2, … as it would alone, or a learned or rotary position embedding changes its logits.',
      match: {python: {all: [/\]\s*=\s*torch\.arange\(|torch\.cat\(\s*\[\s*torch\.arange\(/]}},
    },
    {
      id: 'cu-seqlens',
      title: 'cu_seqlens are int32 boundaries',
      detail:
        "Each row's `cu_seqlens` is a `dtype=torch.int32` tensor `[0, l1, l1 + l2, …, seq_len]`, the layout and dtype varlen attention kernels take.",
      match: {python: {all: [/dtype\s*=\s*torch\.int32/]}},
    },
    {
      id: 'doc-mask',
      title: 'Same segment and causal, from tensor ops',
      detail:
        '`document_causal_mask` gives every position a segment id (`repeat_interleave`, `searchsorted`, `bucketize` or a `cumsum`), compares the ids, and ands the result with `torch.tril`.',
      match: {python: {all: [/torch\.tril\(/, /repeat_interleave\(|searchsorted\(|bucketize\(|cumsum\(/]}},
    },
    {
      id: 'no-sdpa',
      title: 'No fused attention kernel',
      detail:
        'No `F.scaled_dot_product_attention`, `flash_attn` or `flex_attention`: the mask is built and applied by hand here.',
      match: {python: {none: [/scaled_dot_product_attention/, /flash_attn/, /flex_attention/]}},
    },
  ],
  code: {
    python: {
      starter: `"""SFT data, part 2: pack rendered conversations into fixed rows with per-document positions and a block-diagonal causal mask."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from sft_template import IGNORE_INDEX, PAD_ID, VOCAB_SIZE, render


def pack(examples: list, seq_len: int) -> dict:
    """First-fit decreasing: each (input_ids, labels) pair goes whole into the first row with room for it.

    Returns {"input_ids", "labels", "position_ids"}: (R, seq_len) torch.long; "cu_seqlens": R int32 tensors
    [0, l1, l1 + l2, ..., seq_len] (the padding tail, when there is one, is the last segment); "docs": the
    example indices of each row, in placement order.
    """
    # TODO: place the longest examples first, each whole in the first row with room; reject one longer than seq_len.
    # TODO: fill input_ids with PAD_ID and labels with IGNORE_INDEX, then copy every document in.
    # TODO: positions restart at 0 per document; the first label of each document is ignored.
    # TODO: cu_seqlens per row: int32 segment boundaries ending at seq_len, the padding tail its own segment.
    raise NotImplementedError("TODO: first-fit decreasing into (R, seq_len) rows with per-document positions and cu_seqlens")


def pad_rows(examples: list, seq_len: int) -> dict:
    """Padded batching, for comparison: one example per row, the rest of the row padding. Same layout as \`pack\`."""
    rows = [pack([ex], seq_len) for ex in examples]
    batch = {key: torch.cat([b[key] for b in rows]) for key in ("input_ids", "labels", "position_ids")}
    batch["cu_seqlens"] = [b["cu_seqlens"][0] for b in rows]
    batch["docs"] = [[i] for i in range(len(examples))]
    return batch


def document_causal_mask(cu_seqlens: torch.Tensor, seq_len: int) -> torch.Tensor:
    """(seq_len, seq_len) bool, True where query i may attend to key j: same segment and j <= i."""
    raise NotImplementedError("TODO: same segment and key <= query")


def padding_waste(batch: dict) -> tuple[int, float]:
    """Pad tokens in a batch and their share of its rows × seq_len slots."""
    pad = int((batch["input_ids"] == PAD_ID).sum())
    return pad, pad / batch["input_ids"].numel()


class TinyCausalLM(nn.Module):
    """Token + learned position embedding, one single-head attention layer with a residual, a vocabulary head."""

    def __init__(self, vocab_size: int = VOCAB_SIZE, d: int = 32, max_pos: int = 256):
        super().__init__()
        self.tok = nn.Embedding(vocab_size, d)
        self.pos = nn.Embedding(max_pos, d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.head = nn.Linear(d, vocab_size)

    def forward(self, input_ids: torch.Tensor, position_ids: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """(B, S) ids and positions, (B, S, S) bool mask -> (B, S, vocab) logits."""
        x = self.tok(input_ids) + self.pos(position_ids)
        q, k, v = self.qkv(x).chunk(3, dim=-1)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(q.shape[-1])
        att = att.masked_fill(~mask, float("-inf")).softmax(dim=-1)
        return self.head(x + self.proj(att @ v))


def batch_logits(model: TinyCausalLM, batch: dict) -> torch.Tensor:
    """The model over every row of a packed batch, each row with its own document mask."""
    S = batch["input_ids"].shape[1]
    mask = torch.stack([document_causal_mask(cu, S) for cu in batch["cu_seqlens"]])
    return model(batch["input_ids"], batch["position_ids"], mask)


WORDS = "the a model token loss mask row pack pad answer question data train step batch attention".split()


def conversations(n: int, seed: int = 0) -> list:
    """\`n\` deterministic chats of varied length: an optional system turn, one to three exchanges."""
    g = torch.Generator().manual_seed(seed)

    def text(lo: int, hi: int) -> str:
        k = int(torch.randint(lo, hi + 1, (1,), generator=g))
        return " ".join(WORDS[int(i)] for i in torch.randint(len(WORDS), (k,), generator=g))

    chats = []
    for _ in range(n):
        chat = [{"role": "system", "content": text(2, 6)}] if int(torch.randint(2, (1,), generator=g)) else []
        for _ in range(int(torch.randint(1, 4, (1,), generator=g))):
            chat += [{"role": "user", "content": text(2, 12)}, {"role": "assistant", "content": text(1, 20)}]
        chats.append(chat)
    return chats


def token_losses(logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
    """Per-position cross-entropy of logits[t] against labels[t + 1]; 0 where the label is ignored."""
    V = logits.shape[-1]
    return F.cross_entropy(
        logits[:, :-1].reshape(-1, V), labels[:, 1:].reshape(-1), ignore_index=IGNORE_INDEX, reduction="none"
    ).view(labels.shape[0], -1)


if __name__ == "__main__":
    torch.manual_seed(0)
    S = 512
    examples = [render(chat, max_len=S) for chat in conversations(16)]
    lengths = [len(ids) for ids, _ in examples]
    batch = pack(examples, S)
    R = batch["input_ids"].shape[0]

    assert batch["input_ids"].shape == batch["labels"].shape == batch["position_ids"].shape == (R, S)
    assert sorted(i for docs in batch["docs"] for i in docs) == list(range(len(examples)))  # each placed once
    assert math.ceil(sum(lengths) / S) <= R < len(examples), (R, lengths)
    for r in range(R):
        cu = batch["cu_seqlens"][r]
        assert cu.dtype == torch.int32 and int(cu[0]) == 0 and int(cu[-1]) == S
        for k, i in enumerate(batch["docs"][r]):
            a, b = int(cu[k]), int(cu[k + 1])
            ids, lab = examples[i]
            assert torch.equal(batch["input_ids"][r, a:b], ids)
            assert torch.equal(batch["position_ids"][r, a:b], torch.arange(b - a))  # positions restart per document
            assert int(batch["labels"][r, a]) == IGNORE_INDEX and torch.equal(batch["labels"][r, a + 1 : b], lab[1:])
        used = int(cu[len(batch["docs"][r])])
        assert batch["input_ids"][r, used:].eq(PAD_ID).all() and batch["labels"][r, used:].eq(IGNORE_INDEX).all()

    # The mask against a slow loop: query i sees key j only in the same segment and when j <= i.
    cu = batch["cu_seqlens"][0]
    seg = [next(k for k in range(len(cu) - 1) if int(cu[k]) <= t < int(cu[k + 1])) for t in range(S)]
    slow = torch.tensor([[seg[i] == seg[j] and j <= i for j in range(S)] for i in range(S)])
    assert torch.equal(document_causal_mask(cu, S), slow)

    # Packing changes nothing a document sees: per-token losses match each document run alone.
    model = TinyCausalLM(max_pos=S).double()
    with torch.no_grad():
        packed = token_losses(batch_logits(model, batch), batch["labels"])
        worst = 0.0
        for r in range(R):
            cu = batch["cu_seqlens"][r]
            for k, i in enumerate(batch["docs"][r]):
                a, b = int(cu[k]), int(cu[k + 1])
                ids, lab = examples[i]
                n = len(ids)
                alone = model(ids[None], torch.arange(n)[None], torch.tril(torch.ones(n, n, dtype=torch.bool))[None])
                worst = max(worst, (packed[r, a : b - 1] - token_losses(alone, lab[None])[0]).abs().max().item())
        assert worst <= 1e-6, worst

        # The naive pack (one causal mask over the row, positions running on) leaks across documents.
        row = max(range(R), key=lambda r: len(batch["docs"][r]))
        cu = batch["cu_seqlens"][row]
        naive_mask = torch.tril(torch.ones(S, S, dtype=torch.bool))[None]
        naive = model(batch["input_ids"][row][None], torch.arange(S)[None], naive_mask)
        leak = (token_losses(naive, batch["labels"][row][None])[0] - packed[row]).abs()
        second = leak[int(cu[1]) : int(cu[2]) - 1].max().item()
        assert second > 1e-3, second

    pad_packed, frac_packed = padding_waste(batch)
    padded = pad_rows(examples, S)
    pad_padded, frac_padded = padding_waste(padded)
    assert frac_packed < frac_padded and R < padded["input_ids"].shape[0]
    print(f"{len(examples)} conversations, {sum(lengths)} tokens, lengths {min(lengths)} to {max(lengths)}")
    print(f"padded: {len(examples)} rows x {S}, {pad_padded} pad tokens ({frac_padded:.1%})")
    print(f"packed: {R} rows x {S}, {pad_packed} pad tokens ({frac_packed:.1%})")
    print(f"packed vs alone, max per-token loss difference {worst:.1e}; naive pack shifts document 2 by {second:.2f}")
    print("PASS")
`,
      solution: `"""SFT data, part 2: pack rendered conversations into fixed rows with per-document positions and a block-diagonal causal mask."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from sft_template import IGNORE_INDEX, PAD_ID, VOCAB_SIZE, render


def pack(examples: list, seq_len: int) -> dict:
    """First-fit decreasing: each (input_ids, labels) pair goes whole into the first row with room for it.

    Returns {"input_ids", "labels", "position_ids"}: (R, seq_len) torch.long; "cu_seqlens": R int32 tensors
    [0, l1, l1 + l2, ..., seq_len] (the padding tail, when there is one, is the last segment); "docs": the
    example indices of each row, in placement order.
    """
    order = sorted(range(len(examples)), key=lambda i: len(examples[i][0]), reverse=True)
    rows, room = [], []
    for i in order:
        n = len(examples[i][0])
        if n > seq_len:
            raise ValueError(f"example {i} has {n} tokens, more than seq_len={seq_len}: truncate it in render")
        r = next((r for r in range(len(rows)) if room[r] >= n), None)
        if r is None:
            rows.append([])
            room.append(seq_len)
            r = len(rows) - 1
        rows[r].append(i)
        room[r] -= n

    R = len(rows)
    input_ids = torch.full((R, seq_len), PAD_ID, dtype=torch.long)
    labels = torch.full((R, seq_len), IGNORE_INDEX, dtype=torch.long)
    position_ids = torch.zeros((R, seq_len), dtype=torch.long)
    cu_seqlens = []
    for r, docs in enumerate(rows):
        bounds, start = [0], 0
        for i in docs:
            ids, lab = examples[i]
            end = start + len(ids)
            input_ids[r, start:end] = ids
            labels[r, start:end] = lab
            labels[r, start] = IGNORE_INDEX  # never train the previous document's last token to predict this one
            position_ids[r, start:end] = torch.arange(end - start)
            bounds.append(end)
            start = end
        if start < seq_len:  # the padding is a segment of its own: it attends to itself, never to a document
            position_ids[r, start:] = torch.arange(seq_len - start)
            bounds.append(seq_len)
        cu_seqlens.append(torch.tensor(bounds, dtype=torch.int32))
    return {"input_ids": input_ids, "labels": labels, "position_ids": position_ids, "cu_seqlens": cu_seqlens, "docs": rows}


def pad_rows(examples: list, seq_len: int) -> dict:
    """Padded batching, for comparison: one example per row, the rest of the row padding. Same layout as \`pack\`."""
    rows = [pack([ex], seq_len) for ex in examples]
    batch = {key: torch.cat([b[key] for b in rows]) for key in ("input_ids", "labels", "position_ids")}
    batch["cu_seqlens"] = [b["cu_seqlens"][0] for b in rows]
    batch["docs"] = [[i] for i in range(len(examples))]
    return batch


def document_causal_mask(cu_seqlens: torch.Tensor, seq_len: int) -> torch.Tensor:
    """(seq_len, seq_len) bool, True where query i may attend to key j: same segment and j <= i."""
    lengths = (cu_seqlens[1:] - cu_seqlens[:-1]).long()
    doc = torch.repeat_interleave(torch.arange(len(lengths)), lengths)
    same_doc = doc[:, None] == doc[None, :]
    causal = torch.tril(torch.ones(seq_len, seq_len, dtype=torch.bool))
    return same_doc & causal


def padding_waste(batch: dict) -> tuple[int, float]:
    """Pad tokens in a batch and their share of its rows × seq_len slots."""
    pad = int((batch["input_ids"] == PAD_ID).sum())
    return pad, pad / batch["input_ids"].numel()


class TinyCausalLM(nn.Module):
    """Token + learned position embedding, one single-head attention layer with a residual, a vocabulary head."""

    def __init__(self, vocab_size: int = VOCAB_SIZE, d: int = 32, max_pos: int = 256):
        super().__init__()
        self.tok = nn.Embedding(vocab_size, d)
        self.pos = nn.Embedding(max_pos, d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.head = nn.Linear(d, vocab_size)

    def forward(self, input_ids: torch.Tensor, position_ids: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """(B, S) ids and positions, (B, S, S) bool mask -> (B, S, vocab) logits."""
        x = self.tok(input_ids) + self.pos(position_ids)
        q, k, v = self.qkv(x).chunk(3, dim=-1)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(q.shape[-1])
        att = att.masked_fill(~mask, float("-inf")).softmax(dim=-1)
        return self.head(x + self.proj(att @ v))


def batch_logits(model: TinyCausalLM, batch: dict) -> torch.Tensor:
    """The model over every row of a packed batch, each row with its own document mask."""
    S = batch["input_ids"].shape[1]
    mask = torch.stack([document_causal_mask(cu, S) for cu in batch["cu_seqlens"]])
    return model(batch["input_ids"], batch["position_ids"], mask)


WORDS = "the a model token loss mask row pack pad answer question data train step batch attention".split()


def conversations(n: int, seed: int = 0) -> list:
    """\`n\` deterministic chats of varied length: an optional system turn, one to three exchanges."""
    g = torch.Generator().manual_seed(seed)

    def text(lo: int, hi: int) -> str:
        k = int(torch.randint(lo, hi + 1, (1,), generator=g))
        return " ".join(WORDS[int(i)] for i in torch.randint(len(WORDS), (k,), generator=g))

    chats = []
    for _ in range(n):
        chat = [{"role": "system", "content": text(2, 6)}] if int(torch.randint(2, (1,), generator=g)) else []
        for _ in range(int(torch.randint(1, 4, (1,), generator=g))):
            chat += [{"role": "user", "content": text(2, 12)}, {"role": "assistant", "content": text(1, 20)}]
        chats.append(chat)
    return chats


def token_losses(logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
    """Per-position cross-entropy of logits[t] against labels[t + 1]; 0 where the label is ignored."""
    V = logits.shape[-1]
    return F.cross_entropy(
        logits[:, :-1].reshape(-1, V), labels[:, 1:].reshape(-1), ignore_index=IGNORE_INDEX, reduction="none"
    ).view(labels.shape[0], -1)


if __name__ == "__main__":
    torch.manual_seed(0)
    S = 512
    examples = [render(chat, max_len=S) for chat in conversations(16)]
    lengths = [len(ids) for ids, _ in examples]
    batch = pack(examples, S)
    R = batch["input_ids"].shape[0]

    assert batch["input_ids"].shape == batch["labels"].shape == batch["position_ids"].shape == (R, S)
    assert sorted(i for docs in batch["docs"] for i in docs) == list(range(len(examples)))  # each placed once
    assert math.ceil(sum(lengths) / S) <= R < len(examples), (R, lengths)
    for r in range(R):
        cu = batch["cu_seqlens"][r]
        assert cu.dtype == torch.int32 and int(cu[0]) == 0 and int(cu[-1]) == S
        for k, i in enumerate(batch["docs"][r]):
            a, b = int(cu[k]), int(cu[k + 1])
            ids, lab = examples[i]
            assert torch.equal(batch["input_ids"][r, a:b], ids)
            assert torch.equal(batch["position_ids"][r, a:b], torch.arange(b - a))  # positions restart per document
            assert int(batch["labels"][r, a]) == IGNORE_INDEX and torch.equal(batch["labels"][r, a + 1 : b], lab[1:])
        used = int(cu[len(batch["docs"][r])])
        assert batch["input_ids"][r, used:].eq(PAD_ID).all() and batch["labels"][r, used:].eq(IGNORE_INDEX).all()

    # The mask against a slow loop: query i sees key j only in the same segment and when j <= i.
    cu = batch["cu_seqlens"][0]
    seg = [next(k for k in range(len(cu) - 1) if int(cu[k]) <= t < int(cu[k + 1])) for t in range(S)]
    slow = torch.tensor([[seg[i] == seg[j] and j <= i for j in range(S)] for i in range(S)])
    assert torch.equal(document_causal_mask(cu, S), slow)

    # Packing changes nothing a document sees: per-token losses match each document run alone.
    model = TinyCausalLM(max_pos=S).double()
    with torch.no_grad():
        packed = token_losses(batch_logits(model, batch), batch["labels"])
        worst = 0.0
        for r in range(R):
            cu = batch["cu_seqlens"][r]
            for k, i in enumerate(batch["docs"][r]):
                a, b = int(cu[k]), int(cu[k + 1])
                ids, lab = examples[i]
                n = len(ids)
                alone = model(ids[None], torch.arange(n)[None], torch.tril(torch.ones(n, n, dtype=torch.bool))[None])
                worst = max(worst, (packed[r, a : b - 1] - token_losses(alone, lab[None])[0]).abs().max().item())
        assert worst <= 1e-6, worst

        # The naive pack (one causal mask over the row, positions running on) leaks across documents.
        row = max(range(R), key=lambda r: len(batch["docs"][r]))
        cu = batch["cu_seqlens"][row]
        naive_mask = torch.tril(torch.ones(S, S, dtype=torch.bool))[None]
        naive = model(batch["input_ids"][row][None], torch.arange(S)[None], naive_mask)
        leak = (token_losses(naive, batch["labels"][row][None])[0] - packed[row]).abs()
        second = leak[int(cu[1]) : int(cu[2]) - 1].max().item()
        assert second > 1e-3, second

    pad_packed, frac_packed = padding_waste(batch)
    padded = pad_rows(examples, S)
    pad_padded, frac_padded = padding_waste(padded)
    assert frac_packed < frac_padded and R < padded["input_ids"].shape[0]
    print(f"{len(examples)} conversations, {sum(lengths)} tokens, lengths {min(lengths)} to {max(lengths)}")
    print(f"padded: {len(examples)} rows x {S}, {pad_padded} pad tokens ({frac_padded:.1%})")
    print(f"packed: {R} rows x {S}, {pad_packed} pad tokens ({frac_packed:.1%})")
    print(f"packed vs alone, max per-token loss difference {worst:.1e}; naive pack shifts document 2 by {second:.2f}")
    print("PASS")
`,
    },
  },
  debrief: `Packing is bin packing: rows are bins of \`seq_len\` slots, documents are items, and the goal is the fewest rows. It is NP-hard, and first-fit decreasing is the textbook baseline, never worse than 11/9 of the optimal row count plus a constant. Krell et al. treat BERT's pretraining and fine-tuning data this way and give histogram-based variants that pack millions of sequences in seconds. On this test the gain is 16 rows to 8; Krell et al. measure 50 % padding in BERT's Wikipedia data at 512 tokens, and up to 89 % on GLUE's CoLA at 128.

The mask and the positions are what make the packing invisible. With one causal mask over the row, document 2 attends to all of document 1: the model is trained on a context that never happens at inference, and its losses change (by up to 1.8 nats per token in this test). Krell et al. call this cross-contamination; the Llama 3 paper uses a document mask for the same reason and found it matters most when training on long sequences. **Restarting positions** matters for a learned absolute table like \`TinyCausalLM\`'s. Under RoPE and a document mask the scores depend only on distances inside one document, so the restart changes nothing mathematically, but Hugging Face's FlashAttention 2 path uses it as the signal: a \`position_ids\` that returns to 0 marks a new sequence, and \`cu_seqlens\` is computed from it. **The first label of each document is ignored** for the same leak in the loss: logit \`t\` at the end of document 1 would otherwise be graded on document 2's first token.

What production adds: no \`(S, S)\` mask at all. At \`S = 8192\` a bool mask is 64 MiB per row; FlashAttention's \`flash_attn_varlen_func\` takes the flattened tokens and \`cu_seqlens\` and skips the cross-document tiles entirely, and FlexAttention compiles a \`document_id[q] == document_id[kv]\` mask function into a block-sparse kernel. TRL's \`SFTTrainer\` packs with best-fit decreasing by default (\`packing=True\`, \`packing_strategy="bfd"\`), and then goes padding-free: one flattened sequence per batch whose boundaries FlashAttention reads from the position ids.`,
};
