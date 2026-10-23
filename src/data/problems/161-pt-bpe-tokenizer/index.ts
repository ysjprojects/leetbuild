import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {bpeStep} from './steps/1-bpe';

/**
 * Drill: the byte-level BPE tokenizer every GPT reads through: 256 byte tokens, a merge list
 * learned by repeatedly fusing the most frequent adjacent pair of the corpus, an encoder that
 * replays those merges in rank order, and a decoder that never raises on a split character.
 */
export const ptBpeTokenizerProblem: Problem = {
  id: 'pt-bpe-tokenizer',
  title: 'Byte-pair encoding: train the merges, encode, decode',
  tagline:
    'Count adjacent byte pairs, merge the most frequent, repeat; encode by replaying the merges in rank order; decode bytes that may not be a whole character.',
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 45,
  statement: `# Byte-pair encoding: train the merges, encode, decode

A language model never sees text. It sees integers (token ids), and the first thing in front of
every language model is the function that turns a string into them and back. Since GPT-2, that
function is **byte-level byte-pair encoding** for the GPT family, Llama 3 and many others: the base
vocabulary is the 256 byte values, so any string in any script is encodable with nothing out of
vocabulary, and on top of it sits a list of **merges** learned from a corpus ("these two adjacent
tokens occur together so often that they get an id of their own"). GPT-2 learned 50,000 of them; its
embedding table has exactly one row per byte, one per merge and one per special token (50,257).

The algorithm is older than transformers: Sennrich, Haddow and Birch (2016) borrowed it from a 1994
compression scheme to give neural translation an open vocabulary. Training is a loop: count every
adjacent pair across the corpus, merge the most frequent one everywhere, record it, repeat until the
vocabulary is the size you want. Encoding new text replays those merges **in the order they were
learned**, because that order is the only one that reproduces the segmentation the model was trained
on. Decoding concatenates the tokens' bytes and decodes UTF-8, with care, because a token boundary
may fall inside a multi-byte character.

The surface is one class, pure Python, no tensors:

\`\`\`python
class BPETokenizer:
    merges: list[tuple[int, int]]        # rank r merged merges[r] into id 256 + r
    vocab: dict[int, bytes]              # id → the bytes it stands for; 0..255 are the bytes themselves
    def train(self, text: str, vocab_size: int) -> list[int]
    def encode(self, text: str) -> list[int]
    def decode(self, ids: list[int]) -> str
    def save(self, path: str) -> None
    @classmethod
    def load(cls, path: str) -> "BPETokenizer"
\`\`\`

## What you build here

1. \`BPETokenizer\`: \`train\` counts adjacent pairs over the whole corpus with a \`Counter\`, merges the
   most frequent (ties to the pair seen first), assigns it id \`256 + rank\` and \`vocab[id] = vocab[a] + vocab[b]\`,
   and repeats until \`len(vocab) == vocab_size\`; \`encode\` turns text into UTF-8 bytes and applies the
   lowest-ranked merge present until none is; \`decode\` joins the bytes and decodes with
   \`errors="replace"\`; \`save\`/\`load\` persist the merge list as JSON and rebuild the vocab from it.

## Run it on your machine

\`\`\`bash
python bpe.py
\`\`\`

A passing run prints one line of statistics (the number of merges learned on the self-test corpus,
the first two merged tokens \`b'es'\` and \`b'est'\`, and the bytes-per-token ratio at three vocabulary
sizes) followed by \`PASS\`, in well under a second. The starter stops at the first \`NotImplementedError\`.

## Left out on purpose

The regex pre-tokenization GPT-2 applies before merging (so merges never cross a word boundary or
fuse a letter to a space on the wrong side), special tokens (\`<|endoftext|>\`), the cached
byte-to-unicode mapping GPT-2 uses to keep its merge file printable, and the incremental pair-count
updates and multi-threading that make training on gigabytes tractable. The loop, the ranks and the
byte fallback are the same.`,
  figures: [
    {
      title: 'Byte-level BPE',
      architecture: {
        input: 'low ×5 · lower ×2 · widest ×3 · newest ×6',
        output: 'decode(encode(s)) == s',
        items: [
          {
            id: 'text',
            label: 'Text',
            kind: 'io',
            sub: 'str · any script',
            detail:
              'The self-test corpus is Sennrich’s: `low` ×5, `lower` ×2, `widest` ×3, `newest` ×6, joined by spaces (94 bytes).',
          },
          {
            tone: 'dotted',
            label: 'GPT-2 only · left out here',
            items: [
              {
                id: 'regex',
                label: 'Pre-tokenizer regex',
                sub: "'s|'t|…| ?\\p{L}+| ?\\p{N}+|…",
                detail:
                  'GPT-2’s `encoder.py` splits the string into chunks (contractions, letters with their leading space, digits, punctuation) and runs BPE inside each, so no merge crosses a word boundary. The drill merges across the whole corpus.',
              },
            ],
          },
          {
            id: 'utf8',
            label: 'UTF-8 bytes',
            kind: 'embed',
            sub: 'list(text.encode("utf-8"))',
            shape: 'list[int] in 0..255',
            detail:
              'The base vocabulary: `vocab = {i: bytes([i]) for i in range(256)}`. `"é"` is two ids, `"日"` three, `"🙂"` four; nothing is ever out of vocabulary.',
          },
          {
            tone: 'dotted',
            label: 'GPT-2 only · left out here',
            items: [
              {
                id: 'byte-map',
                label: 'byte → unicode map',
                sub: 'bytes_to_unicode() · 256 chars',
                detail:
                  'A fixed bijection from each byte to a printable character, so GPT-2’s merge file is plain text. It changes nothing about which merges happen; tiktoken drops it and stores byte strings.',
              },
            ],
          },
          {
            columns: [
              [
                {
                  tone: 'block',
                  repeat: 'vocab_size − 256 ×',
                  label: 'train: one merge',
                  items: [
                    {
                      id: 'count',
                      label: 'Count adjacent pairs',
                      sub: 'Counter(zip(ids, ids[1:]))',
                      detail: 'Every adjacent pair across the whole corpus, in the order first seen.',
                    },
                    {
                      id: 'pick',
                      label: 'Most frequent pair',
                      sub: 'max · ties to the first seen',
                      detail:
                        '`max(counts, key=counts.get)` returns the first maximum, so the same corpus always yields the same merge file. Training stops early when the best pair occurs fewer than twice.',
                    },
                    {
                      id: 'record',
                      label: 'Record the merge',
                      sub: 'merges[r] · vocab[256 + r]',
                      detail:
                        '`vocab[256 + r] = vocab[a] + vocab[b]`: every learned token is the bytes of two older ones.',
                    },
                    {
                      id: 'replace',
                      label: 'Replace every occurrence',
                      sub: '_merge(ids, pair, 256 + r)',
                      detail: 'Left to right, non-overlapping: the corpus shrinks by the pair’s count.',
                    },
                  ],
                },
              ],
              [
                {
                  tone: 'block',
                  repeat: 'until no rank ×',
                  label: 'encode: one merge',
                  items: [
                    {
                      id: 'lowest',
                      label: 'Lowest-ranked pair',
                      sub: 'min(pairs, key=ranks.get)',
                      detail:
                        'Unranked pairs key to `float("inf")`; when the winner has no rank, encoding is done. Lowest rank first replays the training rounds in order.',
                    },
                    {
                      id: 'apply',
                      label: 'Merge it everywhere',
                      sub: '_merge(ids, pair, 256 + rank)',
                      detail: 'The same helper as training: on the corpus, `encode` ends at exactly `train`’s ids.',
                    },
                  ],
                },
              ],
            ],
          },
          {
            id: 'ids',
            label: 'Token ids',
            kind: 'io',
            sub: 'list[int] · each < vocab_size',
            detail:
              'What the model reads: one embedding row per id. `train` returns the corpus’s ids after its last merge; `encode(corpus)` must return the same list.',
          },
          {
            tone: 'dotted',
            label: 'decode(ids)',
            items: [
              {
                id: 'lookup',
                label: 'Join the tokens’ bytes',
                sub: 'b"".join(vocab[i] for i in ids)',
                detail: 'Exact: the bytes are preserved, so `decode(encode(s)) == s` for every string.',
              },
              {
                id: 'utf8-decode',
                label: 'UTF-8 decode',
                sub: '.decode("utf-8", errors="replace")',
                detail:
                  'A token boundary can fall inside a multi-byte character; `errors="replace"` turns the orphaned bytes into U+FFFD instead of raising. `decode([0x80])` is `"\\ufffd"`.',
              },
            ],
          },
          {
            id: 'text-out',
            label: 'Text',
            kind: 'io',
            sub: 'str · U+FFFD for a split char',
            detail:
              'The original string whenever the ids came from `encode`; a replacement character where a token boundary cut a multi-byte character.',
          },
        ],
        notes: [
          {at: 'utf8', text: '**256** base tokens, nothing out of vocabulary'},
          {at: 'pick', text: 'First merge **b"es"**, seen **9** times', side: 'left'},
          {at: 'lowest', text: '**Lowest rank** first, as trained'},
          {at: 'ids', text: 'Corpus: **94** bytes → **12** ids at 17 merges'},
          {at: 'utf8-decode', text: 'A split character decodes to **U+FFFD**'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Neural Machine Translation of Rare Words with Subword Units',
      url: 'https://arxiv.org/abs/1508.07909',
      by: 'Rico Sennrich, Barry Haddow and Alexandra Birch',
      date: '2015-08-31',
      venue: 'ACL 2016',
      takes:
        'The training loop `train` runs: count every adjacent pair, merge the most frequent everywhere, record the merge, repeat to the vocabulary size.',
    },
    {
      kind: 'paper',
      title: 'Language Models are Unsupervised Multitask Learners',
      url: 'https://cdn.openai.com/better-language-models/language_models_are_unsupervised_multitask_learners.pdf',
      by: 'Alec Radford et al.',
      date: '2019-02-14',
      venue: 'OpenAI technical report',
      takes:
        'Byte-level BPE (section 2.2): a base vocabulary of the 256 byte values, so any string encodes with nothing out of vocabulary.',
    },
    {
      kind: 'code',
      title: 'minbpe',
      url: 'https://github.com/karpathy/minbpe',
      by: 'Andrej Karpathy',
      date: '2024-02-16',
      venue: 'GitHub',
      takes:
        'The `BPETokenizer` surface in miniature: merges as ids `256 + rank`, `vocab[id] = vocab[a] + vocab[b]`, encode by applying the lowest-ranked pair present, save and load.',
    },
    {
      kind: 'code',
      title: 'gpt-2',
      url: 'https://github.com/openai/gpt-2',
      by: 'OpenAI',
      date: '2019-02-11',
      venue: 'GitHub',
      takes:
        "`src/encoder.py`: the production encoder that replays merges by rank (`bpe_ranks`) and decodes with `errors='replace'` when a token ends inside a UTF-8 character.",
    },
    {
      kind: 'docs',
      title: 'Tokenization algorithms',
      url: 'https://huggingface.co/docs/transformers/en/tokenizer_summary',
      venue: 'Hugging Face Transformers docs',
      takes:
        'Byte-level BPE set beside WordPiece, Unigram and SentencePiece: how each builds its vocabulary, and why GPT-2 needs no unknown token.',
    },
  ],
  steps: [bpeStep],
  learn,
};
