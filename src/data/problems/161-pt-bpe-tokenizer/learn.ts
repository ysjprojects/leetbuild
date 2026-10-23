/**
 * The learning guide for the BPE tokenizer drill: where byte-pair encoding comes from and why every
 * GPT reads through it, why the base vocabulary is bytes, how the training loop learns an ordered
 * merge list, why encoding must replay that list lowest rank first, what decoding has to tolerate,
 * and what production tokenizers add (a figure or a table where one says it faster than prose, a
 * pop quiz per section). Rendered at `/pt-bpe-tokenizer/learn`.
 */
export const learn = `# The mechanism at a glance

A language model consumes integers. The function that turns a string into them, and the ids it
produces back into a string, is the **tokenizer**. GPT-2 made **byte-level byte-pair encoding** (BPE)
the standard: the GPT family, Llama 3 and many other large models read through it. It has no neural
network in it. It is a list of **merges** learned from a corpus by one greedy loop, and the list is
the whole model:

:::architecture
{
  "input": "\\"naïve café 🙂\\"",
  "output": "decode(encode(s)) == s",
  "items": [
    {"id": "text", "label": "Text", "kind": "io", "sub": "str · any script"},
    {"tone": "dotted", "label": "GPT-2 only · not in the drill", "items": [
      {"id": "regex", "label": "Pre-tokenizer regex", "sub": "'s|'t|…| ?\\\\p{L}+| ?\\\\p{N}+|…", "detail": "Splits the string into chunks; BPE runs inside each, so no merge crosses a word boundary."}
    ]},
    {"id": "utf8", "label": "UTF-8 bytes", "kind": "embed", "sub": "list(text.encode(\\"utf-8\\"))", "shape": "list[int] in 0..255", "detail": "The base vocabulary: ids 0..255 are the bytes themselves."},
    {"tone": "dotted", "label": "GPT-2 only · not in the drill", "items": [
      {"id": "byte-map", "label": "byte → unicode map", "sub": "bytes_to_unicode() · 256 chars", "detail": "A printable stand-in per byte, so the merge file is text. No effect on which merges happen."}
    ]},
    {"columns": [
      [{"tone": "block", "repeat": "vocab_size − 256 ×", "label": "train: one merge", "items": [
        {"id": "count", "label": "Count adjacent pairs", "sub": "Counter(zip(ids, ids[1:]))"},
        {"id": "pick", "label": "Most frequent pair", "sub": "max · ties to the first seen"},
        {"id": "record", "label": "Record the merge", "sub": "merges[r] · vocab[256 + r]"},
        {"id": "replace", "label": "Replace every occurrence", "sub": "_merge(ids, pair, 256 + r)"}
      ]}],
      [{"tone": "block", "repeat": "until no rank ×", "label": "encode: one merge", "items": [
        {"id": "lowest", "label": "Lowest-ranked pair", "sub": "min(pairs, key=ranks.get)", "detail": "Pairs without a rank key to infinity; when the winner has none, encoding stops."},
        {"id": "apply", "label": "Merge it everywhere", "sub": "_merge(ids, pair, 256 + rank)"}
      ]}]
    ]},
    {"id": "ids", "label": "Token ids", "kind": "io", "sub": "list[int] · each < vocab_size", "detail": "One embedding row per id in the model."},
    {"tone": "dotted", "label": "decode(ids)", "items": [
      {"id": "lookup", "label": "Join the tokens' bytes", "sub": "b\\"\\".join(vocab[i] for i in ids)"},
      {"id": "utf8-decode", "label": "UTF-8 decode", "sub": ".decode(\\"utf-8\\", errors=\\"replace\\")"}
    ]},
    {"id": "text-out", "label": "Text", "kind": "io", "sub": "str · U+FFFD for a split char"}
  ],
  "notes": [
    {"at": "utf8", "text": "**256** base ids: nothing is out of vocabulary"},
    {"at": "record", "text": "The **ordered** merge list is the model"},
    {"at": "lowest", "text": "Replays training: **lowest** rank first"},
    {"at": "utf8-decode", "text": "A split character becomes **U+FFFD**"}
  ]
}
:::

Read it bottom to top: \`train\` and \`encode\` are two loops around the same \`_merge\` helper, one choosing
pairs by frequency and recording them, the other replaying the recorded list by rank. The dotted stages
are GPT-2's and are left out of the drill.

The contract the drill implements, as one class:

- \`BPETokenizer.train(text, vocab_size)\`: the corpus as UTF-8 bytes; while the vocabulary is smaller
  than \`vocab_size\`, count every adjacent pair, merge the most frequent everywhere (ties to the pair
  seen first), record it in \`merges\` and \`vocab[256 + rank] = vocab[a] + vocab[b]\`. Returns the
  corpus as ids after the last merge.
- \`encode(text)\`: bytes, then the lowest-ranked merge present, repeated until no adjacent pair has
  a rank.
- \`decode(ids)\`: \`b"".join(vocab[i] ...)\` decoded as UTF-8 with \`errors="replace"\`.
- \`save\`/\`load\`: the merge list as JSON; the vocabulary is rebuilt from it.

Everything else a real tokenizer has (pre-tokenization, special tokens, a fast implementation)
sits around this loop and leaves it unchanged.

# Why bytes

BPE comes from [Sennrich, Haddow and Birch (2016)](https://arxiv.org/abs/1508.07909), who adapted a
1994 compression algorithm so a translation model could handle words it had never seen by breaking
them into subword units. Their units were characters; GPT-2 made the base alphabet the **256 byte
values** instead. The choice fixes the one problem every vocabulary has: what to do with input that
is not in it.

| Base alphabet | Size | Unseen input | Cost |
| --- | --- | --- | --- |
| whole words | 100k–1M | \`<unk>\`: the word is lost | every typo, name and new coinage is \`<unk>\` |
| Unicode characters | ~150k that exist, thousands used | still \`<unk>\` for a character outside the alphabet | a sparse, mostly-untrained embedding table |
| **bytes** | **256** | **none**: any string is a byte sequence | rare scripts cost 2–4 tokens per character until merges cover them |

- \`str.encode("utf-8")\` is the only step from text to base ids, and \`bytes.decode\` the only one back:
  \`"é"\` is \`[195, 169]\`, \`"日"\` is three bytes, \`"🙂"\` four. There is nothing to look up and nothing
  to fail.
- Ids \`0..255\` are fixed before training starts; every learned token is \`256 + rank\` and stands for the
  concatenation of two existing tokens' bytes, so every token unfolds, merge by merge, into the single
  bytes it was built from.
- The model's embedding table has exactly \`vocab_size\` rows: 256 bytes plus the merges plus a few
  special tokens. GPT-2's 50,257 is 256 + 50,000 + 1.

:::quiz
Q: A byte-level tokenizer trained only on English text is given the string "日本語". What does encode return?
- [ ] An unknown-token id, because the characters were never seen
- [x] Nine ids, one per UTF-8 byte, since no merge covers those bytes
- [ ] An exception from str.encode
> Every string is a byte sequence, and every byte is in the base vocabulary. The text costs three tokens per character instead of one, but it is representable, round-trips exactly, and the model gets a chance to learn something about it.
:::

# Training: count, merge, record

Training is a loop with one decision per round. The corpus is a single list of ids; each round counts
the adjacent pairs across the whole list, picks the most frequent, and replaces every occurrence of
it with a new id:

\`\`\`python
ids = list(text.encode("utf-8"))
while len(vocab) < vocab_size:
    counts = Counter(zip(ids, ids[1:]))          # every adjacent pair, in corpus order
    pair = max(counts, key=counts.get)            # most frequent; ties → first seen
    new_id = 256 + len(merges)
    merges.append(pair)
    vocab[new_id] = vocab[pair[0]] + vocab[pair[1]]
    ids = merge(ids, pair, new_id)                # replace every (a, b) by new_id
\`\`\`

Do the first round by hand on Sennrich's corpus: \`low\` ×5, \`lower\` ×2, \`widest\` ×3, \`newest\` ×6,
joined by single spaces, 94 bytes. A pair inside a word occurs once per copy of the word; a pair
across a space (\`t␣\`, \`␣l\`) occurs once per gap:

| Pair | Where | Count |
| --- | --- | --- |
| \`e s\` | \`widest\` ×3 + \`newest\` ×6 | **9** |
| \`s t\` | \`widest\` ×3 + \`newest\` ×6 | **9** |
| \`w e\` | \`lower\` ×2 + \`newest\` ×6 | 8 |
| \`t ␣\` | every \`widest\` (3) + every \`newest\` but the last (5) | 8 |
| \`l o\`, \`o w\` | \`low\` ×5 + \`lower\` ×2 | 7 |

\`es\` and \`st\` tie at 9. In the first \`widest\`, \`e s\` is seen before \`s t\`, so \`es\` wins and becomes
id 256. Replacing all nine occurrences turns \`n e w e s t\` into \`n e w es t\` and shrinks the corpus
from 94 ids to 85. The next round counts again, on the new list:

| Round | Best pair | Count | New token | Corpus ids after | Why |
| --- | --- | --- | --- | --- | --- |
| 0 | \`(101, 115)\` = \`e s\` | 9 | \`256\` = \`b"es"\` | 85 | \`st\` also has 9; \`es\` is seen first |
| 1 | \`(256, 116)\` = \`es t\` | 9 | \`257\` = \`b"est"\` | 76 | the pair exists only because round 0 ran |
| 2 | \`(257, 32)\` = \`est ␣\` | 8 | \`258\` = \`b"est "\` | 68 | the last \`newest\` has no trailing space |
| 3 | \`(108, 111)\` = \`l o\` | 7 | \`259\` = \`b"lo"\` | 61 | ties with \`o w\`; \`l o\` is seen first |
| 4 | \`(259, 119)\` = \`lo w\` | 7 | \`260\` = \`b"low"\` | 54 | |
| … | | | | 12 after 17 merges | until \`vocab_size\` ids, or no pair occurs twice |

Step through the same loop one merge at a time on a small word corpus, with the pair counts, the
winning pair and the corpus re-tokenised after each round:

:::widget bpe-merges

Three properties of the loop matter more than its speed:

- **The merge list is ordered.** Round 1's pair contains id 256, which exists only because round 0
  ran. A merge is meaningful only after every merge before it. The rank *is* the information.
- **Ties are deterministic.** \`Counter\` preserves the order pairs were first seen and \`max\` returns the
  first maximum, so the same corpus always yields the same merge file. A tokenizer that could come
  out differently on a rerun would orphan every checkpoint trained with the first one.
- **Each merge is one step of compression.** Every occurrence of the pair becomes one id instead of
  two, so the corpus shrinks by the pair's count. Compression (bytes per token) grows with
  \`vocab_size\`, with diminishing returns as the pairs that remain get rarer. The drill stops when the
  best pair occurs once: a merge with support 1 memorises the corpus rather than describing it.

:::quiz
Q: Two engineers train a tokenizer on the same corpus to the same vocab_size, on different machines. The merge files differ in a few rows. What went wrong?
- [ ] Nothing; BPE is randomised and any merge order is equally good
- [x] A tie between equally frequent pairs was broken differently (by dict order, by sorting, by a hash), so from that round on the vocabularies diverged
- [ ] The corpus must have been read in a different encoding
> Every round after a tie sees a different corpus, so the files diverge from the first differently-broken tie onward. The tie-break must be a stated rule (the pair seen first, here), and the file, not the training code, is what ships with the model.
:::

# Encoding: replay the merges in rank order

Encoding new text does not count anything. It applies the learned merges, and the order it applies
them in decides whether the model sees the token sequences it was trained on. GPT-2's \`bpe()\` runs
this loop on each pre-token (on byte-mapped strings rather than ids):

\`\`\`python
ids = list(text.encode("utf-8"))
while len(ids) >= 2:
    pair = min(zip(ids, ids[1:]), key=lambda p: ranks.get(p, float("inf")))
    if pair not in ranks:
        break                                     # no adjacent pair was ever merged
    ids = merge(ids, pair, 256 + ranks[pair])
\`\`\`

Each round finds the adjacent pair with the **lowest rank** present and merges all of it. Why that
is the same as replaying the training rounds, and why it must be:

- After rank \`r\` is merged, no pair of rank lower than \`r\` can appear: every new pair contains the new
  id \`256 + r\`, and every pair of lower rank was built from ids that existed before it. So "lowest
  rank present, repeat" visits the ranks in increasing order, skipping the absent ones, which is
  exactly "apply merge 0 everywhere, then merge 1, then merge 2 …".
- On the training corpus itself, each round therefore produces the same id list the corresponding
  training round produced, and the loop ends at the same segmentation training ended at: the
  drill's \`encode(corpus) == train_ids\`.
- On new text the same holds locally: wherever the text contains a byte pattern the corpus had, it is
  tokenised the way the corpus was, so the embedding the model learned for that id is the right one.

The tempting alternative is greedy longest match: scan from the left, take the longest token in the
vocabulary that matches here. It uses the same vocabulary and produces *different* ids. On \`" lowest"\`,
with the drill's 17 merges:

| Encoder | Tokens | Ids |
| --- | --- | --- |
| greedy longest match | \`b" lowe"\` \`b"s"\` \`b"t"\` | 269, 115, 116 |
| rank-ordered BPE | \`b" low"\` \`b"est"\` | 261, 257 |

The greedy output is a valid spelling of the same bytes, and \`decode\` returns the same string from
it. But the model never saw \`b" lowe"\` followed by \`b"s"\` and \`b"t"\`: in the corpus \`" lowe"\` only ever
begins \`" lower"\`. Its embeddings and its predictions for that sequence are untrained. The failure is
silent: nothing errors, perplexity is simply worse. The same holds for any scheme that merges by
frequency *in the input* rather than by rank: the only order that is a function of the model is the
training order.

| Encoder | Order | Matches training segmentation | Cost per word of length n |
| --- | --- | --- | --- |
| rank-ordered merge loop (GPT-2) | lowest rank present, repeat | yes | O(n × merges applied) |
| apply every merge once, in rank order | 0, 1, 2 … | yes, identical output | O(n × total merges) |
| greedy longest match | leftmost, longest | no | O(n × longest token) |

:::quiz
Q: encode is changed to apply merges in order of how often each pair occurs in the input string instead of by rank. On the training corpus it now returns a different id list than train did. Why?
- [x] A merge learned later may contain an id produced by an earlier one; applied out of rank order it never fires, or a lower-ranked pair is consumed first and the segmentation diverges
- [ ] Counting pairs in the input is slower, so it times out
- [ ] decode would return a different string
> Rank order is the only order the training segmentation is a function of. Any other order produces token sequences that are valid spellings of the bytes but that the model's embeddings were not trained on.
:::

# Decoding, and the bytes that are not a character

Decoding is concatenation: \`b"".join(vocab[i] for i in ids)\`, then UTF-8. The one subtlety is that a
token boundary is a byte boundary, not a character boundary. A merge can fuse the first byte of \`é\`
with the letter before it; the second byte then lives in another token. Decoding the whole sequence
is exact; decoding a prefix of it is not:

| ids | Bytes | \`decode\` | Why |
| --- | --- | --- | --- |
| all of \`encode("café")\` | \`63 61 66 c3 a9\` | \`café\` | every byte present, valid UTF-8 |
| the first token only, if it ends in \`c3\` | \`63 61 66 c3\` | \`caf\\ufffd\` | a lead byte with no continuation |
| \`[0x80]\` | \`80\` | \`\\ufffd\` | a continuation byte with no lead |

- \`bytes.decode("utf-8", errors="replace")\` turns each undecodable byte into U+FFFD instead of
  raising. A decoder that raises crashes the first time a model samples half a character, which it
  will, because the model samples ids, not characters.
- A streaming decoder (printing tokens as they arrive) keeps undecoded trailing bytes in a buffer
  and only emits complete characters; the replacement character is the batch-mode fallback.
- Round trips are exact in one direction: \`decode(encode(s)) == s\` for every string \`s\`, because the
  bytes are preserved. \`encode(decode(ids)) == ids\` holds when \`ids\` came from \`encode\` and the
  encoder is deterministic, not for an arbitrary list of ids that happens to spell the same bytes.

:::quiz
Q: A chat UI prints each token's decode(…) as it streams in. Users sometimes see a � that disappears when the next token arrives. What happened?
- [ ] The model produced an invalid id
- [x] The token ended in the middle of a multi-byte character; decoding that prefix alone replaced the incomplete bytes, and the next token completed the character
- [ ] The tokenizer's vocabulary has no entry for that character
> Tokens are byte strings. A boundary inside a character is normal and the full sequence decodes exactly; a streaming decoder buffers the incomplete tail until the character completes.
:::

# What production tokenizers add

The loop above is GPT-2's; what tiktoken, SentencePiece's BPE mode and the Hugging Face
[tokenizers](https://github.com/huggingface/tokenizers) library add is around it.

- **Pre-tokenization.** GPT-2's [encoder.py](https://github.com/openai/gpt-2/blob/master/src/encoder.py)
  splits text with a regex (contractions such as \`'s\` and \`'re\`, runs of letters with an optional
  leading space, runs of digits, runs of other symbols, whitespace) and runs BPE within each chunk. No
  merge crosses a chunk, so \`" the"\` is a token and \`"e th"\` never is; GPT-4's pattern caps digit runs
  at three. The drill merges across the whole corpus, which is why it learns \`b"est "\` with a trailing
  space and, at round 9, \`b"est newest new"\`: a phrase memorised across three words.
- **Special tokens.** \`<|endoftext|>\` and chat-template markers are matched as whole strings before
  BPE runs and get ids after the merges. User text must not be able to spell them.
- **The byte-to-unicode trick.** GPT-2 maps each byte to a printable Unicode character so its merge
  file is text. tiktoken drops it and stores each token's bytes (base64) with its rank, which is also
  its id; a pair's merge priority is the rank of the token it forms, the same order as the drill's
  \`merges\` index.
- **Speed.** Production trainers do not recount every round: Hugging Face \`tokenizers\` updates pair
  counts only where a merge happened, in Rust across threads. Encoders cache each pre-token's result,
  since the same words recur. [minbpe](https://github.com/karpathy/minbpe) is the readable Python
  version of exactly this drill, with the GPT-4 regex added.
- **Vocabulary size is a model hyperparameter.** More merges mean fewer tokens per document (a longer
  effective context and cheaper inference) and a larger embedding table and softmax. GPT-2 used
  50,257; GPT-4 ~100k; Llama 3 128k. The ratio of bytes per token on representative text is the
  number to watch, per language.

:::quiz
Q: Why does GPT-2 split text with a regex before running BPE on each piece?
- [ ] Because BPE cannot handle spaces
- [x] So merges never cross a word or category boundary: the vocabulary learns " the" and "ing" rather than fragments like "e th" that straddle two words
- [ ] To make training parallel
> Pre-tokenization bounds what a merge may span. Tokens then align with linguistic units, the vocabulary spends its budget on useful pieces, and encoding can be cached per word.
:::

# What to take away

- A byte-level BPE tokenizer is 256 fixed ids plus an **ordered list of merges**; the list is the
  model, and \`vocab\` is derived from it.
- Training is greedy: count adjacent pairs over the corpus, merge the most frequent, repeat. Ties
  must break by a stated rule or two trainings disagree.
- Encoding replays the merges **lowest rank first**. Any other order (greedy longest match, by
  frequency in the input) spells the same bytes with ids the model was not trained on, silently.
- Tokens are byte strings, so a boundary may fall inside a character: decode with
  \`errors="replace"\` in batch, buffer the tail when streaming.
- Production adds pre-tokenization, special tokens and a fast implementation around the same loop;
  the vocabulary size trades sequence length against embedding-table size.

Primary reference: Sennrich, Haddow and Birch,
[Neural Machine Translation of Rare Words with Subword Units](https://arxiv.org/abs/1508.07909) (ACL 2016).
`;
