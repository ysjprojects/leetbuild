import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {bpeStep} from './steps/1-bpe';

/**
 * Drill: the byte-level BPE tokenizer every GPT reads through — 256 byte tokens, a merge list
 * learned by repeatedly fusing the most frequent adjacent pair of the corpus, an encoder that
 * replays those merges in rank order, and a decoder that never raises on a split character.
 */
export const ptBpeTokenizerProblem: Problem = {
  id: 'pt-bpe-tokenizer',
  title: 'Byte-pair encoding: train the merges, encode, decode',
  tagline:
    'Count adjacent byte pairs, merge the most frequent, repeat; encode by replaying the merges in rank order; decode bytes that may not be a whole character.',
  difficulty: 'medium',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 45,
  statement: `# Byte-pair encoding: train the merges, encode, decode

A language model never sees text. It sees integers — token ids — and the first thing in front of
every GPT, Llama and Claude is the function that turns a string into them and back. Since GPT-2 that
function is **byte-level byte-pair encoding**: the base vocabulary is the 256 byte values, so any
string in any script is encodable with nothing out of vocabulary, and on top of it sits a list of
**merges** learned from a corpus — "these two adjacent tokens occur together so often that they get
an id of their own". GPT-2 learned 50,000 of them; the embedding table of the model has exactly one
row per byte, one per merge and one per special token.

The algorithm is older than transformers: Sennrich, Haddow and Birch (2016) borrowed it from a 1994
compression scheme to give neural translation an open vocabulary. Training is a loop — count every
adjacent pair across the corpus, merge the most frequent one everywhere, record it, repeat until the
vocabulary is the size you want. Encoding new text replays those merges **in the order they were
learned**, because that order is the only one that reproduces the segmentation the model was trained
on. Decoding concatenates the tokens' bytes and decodes UTF-8 — with care, because a token boundary
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

A passing run prints one line of statistics — the number of merges learned on the self-test corpus,
the first two merged tokens (\`b'es'\`, \`b'est'\`) and the bytes-per-token ratio at three vocabulary
sizes — followed by \`PASS\`. The starter stops at the first \`NotImplementedError\`.

## Left out on purpose

The regex pre-tokenization GPT-2 applies before merging (so merges never cross a word boundary or
fuse a letter to a space on the wrong side), special tokens (\`<|endoftext|>\`), the cached
byte-to-unicode mapping GPT-2 uses to keep its merge file printable, and the incremental pair-count
updates and multi-threading that make training on gigabytes tractable. The loop, the ranks and the
byte fallback are the same.`,
  diagram: {
    nodes: [
      {id: 'text', kind: 'client', label: 'Text', sub: 'str → UTF-8 bytes (0..255)', x: 8, y: 50},
      {
        id: 'train',
        kind: 'service',
        label: 'train',
        sub: 'count pairs · merge the most frequent · repeat',
        x: 32,
        y: 22,
      },
      {id: 'merges', kind: 'db', label: 'merges · vocab', sub: 'rank r → id 256 + r · id → bytes', x: 56, y: 50},
      {id: 'codec', kind: 'service', label: 'encode · decode', sub: 'lowest rank first · bytes → str', x: 32, y: 78},
      {id: 'model', kind: 'external', label: 'Language model', sub: 'embedding row per id', x: 84, y: 78},
    ],
    edges: [
      {from: 'text', to: 'train', kind: 'plain', label: 'corpus bytes'},
      {from: 'train', to: 'merges', kind: 'plain', label: 'append (a, b) · vocab[256 + r]'},
      {from: 'text', to: 'codec', kind: 'plain', label: 'encode(text)'},
      {from: 'merges', to: 'codec', kind: 'plain', label: 'ranks · vocab'},
      {from: 'codec', to: 'model', kind: 'plain', label: 'ids'},
    ],
  },
  steps: [bpeStep],
  learn,
};
