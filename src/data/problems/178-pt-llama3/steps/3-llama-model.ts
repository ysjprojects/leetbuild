import type {Step} from '@/lib/types';

export const llamaModelStep: Step = {
  id: 'llama-model',
  title: 'The model, generation and 8,030,261,248 parameters',
  concept: 'pytorch',
  file: 'llama_model',
  focus: ['tokens', 'tok-emb', 'add1', 'add2', 'final-norm', 'output'],
  task: `## Task

Assemble Llama 3 in \`llama_model.py\` from the two earlier files (\`from llama_attention import Attention,
causal_mask\`, \`from llama_layers import FeedForward, RMSNorm, RopeScaling, ffn_hidden_dim, precompute_rope\`),
generate from it with and without the cache, and count its parameters without building it.

- \`ModelArgs\` (given): a \`@dataclass\` whose defaults are Llama 3.1 8B's \`params.json\`: \`dim=4096\`,
  \`n_layers=32\`, \`n_heads=32\`, \`n_kv_heads=8\`, \`vocab_size=128256\`, \`multiple_of=1024\`,
  \`ffn_dim_multiplier=1.3\`, \`norm_eps=1e-5\`, \`rope_theta=500000.0\`, \`use_scaled_rope=True\`, plus
  \`max_batch_size\` and \`max_seq_len\` for the cache.
- \`TransformerBlock(layer_id, args)\`: \`attention_norm\`, \`attention\`, \`ffn_norm\`, \`feed_forward\` (built with
  \`4 * args.dim\`), and two pre-norm residuals:
  \`h = x + self.attention(self.attention_norm(x), start_pos, freqs_cis, mask)\`, then
  \`h + self.feed_forward(self.ffn_norm(h))\`.
- \`Transformer(params)\`: \`tok_embeddings = nn.Embedding(vocab_size, dim)\`, \`layers\` (an \`nn.ModuleList\`),
  \`norm = RMSNorm(dim)\`, and an **untied** \`output = nn.Linear(dim, vocab_size, bias=False)\`; a
  non-persistent \`freqs_cis\` buffer from \`precompute_rope(dim // n_heads, 2 * max_seq_len, rope_theta, ...)\`,
  scaled when \`use_scaled_rope\`.
- \`@torch.inference_mode() forward(tokens, start_pos)\`: \`tokens\` is \`(bsz, seqlen)\` long at positions
  \`start_pos …\`. Assert \`bsz <= max_batch_size\` and \`start_pos + seqlen <= max_seq_len\`; embed; slice
  \`freqs_cis[start_pos : start_pos + seqlen]\`; \`mask = causal_mask(seqlen, start_pos, ...)\` when
  \`seqlen > 1\`, else \`None\`; every block; \`norm\`; \`output(h).float()\`: \`(bsz, seqlen, vocab_size)\` float32.
- \`sample_top_p(probs, p)\` (Meta's): \`torch.sort\` descending, \`torch.cumsum\`, zero every token whose
  mass **before** it already exceeds \`p\`, renormalise, \`torch.multinomial\`, and \`torch.gather\` back to
  vocabulary ids. Returns \`(B, 1)\`.
- \`@torch.inference_mode() generate(model, prompt, max_new_tokens, temperature=0.6, top_p=0.9,
  use_cache=True)\`: \`prev_pos = 0\`, then for \`cur_pos\` from \`T\` to \`T + max_new_tokens − 1\`:
  - with the cache, \`model(tokens[:, prev_pos:cur_pos], prev_pos)\` and \`prev_pos = cur_pos\`: the first pass
    is the prefill, every later one feeds one token;
  - without it, \`model(tokens[:, :cur_pos], 0)\`;
  - take the last row; \`temperature > 0\`: \`torch.softmax(logits / temperature)\` then \`sample_top_p\`;
    \`temperature == 0\`: \`argmax\`; append with \`torch.cat\`.
- \`num_params(args)\`: the count in closed form, with \`ffn_hidden_dim\`: two \`vocab_size × dim\` matrices,
  per layer \`wq\` and \`wo\` (\`dim × n_heads · head_dim\`), \`wk\` and \`wv\` (\`dim × n_kv_heads · head_dim\`), three
  SwiGLU matrices and two norm weights, plus the final norm. For \`ModelArgs()\`: **8,030,261,248**.

The self-test checks 8,030,261,248 for 8B and 70,553,706,496 for 70B without allocating them, then on a
2-layer config (\`dim=64\`, 4 heads, 2 KV heads, vocabulary 97): \`num_params\` equals \`sum(p.numel())\`, the
output is untied, a prefill plus one-token steps equals the full forward (1e-4), causality, cached greedy
generation equals uncached token for token (and sampling under one seed), top-p keeps \`{0, 2}\` of
\`[0.30, 0.05, 0.50, 0.15]\` at \`p = 0.6\` with the right shares, and the \`max_seq_len\` assertion. Then it
prints \`PASS\`.

> A decode step is the same \`forward\` as the prefill with \`seqlen = 1\` and \`start_pos = cur_pos\`: the
> positions come from \`start_pos\`, the keys from the cache, and nothing else changes.`,
  hints: [
    'The block is two lines in `forward`; the model loops `for layer in self.layers: h = layer(h, start_pos, freqs_cis, mask)`. `freqs_cis` must be a buffer (or moved in `forward`) so it follows the model to the GPU; `register_buffer(..., persistent=False)` keeps it out of `state_dict()`.',
    'Generation: `tokens[:, prev_pos:cur_pos]` is the whole prompt on the first iteration (`prev_pos = 0`, `cur_pos = T`) and one token afterwards. Both paths must draw exactly one sample per new token, from `logits[:, -1]`, so the same seed gives the same tokens.',
    'Parameter count for 8B: embeddings and output `2 · 128,256 · 4,096 = 1,050,673,152`; per layer `wq + wo = 2 · 4,096²`, `wk + wv = 2 · 4,096 · 1,024`, SwiGLU `3 · 4,096 · 14,336`, norms `2 · 4,096`: `218,112,000`; times 32 plus the final norm `4,096`.',
  ],
  checks: [
    {
      id: 'model-args',
      title: 'ModelArgs defaults to Llama 3 8B',
      detail:
        'A `@dataclass ModelArgs` with `vocab_size: int = 128256`, `n_kv_heads: int = 8` and `rope_theta: float = 500000.0`, the values of the 8B `params.json`.',
      match: {
        python: {
          all: [
            /@dataclass\s*\nclass ModelArgs/,
            /vocab_size:\s*int\s*=\s*128_?256/,
            /n_kv_heads:\s*int\s*=\s*8\b/,
            /rope_theta:\s*float\s*=\s*500_?000/,
          ],
        },
      },
    },
    {
      id: 'pre-norm-block',
      title: 'Pre-norm block with two residuals',
      detail:
        '`h = x + self.attention(self.attention_norm(x), ...)` then `out = h + self.feed_forward(self.ffn_norm(h))`: RMSNorm on each branch, the residual stream itself never normalised.',
      match: {
        python: {
          all: [
            /=\s*x\s*\+\s*self\.attention\(\s*self\.attention_norm\(\s*x\s*\)/,
            /h\s*\+\s*self\.feed_forward\(\s*self\.ffn_norm\(\s*h\s*\)\s*\)/,
          ],
        },
      },
    },
    {
      id: 'untied-output',
      title: 'Final RMSNorm and an untied output layer',
      detail:
        '`self.norm = RMSNorm(dim, ...)` and `self.output = nn.Linear(dim, vocab_size, bias=False)` with its own weight: Llama 3 8B does not tie it to `tok_embeddings` (525 M more parameters).',
      match: {
        python: {
          all: [
            /self\.norm\s*=\s*RMSNorm\(/,
            /self\.output\s*=\s*nn\.Linear\(\s*\w+\.dim\s*,\s*\w+\.vocab_size\s*,\s*bias\s*=\s*False/,
          ],
          none: [
            /self\.output\.weight\s*=\s*self\.tok_embeddings\.weight/,
            /self\.tok_embeddings\.weight\s*=\s*self\.output\.weight/,
          ],
        },
      },
    },
    {
      id: 'positions-from-start-pos',
      title: 'RoPE rows and mask follow start_pos',
      detail:
        '`freqs_cis[start_pos : start_pos + seqlen]` and `causal_mask(seqlen, start_pos, ...)`: a decode token at position 40 is rotated by 40, not 0, and sees all 41 keys.',
      match: {
        python: {
          all: [/freqs_cis\[\s*start_pos\s*:\s*start_pos\s*\+\s*seqlen\s*\]/, /causal_mask\(\s*seqlen\s*,\s*start_pos/],
        },
      },
    },
    {
      id: 'cached-decode',
      title: 'Prefill once, then one token per forward',
      detail:
        'With the cache, `model(tokens[:, prev_pos:cur_pos], prev_pos)` and then `prev_pos = cur_pos`: the prompt once, then only the newest token. Without it, the whole prefix from position 0.',
      match: {
        python: {
          all: [/\[\s*:\s*,\s*prev_pos\s*:\s*cur_pos\s*\]/, /prev_pos\s*=\s*cur_pos/, /\[\s*:\s*,\s*:\s*cur_pos\s*\]/],
        },
      },
    },
    {
      id: 'top-p',
      title: 'Temperature, then nucleus sampling',
      detail:
        'Logits divided by `temperature`, a softmax, then `torch.sort(..., descending=True)`, `torch.cumsum`, the tail zeroed and renormalised, `torch.multinomial` and `torch.gather` back to token ids.',
      match: {
        python: {
          all: [
            /\/\s*temperature/,
            /torch\.sort\([^\n]*descending\s*=\s*True/,
            /torch\.cumsum\(/,
            /torch\.multinomial\(/,
            /\.gather\(/,
          ],
        },
      },
    },
    {
      id: 'num-params',
      title: 'Parameter count in closed form',
      detail:
        '`num_params(args)` uses `ffn_hidden_dim` and the `args` fields only (embeddings, output, `wq`/`wo`, `wk`/`wv` at `n_kv_heads`, SwiGLU, norms): 8,030,261,248 for the 8B config without allocating 32 GB.',
      match: {
        python: {
          all: [
            /ffn_hidden_dim\(/,
            /args\.vocab_size\s*\*\s*args\.dim|args\.dim\s*\*\s*args\.vocab_size/,
            /args\.n_kv_heads\s*\*|\*\s*args\.n_kv_heads/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Llama 3 end to end as Meta's reference model.py writes it: ModelArgs, the pre-norm block, the Transformer
with an untied output layer, generation with a prefill and cached decode steps, and the parameter count."""

from dataclasses import dataclass

import torch
import torch.nn as nn

from llama_attention import Attention, causal_mask
from llama_layers import FeedForward, RMSNorm, RopeScaling, ffn_hidden_dim, precompute_rope


@dataclass
class ModelArgs:
    """Defaults: Llama 3.1 8B's params.json."""

    dim: int = 4096
    n_layers: int = 32
    n_heads: int = 32
    n_kv_heads: int = 8
    vocab_size: int = 128256
    multiple_of: int = 1024
    ffn_dim_multiplier: float | None = 1.3
    norm_eps: float = 1e-5
    rope_theta: float = 500000.0
    use_scaled_rope: bool = True
    max_batch_size: int = 4
    max_seq_len: int = 2048


class TransformerBlock(nn.Module):
    def __init__(self, layer_id: int, args: ModelArgs):
        super().__init__()
        self.layer_id = layer_id
        raise NotImplementedError("TODO: attention_norm, attention, ffn_norm, feed_forward (hidden_dim = 4 * dim)")

    def forward(
        self, x: torch.Tensor, start_pos: int, freqs_cis: torch.Tensor, mask: torch.Tensor | None
    ) -> torch.Tensor:
        raise NotImplementedError("TODO: two pre-norm residuals, attention then feed-forward")


class Transformer(nn.Module):
    def __init__(self, params: ModelArgs):
        super().__init__()
        self.params = params
        # TODO: tok_embeddings, n_layers blocks, the final norm, an untied output Linear, and a
        # non-persistent freqs_cis buffer for 2 * max_seq_len positions (scaled when use_scaled_rope).
        raise NotImplementedError("TODO: the model")

    @torch.inference_mode()
    def forward(self, tokens: torch.Tensor, start_pos: int) -> torch.Tensor:
        """tokens (B, seqlen) at positions start_pos … start_pos + seqlen - 1 -> float32 logits (B, seqlen, vocab)."""
        raise NotImplementedError("TODO: bounds, embed, freqs and mask at start_pos, blocks, norm, output")


def sample_top_p(probs: torch.Tensor, p: float) -> torch.Tensor:
    """probs (B, V) -> (B, 1): sample from the smallest head of the sorted distribution whose mass reaches p."""
    raise NotImplementedError("TODO: sort, cumulative mass, zero the tail, renormalise, multinomial, map back")


@torch.inference_mode()
def generate(
    model: Transformer,
    prompt: torch.Tensor,
    max_new_tokens: int,
    temperature: float = 0.6,
    top_p: float = 0.9,
    use_cache: bool = True,
) -> torch.Tensor:
    """prompt (B, T) -> (B, T + max_new_tokens). temperature 0 is greedy."""
    # TODO: for cur_pos in range(T, T + max_new_tokens): with the cache feed tokens[:, prev_pos:cur_pos]
    # at prev_pos (the prefill, then one token), without it the whole prefix at 0; last row; sample; append.
    raise NotImplementedError("TODO: the decode loop")


def num_params(args: ModelArgs) -> int:
    """Every parameter, in closed form, without building the model."""
    raise NotImplementedError("TODO: embeddings, output, per-layer attention + SwiGLU + two norms, final norm")


if __name__ == "__main__":
    torch.manual_seed(0)

    # Llama 3 8B and 70B in closed form: nothing is allocated.
    assert num_params(ModelArgs()) == 8_030_261_248, num_params(ModelArgs())
    big = ModelArgs(dim=8192, n_layers=80, n_heads=64, n_kv_heads=8, multiple_of=4096)
    assert num_params(big) == 70_553_706_496, num_params(big)

    args = ModelArgs(
        dim=64, n_layers=2, n_heads=4, n_kv_heads=2, vocab_size=97, multiple_of=32, ffn_dim_multiplier=None,
        max_batch_size=2, max_seq_len=32,
    )
    model = Transformer(args).eval()
    assert num_params(args) == sum(p.numel() for p in model.parameters()), "closed form = what the model holds"
    assert model.output.weight is not model.tok_embeddings.weight, "Llama 3's output layer is untied"
    assert model.freqs_cis.shape == (2 * args.max_seq_len, args.dim // args.n_heads // 2)
    block = model.layers[0]
    assert block.attention.cache_k.shape == (2, 32, 2, 16) and block.feed_forward.w1.weight.shape == (192, 64)

    # The full forward against a prefill plus one-token decode steps.
    tokens = torch.randint(args.vocab_size, (2, 12))
    full = model(tokens, 0)
    assert full.shape == (2, 12, args.vocab_size) and full.dtype == torch.float32
    parts = [model(tokens[:, :5], 0)] + [model(tokens[:, t : t + 1], t) for t in range(5, 12)]
    assert torch.allclose(torch.cat(parts, dim=1), full, atol=1e-4), (torch.cat(parts, dim=1) - full).abs().max()

    # Causality: changing the last token moves only the last position's logits.
    other = tokens.clone()
    other[:, -1] = (other[:, -1] + 1) % args.vocab_size
    moved = model(other, 0)
    assert torch.allclose(moved[:, :-1], full[:, :-1], atol=1e-5) and not torch.allclose(moved[:, -1], full[:, -1])

    # Cached greedy generation equals uncached, token for token; so does sampling under one seed.
    prompt = torch.randint(args.vocab_size, (2, 6))
    cached = generate(model, prompt, 20, temperature=0.0)
    uncached = generate(model, prompt, 20, temperature=0.0, use_cache=False)
    assert cached.shape == (2, 26) and torch.equal(cached[:, :6], prompt)
    assert torch.equal(cached, uncached), (cached, uncached)
    torch.manual_seed(7)
    sampled = generate(model, prompt, 20, temperature=1.0, top_p=0.9)
    torch.manual_seed(7)
    assert torch.equal(sampled, generate(model, prompt, 20, temperature=1.0, top_p=0.9, use_cache=False))

    # Top-p keeps the smallest head whose mass reaches p: tokens 2 and 0 for p = 0.6, token 2 alone for p = 0.1.
    probs = torch.tensor([[0.30, 0.05, 0.50, 0.15]]).repeat(4000, 1)
    drawn = sample_top_p(probs.clone(), 0.6).flatten()
    assert set(drawn.tolist()) == {0, 2}
    share = (drawn == 2).float().mean().item()
    assert abs(share - 0.5 / 0.8) < 0.03, share
    assert set(sample_top_p(probs.clone(), 0.1).flatten().tolist()) == {2}

    # The cache has max_seq_len rows: a longer request is a programming error.
    try:
        model(torch.zeros(1, 33, dtype=torch.long), 0)
        raise SystemExit("expected an AssertionError past max_seq_len")
    except AssertionError:
        pass
    print("PASS")
`,
      solution: `"""Llama 3 end to end as Meta's reference model.py writes it: ModelArgs, the pre-norm block, the Transformer
with an untied output layer, generation with a prefill and cached decode steps, and the parameter count."""

from dataclasses import dataclass

import torch
import torch.nn as nn

from llama_attention import Attention, causal_mask
from llama_layers import FeedForward, RMSNorm, RopeScaling, ffn_hidden_dim, precompute_rope


@dataclass
class ModelArgs:
    """Defaults: Llama 3.1 8B's params.json."""

    dim: int = 4096
    n_layers: int = 32
    n_heads: int = 32
    n_kv_heads: int = 8
    vocab_size: int = 128256
    multiple_of: int = 1024
    ffn_dim_multiplier: float | None = 1.3
    norm_eps: float = 1e-5
    rope_theta: float = 500000.0
    use_scaled_rope: bool = True
    max_batch_size: int = 4
    max_seq_len: int = 2048


class TransformerBlock(nn.Module):
    def __init__(self, layer_id: int, args: ModelArgs):
        super().__init__()
        self.layer_id = layer_id
        self.attention_norm = RMSNorm(args.dim, eps=args.norm_eps)
        self.attention = Attention(args.dim, args.n_heads, args.n_kv_heads, args.max_batch_size, args.max_seq_len)
        self.ffn_norm = RMSNorm(args.dim, eps=args.norm_eps)
        self.feed_forward = FeedForward(args.dim, 4 * args.dim, args.multiple_of, args.ffn_dim_multiplier)

    def forward(
        self, x: torch.Tensor, start_pos: int, freqs_cis: torch.Tensor, mask: torch.Tensor | None
    ) -> torch.Tensor:
        h = x + self.attention(self.attention_norm(x), start_pos, freqs_cis, mask)
        return h + self.feed_forward(self.ffn_norm(h))


class Transformer(nn.Module):
    def __init__(self, params: ModelArgs):
        super().__init__()
        self.params = params
        self.tok_embeddings = nn.Embedding(params.vocab_size, params.dim)
        self.layers = nn.ModuleList(TransformerBlock(i, params) for i in range(params.n_layers))
        self.norm = RMSNorm(params.dim, eps=params.norm_eps)
        # Untied: Llama 3 8B's output layer is its own 128,256 x 4,096 matrix.
        self.output = nn.Linear(params.dim, params.vocab_size, bias=False)
        scaling = RopeScaling() if params.use_scaled_rope else None
        freqs_cis = precompute_rope(params.dim // params.n_heads, params.max_seq_len * 2, params.rope_theta, scaling)
        self.register_buffer("freqs_cis", freqs_cis, persistent=False)

    @torch.inference_mode()
    def forward(self, tokens: torch.Tensor, start_pos: int) -> torch.Tensor:
        """tokens (B, seqlen) at positions start_pos … start_pos + seqlen - 1 -> float32 logits (B, seqlen, vocab)."""
        bsz, seqlen = tokens.shape
        assert bsz <= self.params.max_batch_size and start_pos + seqlen <= self.params.max_seq_len
        h = self.tok_embeddings(tokens)
        freqs_cis = self.freqs_cis[start_pos : start_pos + seqlen]
        mask = None
        if seqlen > 1:
            mask = causal_mask(seqlen, start_pos, device=tokens.device).type_as(h)
        for layer in self.layers:
            h = layer(h, start_pos, freqs_cis, mask)
        h = self.norm(h)
        return self.output(h).float()


def sample_top_p(probs: torch.Tensor, p: float) -> torch.Tensor:
    """probs (B, V) -> (B, 1): sample from the smallest head of the sorted distribution whose mass reaches p."""
    probs_sort, probs_idx = torch.sort(probs, dim=-1, descending=True)
    probs_sum = torch.cumsum(probs_sort, dim=-1)
    mask = probs_sum - probs_sort > p  # the mass before a token already exceeds p: drop it
    probs_sort[mask] = 0.0
    probs_sort.div_(probs_sort.sum(dim=-1, keepdim=True))
    next_token = torch.multinomial(probs_sort, num_samples=1)
    return torch.gather(probs_idx, -1, next_token)


@torch.inference_mode()
def generate(
    model: Transformer,
    prompt: torch.Tensor,
    max_new_tokens: int,
    temperature: float = 0.6,
    top_p: float = 0.9,
    use_cache: bool = True,
) -> torch.Tensor:
    """prompt (B, T) -> (B, T + max_new_tokens). temperature 0 is greedy."""
    bsz, prompt_len = prompt.shape
    assert prompt_len + max_new_tokens <= model.params.max_seq_len
    tokens = prompt
    prev_pos = 0
    for cur_pos in range(prompt_len, prompt_len + max_new_tokens):
        if use_cache:
            # The first pass is the prefill (the whole prompt); every later pass feeds one token.
            logits = model(tokens[:, prev_pos:cur_pos], prev_pos)
            prev_pos = cur_pos
        else:
            logits = model(tokens[:, :cur_pos], 0)
        if temperature > 0:
            probs = torch.softmax(logits[:, -1] / temperature, dim=-1)
            next_token = sample_top_p(probs, top_p)
        else:
            next_token = torch.argmax(logits[:, -1], dim=-1, keepdim=True)
        tokens = torch.cat([tokens, next_token], dim=1)
    return tokens


def num_params(args: ModelArgs) -> int:
    """Every parameter, in closed form, without building the model."""
    head_dim = args.dim // args.n_heads
    hidden = ffn_hidden_dim(4 * args.dim, args.multiple_of, args.ffn_dim_multiplier)
    attention = args.dim * args.n_heads * head_dim * 2 + args.dim * args.n_kv_heads * head_dim * 2  # wq, wo, wk, wv
    feed_forward = 3 * args.dim * hidden  # w1, w2, w3
    norms = 2 * args.dim
    embeddings = 2 * args.vocab_size * args.dim  # tok_embeddings and the untied output
    return embeddings + args.n_layers * (attention + feed_forward + norms) + args.dim


if __name__ == "__main__":
    torch.manual_seed(0)

    # Llama 3 8B and 70B in closed form: nothing is allocated.
    assert num_params(ModelArgs()) == 8_030_261_248, num_params(ModelArgs())
    big = ModelArgs(dim=8192, n_layers=80, n_heads=64, n_kv_heads=8, multiple_of=4096)
    assert num_params(big) == 70_553_706_496, num_params(big)

    args = ModelArgs(
        dim=64, n_layers=2, n_heads=4, n_kv_heads=2, vocab_size=97, multiple_of=32, ffn_dim_multiplier=None,
        max_batch_size=2, max_seq_len=32,
    )
    model = Transformer(args).eval()
    assert num_params(args) == sum(p.numel() for p in model.parameters()), "closed form = what the model holds"
    assert model.output.weight is not model.tok_embeddings.weight, "Llama 3's output layer is untied"
    assert model.freqs_cis.shape == (2 * args.max_seq_len, args.dim // args.n_heads // 2)
    block = model.layers[0]
    assert block.attention.cache_k.shape == (2, 32, 2, 16) and block.feed_forward.w1.weight.shape == (192, 64)

    # The full forward against a prefill plus one-token decode steps.
    tokens = torch.randint(args.vocab_size, (2, 12))
    full = model(tokens, 0)
    assert full.shape == (2, 12, args.vocab_size) and full.dtype == torch.float32
    parts = [model(tokens[:, :5], 0)] + [model(tokens[:, t : t + 1], t) for t in range(5, 12)]
    assert torch.allclose(torch.cat(parts, dim=1), full, atol=1e-4), (torch.cat(parts, dim=1) - full).abs().max()

    # Causality: changing the last token moves only the last position's logits.
    other = tokens.clone()
    other[:, -1] = (other[:, -1] + 1) % args.vocab_size
    moved = model(other, 0)
    assert torch.allclose(moved[:, :-1], full[:, :-1], atol=1e-5) and not torch.allclose(moved[:, -1], full[:, -1])

    # Cached greedy generation equals uncached, token for token; so does sampling under one seed.
    prompt = torch.randint(args.vocab_size, (2, 6))
    cached = generate(model, prompt, 20, temperature=0.0)
    uncached = generate(model, prompt, 20, temperature=0.0, use_cache=False)
    assert cached.shape == (2, 26) and torch.equal(cached[:, :6], prompt)
    assert torch.equal(cached, uncached), (cached, uncached)
    torch.manual_seed(7)
    sampled = generate(model, prompt, 20, temperature=1.0, top_p=0.9)
    torch.manual_seed(7)
    assert torch.equal(sampled, generate(model, prompt, 20, temperature=1.0, top_p=0.9, use_cache=False))

    # Top-p keeps the smallest head whose mass reaches p: tokens 2 and 0 for p = 0.6, token 2 alone for p = 0.1.
    probs = torch.tensor([[0.30, 0.05, 0.50, 0.15]]).repeat(4000, 1)
    drawn = sample_top_p(probs.clone(), 0.6).flatten()
    assert set(drawn.tolist()) == {0, 2}
    share = (drawn == 2).float().mean().item()
    assert abs(share - 0.5 / 0.8) < 0.03, share
    assert set(sample_top_p(probs.clone(), 0.1).flatten().tolist()) == {2}

    # The cache has max_seq_len rows: a longer request is a programming error.
    try:
        model(torch.zeros(1, 33, dtype=torch.long), 0)
        raise SystemExit("expected an AssertionError past max_seq_len")
    except AssertionError:
        pass
    print("PASS")
`,
    },
  },
  debrief: `Llama 3's model is GPT-2's skeleton with every part swapped: RMSNorm for LayerNorm, RoPE for a learned
position table, SwiGLU for GELU, GQA for MHA, no biases anywhere, and an untied output layer. The
untied head costs 525 M parameters at 8B because the 128,256-token vocabulary is 2.5 times GPT-2's;
Meta ties it only in the Llama 3.2 1B and 3B models, where a separate one would add 263 M parameters
to the 1B model's 1.24 B.

The count shows where 8B goes: 1.05 B in the two vocabulary matrices, 1.34 B in attention and 5.64 B in
the SwiGLU layers (70 % of the total). GQA saves twice: \`wk\` and \`wv\` are a quarter the size of \`wq\`,
and so is the cache they fill.

**Generation** is Meta's loop without the tokenizer: one \`forward\` for the prompt, one per token, the
same function both times. The reference handles ragged batches by padding prompts to the longest and
masking which positions are prompt, stops on \`<|eot_id|>\`, and runs in bf16 across GPUs with
fairscale. Serving engines go further: vLLM pages the cache and schedules many sequences per step,
and speculative decoding verifies several drafted tokens in one forward of this same model.`,
};
