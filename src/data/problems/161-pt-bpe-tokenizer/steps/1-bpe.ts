import type {Step} from '@/lib/types';

/** `pattern` somewhere inside the body of method `name` (methods are indented four spaces; the body ends at the next one or at the self-test). */
const inMethod = (name: string, pattern: RegExp): RegExp =>
  new RegExp(`def ${name}\\((?:(?!\\n    def |\\n    @|\\nif __name__)[\\s\\S])*?${pattern.source}`);

/** `zip(ids, ids[1:])`: the adjacent pairs of a sequence, whatever the list is called. */
const ADJACENT_PAIRS = /zip\(\s*(\w+)\s*,\s*\1\[\s*1\s*:\s*\]\s*\)/;

export const bpeStep: Step = {
  id: 'bpe',
  title: 'BPETokenizer: train the merges, encode in rank order, decode bytes',
  concept: 'pytorch',
  file: 'bpe',
  focus: ['utf8', 'count', 'pick', 'record', 'replace', 'lowest', 'apply', 'ids', 'lookup', 'utf8-decode'],
  task: `## Task

Implement \`BPETokenizer\` in \`bpe.py\`: a byte-level BPE tokenizer with the training loop, the
rank-ordered encoder, the lossless-or-replaced decoder and a JSON merge file. Pure Python — no
\`tiktoken\`, \`tokenizers\` or \`sentencepiece\`.

- **State.** \`merges: list[tuple[int, int]]\` in the order learned — the pair at index \`r\` has rank
  \`r\` and was merged into id \`256 + r\`. \`vocab: dict[int, bytes]\` starts as the 256 single bytes
  (\`{i: bytes([i]) for i in range(256)}\`) and gains \`vocab[256 + r] = vocab[a] + vocab[b]\` per merge.
- **\`train(text, vocab_size) -> list[int]\`.** Reset the state, \`ids = list(text.encode("utf-8"))\`,
  then while \`len(vocab) < vocab_size\`: count every adjacent pair of \`ids\` across the whole corpus
  (\`Counter(zip(ids, ids[1:]))\`), take the most frequent — **ties go to the pair seen first** in the
  corpus, which is what \`max(counts, key=counts.get)\` gives — stop early if it occurs fewer than
  twice, otherwise append it to \`merges\`, add its bytes to \`vocab\` and replace every occurrence in
  \`ids\` by the new id. Return \`ids\` as the last merge left them.

:::widget bpe-merges

- **\`encode(text) -> list[int]\`.** \`ids = list(text.encode("utf-8"))\`; while two or more ids remain,
  find the adjacent pair with the **lowest rank** (\`min\` over \`zip(ids, ids[1:])\` keyed by
  \`ranks.get(pair, float("inf"))\`), stop if it has no rank, otherwise merge every occurrence into
  \`256 + rank\`. On the training text this reproduces \`train\`'s final \`ids\` exactly.
- **\`decode(ids) -> str\`.** \`b"".join(vocab[i] for i in ids).decode("utf-8", errors="replace")\`: a
  token boundary inside a multi-byte character yields \`U+FFFD\`, never an exception.
- **\`save(path)\`** writes \`{"merges": [[a, b], ...]}\` with \`json.dump\`; **\`load(path)\`** (a
  classmethod) reads it with \`json.load\` and rebuilds \`merges\` and \`vocab\` by replaying the pairs.
- The self-test at the bottom trains on Sennrich's corpus (\`low\` ×5, \`lower\` ×2, \`widest\` ×3,
  \`newest\` ×6): the first merge must be \`(101, 115)\` = \`b"es"\` (9 occurrences, seen before \`st\`'s 9),
  \`encode(corpus)\` must equal what \`train\` returned, ASCII and 2-, 3- and 4-byte UTF-8 text must
  round-trip, \`decode([0x80])\` must be \`"\\ufffd"\`, bytes-per-token must grow from vocab 256 to 270
  to 300, and a saved-then-loaded tokenizer must encode identically.

> The merge list is the model. Training decides its order by frequency; encoding must replay that
> order — lowest rank first — or it produces token sequences the network never saw.`,
  hints: [
    'Write `_merge(ids, pair, new_id)` first: walk `ids` left to right, emit `new_id` and skip two when `ids[i], ids[i+1] == pair`, else emit `ids[i]`. Both `train` and `encode` are loops around it.',
    'In `train`, `Counter(zip(ids, ids[1:]))` counts pairs in corpus order, so `max(counts, key=counts.get)` returns the first-seen pair among equals — that is the tie-break. The new id is `256 + len(self.merges)` before you append.',
    'In `encode`, `min(zip(ids, ids[1:]), key=lambda p: ranks.get(p, float("inf")))` is the GPT-2 idiom: pairs without a rank sort last, and when the winner has no rank you are done. Build `ranks = {pair: r for r, pair in enumerate(self.merges)}` once per call.',
  ],
  checks: [
    {
      id: 'byte-base',
      title: 'The base vocabulary is the 256 bytes and text enters as UTF-8',
      detail:
        '`vocab` starts as `{i: bytes([i]) for i in range(256)}` and `encode` works on `text.encode("utf-8")`, so every string — any script, any emoji — is encodable with nothing out of vocabulary.',
      match: {
        python: {
          all: [/range\(\s*256\s*\)/, /bytes\(\s*\[/, inMethod('encode', /\.encode\(\s*["']utf-8["']\s*\)/)],
        },
      },
    },
    {
      id: 'pair-counts',
      title: 'Training counts every adjacent pair across the whole corpus each round',
      detail:
        'Each round of `train` builds the counts of `zip(ids, ids[1:])` over the full id sequence (a `Counter` or an equivalent dict); on the self-test corpus the first count finds `(101, 115)` nine times.',
      match: {
        python: {
          all: [inMethod('train', ADJACENT_PAIRS), /Counter\(|\.get\(\s*\w+\s*,\s*0\s*\)\s*\+\s*1|\]\s*\+=\s*1/],
        },
      },
    },
    {
      id: 'most-frequent-first-seen',
      title: 'The most frequent pair is merged, ties going to the pair seen first',
      detail:
        '`max(counts, key=counts.get)` (or `most_common(1)`) over counts built in corpus order picks `b"es"` over `b"st"` when both occur nine times, so two trainings of one corpus give one merge list.',
      match: {
        python: {
          all: [inMethod('train', /max\(\s*\w+\s*,\s*key\s*=\s*\w+\.get\s*\)|\.most_common\(\s*1\s*\)/)],
          none: [/sorted\(\s*\w+\.items\(\)/],
        },
      },
    },
    {
      id: 'merge-record',
      title: 'Each merge gets the next id and its bytes are the concatenation of its parts',
      detail:
        'The loop runs while `len(self.vocab) < vocab_size`; the merged pair is appended to `self.merges` and `self.vocab[256 + rank] = self.vocab[a] + self.vocab[b]`, so `vocab[257]` on the self-test corpus is `b"est"`.',
      match: {
        python: {
          all: [
            /while\s+len\(\s*self\.vocab\s*\)\s*<\s*vocab_size/,
            /self\.merges\.append\(/,
            /self\.vocab\[[^\n=]+\]\s*=\s*self\.vocab\[[^\n+]+\+\s*self\.vocab\[/,
          ],
        },
      },
    },
    {
      id: 'encode-rank-order',
      title: 'encode applies the lowest-ranked merge present, repeatedly, with no tokenizer library',
      detail:
        'Each round takes `min` over the adjacent pairs keyed by rank with `float("inf")` for unranked pairs and merges all of its occurrences; `encode(corpus)` then equals the ids `train` ended with. No `tiktoken`, `tokenizers` or `sentencepiece`.',
      match: {
        python: {
          all: [inMethod('encode', /min\(/), inMethod('encode', /float\(\s*["']inf["']\s*\)|math\.inf/)],
          none: [/\btiktoken\b/, /\bsentencepiece\b/, /from\s+tokenizers\b|import\s+tokenizers\b/, /\btransformers\b/],
        },
      },
    },
    {
      id: 'decode-replace',
      title: 'decode joins the tokens’ bytes and replaces invalid UTF-8 instead of raising',
      detail:
        '`b"".join(self.vocab[i] for i in ids).decode("utf-8", errors="replace")`: `decode([0x80])` is `"\\ufffd"` and a 4-byte emoji split across two tokens still decodes when both are present.',
      match: {
        python: {
          all: [/b["']["']\.join\(/, /\.decode\(\s*["']utf-8["']\s*,\s*errors\s*=\s*["']replace["']\s*\)/],
        },
      },
    },
    {
      id: 'save-load',
      title: 'The merge list is saved as JSON and a loaded tokenizer rebuilds the vocab from it',
      detail:
        '`save` writes `{"merges": [[a, b], ...]}` with `json.dump`; `load` reads it with `json.load` and replays the pairs so `loaded.vocab == tok.vocab` and both encode identically. The merges are the whole model.',
      match: {
        python: {
          all: [inMethod('save', /json\.dump\(/), inMethod('load', /json\.load\(/), /@classmethod\s+def load\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Byte-level byte-pair encoding: train the merges on a corpus, encode by replaying them in rank order, decode back to text."""
from __future__ import annotations

import json
import os
import tempfile
from collections import Counter


class BPETokenizer:
    """The tokenizer in front of a GPT: 256 byte tokens plus one learned merge per extra id."""

    def __init__(self) -> None:
        self.merges: list[tuple[int, int]] = []
        self.vocab: dict[int, bytes] = {i: bytes([i]) for i in range(256)}

    @property
    def ranks(self) -> dict[tuple[int, int], int]:
        """Pair → rank (its index in \`merges\`); id of the merged token is \`256 + rank\`."""
        return {pair: rank for rank, pair in enumerate(self.merges)}

    @staticmethod
    def _merge(ids: list[int], pair: tuple[int, int], new_id: int) -> list[int]:
        """Every non-overlapping occurrence of \`pair\` in \`ids\`, left to right, becomes \`new_id\`."""
        raise NotImplementedError("TODO: walk ids, emit new_id and skip two on a match")

    def train(self, text: str, vocab_size: int) -> list[int]:
        """Learn \`vocab_size - 256\` merges from \`text\`; returns the corpus as ids after the last merge."""
        raise NotImplementedError("TODO: count pairs, merge the most frequent (first seen on ties), record, repeat")

    def encode(self, text: str) -> list[int]:
        """UTF-8 bytes, then the lowest-ranked merge present is applied until no pair has a rank."""
        raise NotImplementedError("TODO: min rank among adjacent pairs, merge, repeat")

    def decode(self, ids: list[int]) -> str:
        """Concatenate the tokens' bytes; a split multi-byte character decodes to U+FFFD, never raises."""
        raise NotImplementedError("TODO: join vocab bytes, decode utf-8 with errors='replace'")

    def save(self, path: str) -> None:
        """The merges in rank order are the whole model; the vocab is derived from them."""
        raise NotImplementedError("TODO: json.dump the merges")

    @classmethod
    def load(cls, path: str) -> BPETokenizer:
        raise NotImplementedError("TODO: json.load the merges, replay them into merges and vocab")


if __name__ == "__main__":
    # 1. The first merge on Sennrich's corpus: "es" (9 times) beats "st" (9 times) because it is seen first.
    words = ["low"] * 5 + ["lower"] * 2 + ["widest"] * 3 + ["newest"] * 6
    corpus = " ".join(words)
    tok = BPETokenizer()
    train_ids = tok.train(corpus, 300)
    assert tok.merges[0] == (ord("e"), ord("s")), tok.merges[:3]
    assert tok.vocab[256] == b"es" and tok.vocab[257] == b"est", (tok.vocab[256], tok.vocab[257])
    assert all(len(tok.vocab[i]) == len(tok.vocab[a]) + len(tok.vocab[b]) for i, (a, b) in enumerate(tok.merges, 256))

    # 2. encode replays the training merges in rank order: it lands on the segmentation training ended with.
    ids = tok.encode(corpus)
    assert ids == train_ids, (ids[:10], train_ids[:10])
    assert tok.decode(ids) == corpus
    assert tok.encode(tok.decode(ids)) == ids

    # 3. Round trips: ASCII and multi-byte UTF-8 (2-, 3- and 4-byte characters), including text never seen in training.
    for text in ["hello world", corpus, "naïve café — 日本語 🙂", "", "newest\\n\\tlowest"]:
        assert tok.decode(tok.encode(text)) == text, text
    assert tok.encode("") == []

    # 4. decode never raises on a token boundary inside a character: a lone continuation byte is U+FFFD.
    assert tok.decode([0x80]) == "\\ufffd"
    assert tok.decode(list("é".encode("utf-8"))[:1]) == "\\ufffd"

    # 5. More merges, fewer tokens: the compression ratio (bytes per token) grows with vocab_size.
    n_bytes = len(corpus.encode("utf-8"))
    ratios = []
    for size in (256, 270, 300):
        t = BPETokenizer()
        t.train(corpus, size)
        n_tokens = len(t.encode(corpus))
        ratios.append(n_bytes / n_tokens)
    assert ratios[0] == 1.0 and ratios[0] < ratios[1] < ratios[2], ratios

    # 6. save/load: the merges are the model; the loaded tokenizer encodes identically and rebuilds the same vocab.
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "merges.json")
        tok.save(path)
        loaded = BPETokenizer.load(path)
    assert loaded.merges == tok.merges and loaded.vocab == tok.vocab
    assert loaded.encode("the newest, lowest, widest") == tok.encode("the newest, lowest, widest")

    print(f"merges={len(tok.merges)} first={tok.vocab[256]!r} {tok.vocab[257]!r} ratios={[round(r, 2) for r in ratios]}")
    print("PASS")
`,
      solution: `"""Byte-level byte-pair encoding: train the merges on a corpus, encode by replaying them in rank order, decode back to text."""
from __future__ import annotations

import json
import os
import tempfile
from collections import Counter


class BPETokenizer:
    """The tokenizer in front of a GPT: 256 byte tokens plus one learned merge per extra id."""

    def __init__(self) -> None:
        self.merges: list[tuple[int, int]] = []
        self.vocab: dict[int, bytes] = {i: bytes([i]) for i in range(256)}

    @property
    def ranks(self) -> dict[tuple[int, int], int]:
        """Pair → rank (its index in \`merges\`); id of the merged token is \`256 + rank\`."""
        return {pair: rank for rank, pair in enumerate(self.merges)}

    @staticmethod
    def _merge(ids: list[int], pair: tuple[int, int], new_id: int) -> list[int]:
        """Every non-overlapping occurrence of \`pair\` in \`ids\`, left to right, becomes \`new_id\`."""
        out: list[int] = []
        i = 0
        while i < len(ids):
            if i + 1 < len(ids) and ids[i] == pair[0] and ids[i + 1] == pair[1]:
                out.append(new_id)
                i += 2
            else:
                out.append(ids[i])
                i += 1
        return out

    def train(self, text: str, vocab_size: int) -> list[int]:
        """Learn \`vocab_size - 256\` merges from \`text\`; returns the corpus as ids after the last merge."""
        if vocab_size < 256:
            raise ValueError("vocab_size must be at least 256")
        self.merges = []
        self.vocab = {i: bytes([i]) for i in range(256)}
        ids = list(text.encode("utf-8"))
        while len(self.vocab) < vocab_size:
            counts = Counter(zip(ids, ids[1:]))
            if not counts:
                break
            pair = max(counts, key=counts.get)  # ties → the pair seen first in the corpus
            if counts[pair] < 2:
                break
            new_id = 256 + len(self.merges)
            self.merges.append(pair)
            self.vocab[new_id] = self.vocab[pair[0]] + self.vocab[pair[1]]
            ids = self._merge(ids, pair, new_id)
        return ids

    def encode(self, text: str) -> list[int]:
        """UTF-8 bytes, then the lowest-ranked merge present is applied until no pair has a rank."""
        ranks = self.ranks
        ids = list(text.encode("utf-8"))
        while len(ids) >= 2:
            pair = min(zip(ids, ids[1:]), key=lambda p: ranks.get(p, float("inf")))
            if pair not in ranks:
                break
            ids = self._merge(ids, pair, 256 + ranks[pair])
        return ids

    def decode(self, ids: list[int]) -> str:
        """Concatenate the tokens' bytes; a split multi-byte character decodes to U+FFFD, never raises."""
        return b"".join(self.vocab[i] for i in ids).decode("utf-8", errors="replace")

    def save(self, path: str) -> None:
        """The merges in rank order are the whole model; the vocab is derived from them."""
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"merges": [list(pair) for pair in self.merges]}, f)

    @classmethod
    def load(cls, path: str) -> BPETokenizer:
        with open(path, encoding="utf-8") as f:
            merges = json.load(f)["merges"]
        tok = cls()
        for a, b in merges:
            tok.merges.append((a, b))
            tok.vocab[256 + len(tok.merges) - 1] = tok.vocab[a] + tok.vocab[b]
        return tok


if __name__ == "__main__":
    # 1. The first merge on Sennrich's corpus: "es" (9 times) beats "st" (9 times) because it is seen first.
    words = ["low"] * 5 + ["lower"] * 2 + ["widest"] * 3 + ["newest"] * 6
    corpus = " ".join(words)
    tok = BPETokenizer()
    train_ids = tok.train(corpus, 300)
    assert tok.merges[0] == (ord("e"), ord("s")), tok.merges[:3]
    assert tok.vocab[256] == b"es" and tok.vocab[257] == b"est", (tok.vocab[256], tok.vocab[257])
    assert all(len(tok.vocab[i]) == len(tok.vocab[a]) + len(tok.vocab[b]) for i, (a, b) in enumerate(tok.merges, 256))

    # 2. encode replays the training merges in rank order: it lands on the segmentation training ended with.
    ids = tok.encode(corpus)
    assert ids == train_ids, (ids[:10], train_ids[:10])
    assert tok.decode(ids) == corpus
    assert tok.encode(tok.decode(ids)) == ids

    # 3. Round trips: ASCII and multi-byte UTF-8 (2-, 3- and 4-byte characters), including text never seen in training.
    for text in ["hello world", corpus, "naïve café — 日本語 🙂", "", "newest\\n\\tlowest"]:
        assert tok.decode(tok.encode(text)) == text, text
    assert tok.encode("") == []

    # 4. decode never raises on a token boundary inside a character: a lone continuation byte is U+FFFD.
    assert tok.decode([0x80]) == "\\ufffd"
    assert tok.decode(list("é".encode("utf-8"))[:1]) == "\\ufffd"

    # 5. More merges, fewer tokens: the compression ratio (bytes per token) grows with vocab_size.
    n_bytes = len(corpus.encode("utf-8"))
    ratios = []
    for size in (256, 270, 300):
        t = BPETokenizer()
        t.train(corpus, size)
        n_tokens = len(t.encode(corpus))
        ratios.append(n_bytes / n_tokens)
    assert ratios[0] == 1.0 and ratios[0] < ratios[1] < ratios[2], ratios

    # 6. save/load: the merges are the model; the loaded tokenizer encodes identically and rebuilds the same vocab.
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "merges.json")
        tok.save(path)
        loaded = BPETokenizer.load(path)
    assert loaded.merges == tok.merges and loaded.vocab == tok.vocab
    assert loaded.encode("the newest, lowest, widest") == tok.encode("the newest, lowest, widest")

    print(f"merges={len(tok.merges)} first={tok.vocab[256]!r} {tok.vocab[257]!r} ratios={[round(r, 2) for r in ratios]}")
    print("PASS")
`,
    },
  },
  debrief: `Three decisions give the tokenizer its shape. The base vocabulary is **bytes**, not characters: 256 ids cover every string in every script with no \`<unk>\`, and a character the corpus never contained still encodes — as its two to four bytes — which is why GPT-2 could drop the unknown token and why \`decode\` must tolerate a boundary inside a character (\`errors="replace"\`). The merge list is **ordered**, and the order is the model: training merges the most frequent pair of the moment, so a merge learned later may contain an id that only exists because of an earlier one, and \`encode\` replays them lowest rank first — the \`min(pairs, key=rank)\` loop in GPT-2's \`bpe()\` — because after rank \`r\` is applied no pair of lower rank can reappear (every new pair contains the new id), so "lowest rank present, repeat" is exactly "apply merge 0, then 1, then 2 …" and lands on the segmentation the corpus had during training; \`encode(corpus) == train_ids\` is that property. And ties break **deterministically** on the pair seen first, because a tokenizer trained twice must produce the same merge file or every checkpoint that used it is unreadable. The self-test corpus is small enough to memorise, which is why training stops when the best pair occurs once — a merge with support 1 is a quirk of the corpus, not a statistic. Production tokenizers keep this loop and change its surroundings: GPT-2 and tiktoken split text with a regex first (\`'s\`, \` word\`, digits in groups of three) so no merge crosses a word boundary; training on gigabytes keeps pair counts incrementally instead of recounting each round and runs in Rust across threads (Hugging Face \`tokenizers\`, tiktoken's \`_educational.py\` shows the same loop in Python); special tokens like \`<|endoftext|>\` are matched before BPE runs; and a model's embedding table has one row per id, which is why \`vocab_size\` is a hyperparameter of the model as much as of the tokenizer.`,
};
