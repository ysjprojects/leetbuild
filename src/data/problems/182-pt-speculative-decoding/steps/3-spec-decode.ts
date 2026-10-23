import type {Step} from '@/lib/types';

export const specDecodeStep: Step = {
  id: 'spec-decode',
  title: 'The speculative loop: one target pass per round',
  concept: 'pytorch',
  file: 'spec_decode',
  focus: ['target-pass', 'rollback', 'tcache-before', 'tcache-scored', 'tcache-rolled', 'dcache-rolled'],
  task: `## Task

Put steps 1 and 2 together into a decoder that calls the target once per **round** instead of once per
token, and still produces the target's own output (\`from spec_draft import …\`, \`from spec_verify import
verify\`). No \`transformers\`, no \`assistant_model\`.

- \`SpecStats\` (dataclass): \`target_forwards\`, \`draft_forwards\`, \`proposed\`, \`accepted\`, \`generated\`
  counters, and the properties \`acceptance_rate = accepted / proposed\` and \`tokens_per_target_forward =
  generated / target_forwards\` (prefill excluded; the baseline pays it too).
- \`autoregressive_generate(model, prompt, max_new_tokens, temperature=1.0, generator=None)\` is given: the
  baseline, one target forward per token with a KV cache.
- \`@torch.no_grad() speculative_generate(target, draft, prompt (T,) long, max_new_tokens, gamma=4,
  temperature=1.0, generator=None) -> (tokens (T + max_new_tokens,) long, SpecStats)\`:
  1. one \`KVCache\` per model; prefill both with \`prompt[:-1]\`, so each holds every position but the last;
  2. per round, \`g = min(gamma, max_new_tokens − generated − 1)\`: never emit more than asked;
  3. \`draft_tokens(draft, dcache, out[-1], g, temperature, generator)\`;
  4. **one** target forward over \`[out[-1], x̃_1, …, x̃_g]\`, \`g + 1\` positions, giving \`p_0 … p_g\` through
     \`to_probs\`;
  5. \`n, token = verify(p, q, drafted, generator, greedy=temperature == 0)\`; append \`drafted[:n]\` and
     \`token\`;
  6. roll back: \`tcache.truncate(len(out) − 1)\` drops the rejected positions, and
     \`dcache.truncate(min(dcache.pos, len(out) − 1))\`;
  7. after a fully accepted round the draft cache is **one short** (the last proposal was never fed):
     feed the missing token before the next round's drafts, and count that forward.
- \`exact_marginals\` is given: a model's exact distribution of each of the next few tokens, by
  enumerating every prefix, one batched forward per position.

The self-test trains a target (2 layers, 48 wide) and a draft (1 layer, 24 wide) on the same order-2
Markov chain over 16 tokens, converts both to float64, and checks:
- **greedy identity:** for γ = 1, 3 and 5, the 48 tokens are exactly \`autoregressive_generate(…,
  temperature=0.0)\`'s, with \`generated == accepted + target_forwards\` and fewer target forwards than tokens;
  the target drafting for itself accepts everything, 50 tokens in 10 target calls;
- **sampled distribution:** 3,000 runs of 4 tokens at temperature 1 with γ = 2 (so rounds and rollbacks
  happen): each position's empirical distribution is within TV \`1.2 · √(16 / 3000)\` of the target's
  exact marginal, which the draft's own marginals are not;
- **statistics:** a 56-token sampled run takes fewer target forwards than tokens, with the counters
  consistent; it prints the acceptance rate and tokens per target forward, then \`PASS\`.

Try the trade-off before you write it: α is how often the draft is right, γ how far it guesses, c what a
draft forward costs next to a target forward.

:::widget speculative-decoding {"alpha": 0.7, "gamma": 4, "cost": 0.1}

> The target still runs once per emitted round; what changes is that a round can emit up to γ + 1
> tokens. Memory-bound decoding makes the γ + 1-token target pass cost about the same as a 1-token one.`,
  hints: [
    'Keep the invariant "each cache holds `len(out) - 1` positions" at the top of every round. The target gets exactly `g + 1` new positions per round and gives back the rejected ones with `truncate`; the draft gets `g` and may need one more.',
    'Feed the target `out[-1]` followed by the drafts as one `(1, g + 1)` sequence: logits row `i` is then `p_i`, the target after `out` plus the first `i` drafts, which is exactly what `verify` compares with `q_i`.',
    'Catch-up: when the draft cache holds fewer than `len(out) - 1` positions at the start of a round, feed it the missing tokens `out[dcache.pos : -1]` in one forward. At the end of a round, cut it to `min(dcache.pos, len(out) - 1)`: it may already be shorter than the target cache.',
  ],
  checks: [
    {
      id: 'one-target-pass',
      title: 'Draft, one target forward, verify',
      detail:
        'Each round calls `draft_tokens`, then the target **once** with its cache over the last token and the drafts, then `verify`; never the target once per drafted token.',
      match: {
        python: {
          order: [/draft_tokens\(/, /\btarget\([^\n]*cache/, /\bverify\(/],
          none: [/\btransformers\b|assistant_model/],
        },
      },
    },
    {
      id: 'emit',
      title: 'Emits the accepted prefix and one more token',
      detail:
        'A round appends `drafted[:n]` and then the token `verify` returned: between 1 and γ + 1 tokens per target call.',
      match: {python: {all: [/\[\s*:\s*n\w*\s*\]/]}},
    },
    {
      id: 'rollback',
      title: 'Both caches rolled back after verification',
      detail:
        'After `verify`, `truncate` on the target cache and on the draft cache: the rejected drafts were written into both and must not be attended to next round.',
      match: {
        python: {
          all: [/\.truncate\([^\n]*\)[\s\S]*?\.truncate\(/],
          order: [/\bverify\(/, /\.truncate\(/, /\.truncate\(/],
        },
      },
    },
    {
      id: 'draft-catchup',
      title: 'The draft cache catches up after a full accept',
      detail:
        'When all γ drafts are accepted the draft never fed its last proposal: compare its cache length with the output and feed what is missing, else every later `q` is computed from a gap.',
      match: {python: {all: [/\w+\.pos\s*(?:<(?!=)|!=)|min\(\s*\w+\.pos/]}},
    },
    {
      id: 'clip-gamma',
      title: 'γ clipped to the tokens still owed',
      detail:
        '`min(gamma, max_new_tokens − generated − 1)`: a round emits up to `g + 1` tokens, so the last rounds draft fewer and the output is exactly `max_new_tokens` long.',
      match: {python: {all: [/min\(\s*gamma\s*,|min\([^\n]*,\s*gamma\s*\)/]}},
    },
    {
      id: 'stats',
      title: 'Acceptance rate and tokens per target forward',
      detail:
        '`acceptance_rate` is accepted over proposed drafts; `tokens_per_target_forward` is generated tokens over target calls, the number the speedup comes from.',
      match: {
        python: {all: [/accepted\s*\/\s*[^\n]*proposed/, /generated\s*\/\s*[^\n]*target_forwards/]},
      },
    },
    {
      id: 'no-grad',
      title: 'No autograd graph while decoding',
      detail: '`speculative_generate` is `@torch.no_grad()`: decoding never needs gradients.',
      match: {python: {all: [/@torch\.(?:no_grad|inference_mode)\(\)\s*\ndef speculative_generate\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""Speculative decoding, part 3: the decode loop, with both caches rolled back to the accepted length."""

import itertools
import math
import time
from dataclasses import dataclass

import torch

from spec_draft import KVCache, LMConfig, TinyLM, draft_tokens, fit, markov_corpus, to_probs
from spec_verify import tv, verify


@dataclass
class SpecStats:
    target_forwards: int = 0  # decode-time target calls; the prompt prefill is one more, as without speculation
    draft_forwards: int = 0
    proposed: int = 0
    accepted: int = 0
    generated: int = 0

    @property
    def acceptance_rate(self) -> float:
        raise NotImplementedError("TODO: accepted drafts over proposed drafts")

    @property
    def tokens_per_target_forward(self) -> float:
        raise NotImplementedError("TODO: generated tokens over target forwards")


@torch.no_grad()
def autoregressive_generate(
    model: TinyLM,
    prompt: torch.Tensor,
    max_new_tokens: int,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> torch.Tensor:
    """The baseline: one target forward per token, with a KV cache. prompt (T,) long -> (T + max_new_tokens,)."""
    cache = KVCache(model.config, dtype=model.head.weight.dtype)
    out = prompt.tolist()
    logits = model(prompt[None], cache)[0, -1]
    for _ in range(max_new_tokens):
        out.append(int(torch.multinomial(to_probs(logits, temperature), 1, generator=generator)))
        if len(out) - len(prompt) < max_new_tokens:
            logits = model(torch.tensor([[out[-1]]]), cache)[0, -1]
    return torch.tensor(out)


# TODO: no autograd graph while decoding.
def speculative_generate(
    target: TinyLM,
    draft: TinyLM,
    prompt: torch.Tensor,
    max_new_tokens: int,
    gamma: int = 4,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, SpecStats]:
    """Draft gamma, verify with one target forward over gamma + 1 positions, keep the accepted prefix.

    prompt (T,) long -> (T + max_new_tokens,) long and the run's SpecStats. temperature == 0 is greedy.
    """
    # TODO: prefill both caches with all of the prompt but its last token. Then, until max_new_tokens
    # are out: draft g tokens (gamma, fewer near the end), feed the last token and the g drafts to
    # the target in one forward, verify, append the accepted drafts and the extra token, and roll
    # both caches back to the new length minus one. A fully accepted round leaves the draft cache
    # one position behind: feed the missing token before the next round's drafts.
    raise NotImplementedError("TODO: the speculative loop")


@torch.no_grad()
def exact_marginals(model: TinyLM, prompt: torch.Tensor, horizon: int, temperature: float) -> list[torch.Tensor]:
    """The model's own distribution of each of the next horizon tokens, by enumerating every continuation."""
    V = model.config.vocab_size
    joint = torch.ones(1, dtype=torch.float64)  # P(x_1 .. x_k) over the V^k prefixes, in itertools.product order
    marginals = []
    for k in range(horizon):
        prefixes = torch.tensor(list(itertools.product(range(V), repeat=k)), dtype=torch.long).view(V**k, k)
        ctx = torch.cat([prompt.expand(V**k, -1), prefixes], dim=1)
        nxt = to_probs(model(ctx)[:, -1].double(), temperature)  # (V^k, V)
        joint = (joint[:, None] * nxt).reshape(-1)
        marginals.append(joint.view(-1, V).sum(dim=0))
    return marginals


if __name__ == "__main__":
    torch.manual_seed(0)
    V = 16
    data = markov_corpus(V, 20_000)
    t0 = time.perf_counter()
    target = TinyLM(LMConfig(vocab_size=V, block_size=64, n_layer=2, n_head=2, n_embd=48))
    draft = TinyLM(LMConfig(vocab_size=V, block_size=64, n_layer=1, n_head=2, n_embd=24))
    loss_t = fit(target, data, steps=300)
    loss_d = fit(draft, data, steps=300)
    target, draft = target.double(), draft.double()
    torch.set_num_threads(1)  # decoding runs one-row matmuls: thread start-up costs more than it saves
    print(f"trained in {time.perf_counter() - t0:.1f} s: target loss {loss_t:.3f}, draft loss {loss_d:.3f}")
    prompt = data[100:108]

    # Greedy: speculative output is token for token the target's own greedy output.
    ref = autoregressive_generate(target, prompt, 48, temperature=0.0)
    for gamma in (1, 3, 5):
        out, stats = speculative_generate(target, draft, prompt, 48, gamma=gamma, temperature=0.0)
        assert torch.equal(out, ref), gamma
        assert stats.generated == 48 == stats.accepted + stats.target_forwards
        assert stats.target_forwards < stats.generated, stats
    # A draft that is the target itself is always right: gamma + 1 tokens per target call.
    _, stats = speculative_generate(target, target, prompt, 50, gamma=4, temperature=0.0)
    assert stats.acceptance_rate == 1.0 and stats.target_forwards == 10

    # Sampling: each of the next 4 tokens follows the target's distribution, across rounds and rollbacks.
    H, trials = 4, 3000
    gen = torch.Generator().manual_seed(0)
    temperature = 1.0
    runs = torch.stack(
        [speculative_generate(target, draft, prompt, H, gamma=2, temperature=temperature, generator=gen)[0][-H:] for _ in range(trials)]
    )
    p_marg = exact_marginals(target, prompt, H, temperature)
    q_marg = exact_marginals(draft, prompt, H, temperature)
    bound = 1.2 * math.sqrt(V / trials)
    for k in range(H):
        empirical = torch.bincount(runs[:, k], minlength=V).double() / trials
        assert tv(empirical, p_marg[k]) < bound, (k, tv(empirical, p_marg[k]), bound)
    assert max(tv(p, q) for p, q in zip(p_marg, q_marg)) > 2 * bound  # the draft's own law would fail

    # Fewer target forwards than tokens, and the statistics add up.
    out, stats = speculative_generate(target, draft, prompt, 56, gamma=4, temperature=1.0, generator=gen)
    assert out.shape == (64,) and stats.generated == 56 == stats.accepted + stats.target_forwards
    assert stats.target_forwards < stats.generated and 0 < stats.acceptance_rate <= 1
    print(
        f"gamma 4: acceptance {stats.acceptance_rate:.2f}, {stats.tokens_per_target_forward:.2f} tokens per target"
        f" forward, {stats.target_forwards} target forwards for {stats.generated} tokens"
    )
    print("PASS")
`,
      solution: `"""Speculative decoding, part 3: the decode loop, with both caches rolled back to the accepted length."""

import itertools
import math
import time
from dataclasses import dataclass

import torch

from spec_draft import KVCache, LMConfig, TinyLM, draft_tokens, fit, markov_corpus, to_probs
from spec_verify import tv, verify


@dataclass
class SpecStats:
    target_forwards: int = 0  # decode-time target calls; the prompt prefill is one more, as without speculation
    draft_forwards: int = 0
    proposed: int = 0
    accepted: int = 0
    generated: int = 0

    @property
    def acceptance_rate(self) -> float:
        return self.accepted / max(self.proposed, 1)

    @property
    def tokens_per_target_forward(self) -> float:
        return self.generated / max(self.target_forwards, 1)


@torch.no_grad()
def autoregressive_generate(
    model: TinyLM,
    prompt: torch.Tensor,
    max_new_tokens: int,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> torch.Tensor:
    """The baseline: one target forward per token, with a KV cache. prompt (T,) long -> (T + max_new_tokens,)."""
    cache = KVCache(model.config, dtype=model.head.weight.dtype)
    out = prompt.tolist()
    logits = model(prompt[None], cache)[0, -1]
    for _ in range(max_new_tokens):
        out.append(int(torch.multinomial(to_probs(logits, temperature), 1, generator=generator)))
        if len(out) - len(prompt) < max_new_tokens:
            logits = model(torch.tensor([[out[-1]]]), cache)[0, -1]
    return torch.tensor(out)


@torch.no_grad()
def speculative_generate(
    target: TinyLM,
    draft: TinyLM,
    prompt: torch.Tensor,
    max_new_tokens: int,
    gamma: int = 4,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, SpecStats]:
    """Draft gamma, verify with one target forward over gamma + 1 positions, keep the accepted prefix.

    prompt (T,) long -> (T + max_new_tokens,) long and the run's SpecStats. temperature == 0 is greedy.
    """
    assert len(prompt) + max_new_tokens <= target.config.block_size
    dtype = target.head.weight.dtype
    tcache = KVCache(target.config, dtype=dtype)
    dcache = KVCache(draft.config, dtype=dtype)
    # Both caches hold every position but the last: the last token is fed in the next round.
    if len(prompt) > 1:
        target(prompt[None, :-1], tcache)
        draft(prompt[None, :-1], dcache)
    out = prompt.tolist()
    stats = SpecStats()
    while stats.generated < max_new_tokens:
        g = min(gamma, max_new_tokens - stats.generated - 1)  # never emit past max_new_tokens
        if g > 0 and dcache.pos < len(out) - 1:
            # After a fully accepted round the draft never saw its own last proposal: feed it now.
            draft(torch.tensor([out[dcache.pos : -1]]), dcache)
            stats.draft_forwards += 1
        drafted, q = draft_tokens(draft, dcache, out[-1], g, temperature, generator)
        stats.draft_forwards += g
        # One target forward scores the last token and every proposal: p_0 .. p_g.
        logits = target(torch.tensor([[out[-1]] + drafted.tolist()]), tcache)[0]
        stats.target_forwards += 1
        n, token = verify(to_probs(logits, temperature), q, drafted, generator, greedy=temperature == 0)
        out += drafted[:n].tolist() + [token]
        # Roll back to the accepted length: positions of rejected proposals are dropped.
        tcache.truncate(len(out) - 1)
        dcache.truncate(min(dcache.pos, len(out) - 1))
        stats.proposed += g
        stats.accepted += n
        stats.generated += n + 1
    return torch.tensor(out), stats


@torch.no_grad()
def exact_marginals(model: TinyLM, prompt: torch.Tensor, horizon: int, temperature: float) -> list[torch.Tensor]:
    """The model's own distribution of each of the next horizon tokens, by enumerating every continuation."""
    V = model.config.vocab_size
    joint = torch.ones(1, dtype=torch.float64)  # P(x_1 .. x_k) over the V^k prefixes, in itertools.product order
    marginals = []
    for k in range(horizon):
        prefixes = torch.tensor(list(itertools.product(range(V), repeat=k)), dtype=torch.long).view(V**k, k)
        ctx = torch.cat([prompt.expand(V**k, -1), prefixes], dim=1)
        nxt = to_probs(model(ctx)[:, -1].double(), temperature)  # (V^k, V)
        joint = (joint[:, None] * nxt).reshape(-1)
        marginals.append(joint.view(-1, V).sum(dim=0))
    return marginals


if __name__ == "__main__":
    torch.manual_seed(0)
    V = 16
    data = markov_corpus(V, 20_000)
    t0 = time.perf_counter()
    target = TinyLM(LMConfig(vocab_size=V, block_size=64, n_layer=2, n_head=2, n_embd=48))
    draft = TinyLM(LMConfig(vocab_size=V, block_size=64, n_layer=1, n_head=2, n_embd=24))
    loss_t = fit(target, data, steps=300)
    loss_d = fit(draft, data, steps=300)
    target, draft = target.double(), draft.double()
    torch.set_num_threads(1)  # decoding runs one-row matmuls: thread start-up costs more than it saves
    print(f"trained in {time.perf_counter() - t0:.1f} s: target loss {loss_t:.3f}, draft loss {loss_d:.3f}")
    prompt = data[100:108]

    # Greedy: speculative output is token for token the target's own greedy output.
    ref = autoregressive_generate(target, prompt, 48, temperature=0.0)
    for gamma in (1, 3, 5):
        out, stats = speculative_generate(target, draft, prompt, 48, gamma=gamma, temperature=0.0)
        assert torch.equal(out, ref), gamma
        assert stats.generated == 48 == stats.accepted + stats.target_forwards
        assert stats.target_forwards < stats.generated, stats
    # A draft that is the target itself is always right: gamma + 1 tokens per target call.
    _, stats = speculative_generate(target, target, prompt, 50, gamma=4, temperature=0.0)
    assert stats.acceptance_rate == 1.0 and stats.target_forwards == 10

    # Sampling: each of the next 4 tokens follows the target's distribution, across rounds and rollbacks.
    H, trials = 4, 3000
    gen = torch.Generator().manual_seed(0)
    temperature = 1.0
    runs = torch.stack(
        [speculative_generate(target, draft, prompt, H, gamma=2, temperature=temperature, generator=gen)[0][-H:] for _ in range(trials)]
    )
    p_marg = exact_marginals(target, prompt, H, temperature)
    q_marg = exact_marginals(draft, prompt, H, temperature)
    bound = 1.2 * math.sqrt(V / trials)
    for k in range(H):
        empirical = torch.bincount(runs[:, k], minlength=V).double() / trials
        assert tv(empirical, p_marg[k]) < bound, (k, tv(empirical, p_marg[k]), bound)
    assert max(tv(p, q) for p, q in zip(p_marg, q_marg)) > 2 * bound  # the draft's own law would fail

    # Fewer target forwards than tokens, and the statistics add up.
    out, stats = speculative_generate(target, draft, prompt, 56, gamma=4, temperature=1.0, generator=gen)
    assert out.shape == (64,) and stats.generated == 56 == stats.accepted + stats.target_forwards
    assert stats.target_forwards < stats.generated and 0 < stats.acceptance_rate <= 1
    print(
        f"gamma 4: acceptance {stats.acceptance_rate:.2f}, {stats.tokens_per_target_forward:.2f} tokens per target"
        f" forward, {stats.target_forwards} target forwards for {stats.generated} tokens"
    )
    print("PASS")
`,
    },
  },
  debrief: `The loop is short because steps 1 and 2 carry the weight: a cache that rewinds by assignment and an acceptance rule that is exact for any draft. What the loop adds is bookkeeping, and every bug in it is silent: a draft cache one position short after a full accept, or a target cache that keeps rejected keys, still produces fluent tokens, just not the target's. The greedy identity test catches both, because greedy verification is deterministic and any drift shows up as a different token. On real hardware the win comes from memory bandwidth: a decoding step of a 70B model reads all 140 GB of bf16 weights to produce one token, and scoring γ + 1 positions instead of one reads the same weights once, so the verification pass costs about one decode step while emitting \`(1 − α^(γ+1)) / (1 − α)\` tokens. Leviathan et al. report 2× to 3× on T5-XXL with identical outputs, and Chen et al. 2× to 2.5× on Chinchilla 70B. Production systems add batching (sequences accept different numbers of tokens, so caches and positions become ragged), adaptive γ, drafts that are heads on the target itself (Medusa, EAGLE) or n-gram lookups in the prompt, and CUDA graphs so the small draft forwards are not dominated by launch overhead. This self-test's CPU timings say nothing about speed: tiny models on a CPU are not memory-bound.`,
};
