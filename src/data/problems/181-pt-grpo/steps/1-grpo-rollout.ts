import type {Step} from '@/lib/types';

export const grpoRolloutStep: Step = {
  id: 'grpo-rollout',
  title: 'Rollouts: a group of completions per prompt, and their log-probs',
  concept: 'pytorch',
  file: 'grpo_rollout',
  focus: ['prompts', 'rollout', 'old-logp', 'ref-logp', 'seqs', 'mask'],
  task: `## Task

Write the policy and the two functions every GRPO iteration starts with: sample a **group** of
completions for each prompt, then score each completion token under a model. Plain PyTorch only: no
\`transformers\`, no \`.generate()\`.

- \`TinyLM(vocab_size, d_model=32, n_layer=2, n_head=2, max_len=16)\`: a decoder-only Transformer.
  \`forward(idx (N, T) long) -> logits (N, T, vocab_size)\`, where position \`t\` sees tokens \`0..t\`
  only (a \`triu\` mask of \`-inf\`, or \`is_causal=True\`). Token and position embeddings, \`n_layer\`
  pre-norm blocks (\`nn.TransformerEncoderLayer(…, norm_first=True, batch_first=True)\` is fine), a final
  LayerNorm and a linear head.
- \`completion_mask(completions (N, L) long, eos_id) -> (N, L) float32\`: \`1.0\` up to and including the
  first \`eos_id\` of a row, \`0.0\` after it; a row without EOS is all ones (cut at the budget).

\`@torch.no_grad() generate_group(policy, prompts, G, max_new_tokens, temperature=1.0, eos_id=0,
generator=None) -> (seqs, mask)\`:

- \`prompts\` is \`(B, P)\` long, all the same length;
- \`seqs\` is \`(B·G, P + L)\` long, with rows \`b·G … b·G + G − 1\` holding prompt \`b\` and its G
  completions (\`repeat_interleave(G, dim=0)\`), \`L ≤ max_new_tokens\`;
- each new token: last-position logits \`/ temperature\`, softmax, \`torch.multinomial(…,
  generator=generator)\`;
- a row that has emitted EOS keeps receiving \`eos_id\`; stop early when every row has;
- \`mask = completion_mask(seqs[:, P:], eos_id)\`.

- \`token_logprobs(model, input_ids (N, P + L), prompt_len, temperature=1.0) -> (N, L) float32\`: the
  log-probability of every completion token. The logits at position \`t\` predict token \`t + 1\`, so take
  positions \`prompt_len − 1 … −2\`, divide by \`temperature\` (the distribution the tokens were sampled
  from), \`log_softmax\`, and \`gather\` the next tokens. It is differentiable; callers wrap it in
  \`torch.no_grad()\` for the old policy and the reference.

The self-test checks the mask on hand-written rows, the shapes and the grouping of a real rollout, that
the tokens after a row's first EOS are EOS and masked, that the same seed draws the same completions and
another seed does not, and every log-prob against a loop that re-runs the model on each prefix and reads
its last row (\`atol=1e-5\`). It prints \`PASS\`.

> GRPO needs no value network, but it does need two things per completion token: the probability it was
> sampled with, and a mask saying which tokens the completion owns. Everything later is arithmetic on
> those \`(B·G, L)\` tensors.`,
  hints: [
    'The mask is a running count: `is_eos.cumsum(1) - is_eos` is the number of EOS tokens strictly before each position, and a position belongs to the completion when that count is 0.',
    'Sampling loop: last-position logits over the temperature, `torch.multinomial` with the generator, then overwrite the rows that are already `done` with `eos_id` (`torch.where`) before appending, and fold this step’s EOS into `done`.',
    'Log-probs: the logits at `[:, prompt_len - 1 : -1]` line up with the tokens at `[:, prompt_len:]`; `log_softmax` over the vocabulary, then `gather` on the last dimension.',
  ],
  checks: [
    {
      id: 'causal-policy',
      title: 'The policy is causal',
      detail:
        'A `triu` mask of `-inf` above the diagonal, `is_causal=True` or `generate_square_subsequent_mask`: a completion token scored under the policy must not see the tokens after it, or its log-prob is not the one it was sampled with.',
      match: {python: {all: [/torch\.(?:triu|tril)\(|is_causal\s*=\s*True|generate_square_subsequent_mask/]}},
    },
    {
      id: 'group-rows',
      title: 'Each prompt repeated G times in consecutive rows',
      detail:
        '`prompts.repeat_interleave(G, dim=0)`: rows `b·G … b·G + G − 1` are prompt `b`’s group, so later the rewards reshape to `(B, G)` with `view(-1, G)`. `repeat` would interleave the prompts instead and mix the groups.',
      match: {python: {all: [/repeat_interleave\(\s*G\b/]}},
    },
    {
      id: 'sample',
      title: 'Sampled at the temperature, from the generator',
      detail:
        'Logits divided by `temperature`, then `torch.multinomial(…, generator=generator)`: the group must be diverse (greedy decoding gives G identical completions and zero advantages) and reproducible under a seed. No `.generate()`, no `transformers`.',
      match: {
        python: {
          all: [/torch\.multinomial\([^)]*generator\s*=\s*generator/, /\/\s*temperature/],
          none: [/\.generate\(/, /from\s+transformers|import\s+transformers/],
        },
      },
    },
    {
      id: 'no-grad-sampling',
      title: 'Rollouts build no autograd graph',
      detail:
        '`generate_group` is decorated `@torch.no_grad()`: sampling runs the policy `max_new_tokens` times, and a graph through every step would hold all their activations for nothing; the gradient comes from re-scoring the finished sequences.',
      match: {python: {all: [/@torch\.(?:no_grad|inference_mode)\(\)\s*\n\s*def generate_group\(/]}},
    },
    {
      id: 'eos-mask',
      title: 'Mask through the first EOS',
      detail:
        'Tokens are compared with `eos_id` and the first EOS located with `cumsum` (or `argmax`/`cummax`): the EOS itself is part of the completion (the policy chose to stop), and everything after it is padding.',
      match: {python: {all: [/==\s*eos_id/, /cumsum\(|argmax\(|cummax\(/]}},
    },
    {
      id: 'shift-gather',
      title: 'Logits shifted by one, then gathered',
      detail:
        'The completion tokens are scored by the logits at `prompt_len - 1 … -2`, through `log_softmax` and `gather`: off by one and every ratio compares the wrong tokens, and the loss trains on noise.',
      match: {python: {all: [/prompt_len\s*-\s*1/, /log_softmax\(/, /gather\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""GRPO rollouts: a tiny causal LM policy, G sampled completions per prompt, and per-token log-probs."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class TinyLM(nn.Module):
    """A pre-norm decoder-only Transformer small enough to train with RL on a laptop CPU."""

    def __init__(self, vocab_size: int, d_model: int = 32, n_layer: int = 2, n_head: int = 2, max_len: int = 16):
        """Token and position embeddings, n_layer causal pre-norm blocks, a final LayerNorm, the head."""
        # TODO: token and position embeddings, n_layer causal pre-norm blocks, a final norm, a
        # vocabulary head, and a (max_len, max_len) causal mask.
        raise NotImplementedError("TODO")

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        """idx (N, T) long -> logits (N, T, vocab_size); position t sees tokens 0..t only."""
        # TODO: embed tokens + positions, run the blocks under the causal mask, return the logits.
        raise NotImplementedError("TODO")


def completion_mask(completions: torch.Tensor, eos_id: int) -> torch.Tensor:
    """(N, L) long -> (N, L) float32: 1.0 up to and including the first EOS, 0.0 after it."""
    # TODO: count the EOS tokens strictly before each position; keep the positions where it is 0.
    raise NotImplementedError("TODO")


def generate_group(
    policy: nn.Module,
    prompts: torch.Tensor,
    G: int,
    max_new_tokens: int,
    temperature: float = 1.0,
    eos_id: int = 0,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """G sampled completions per prompt.

    prompts (B, P) long, all the same length. Returns sequences (B*G, P + L) long, rows b*G .. b*G + G - 1
    holding prompt b's group, and the completion mask (B*G, L) float32, L <= max_new_tokens. Positions after
    a row's first EOS are filled with eos_id and masked out.
    """
    # TODO: no autograd graph while sampling. Repeat each prompt G times as consecutive rows;
    # for each new token: last-position logits / temperature -> softmax -> torch.multinomial with
    # the generator; finished rows get eos_id; stop early once every row has emitted EOS.
    raise NotImplementedError("TODO")


def token_logprobs(model: nn.Module, input_ids: torch.Tensor, prompt_len: int, temperature: float = 1.0) -> torch.Tensor:
    """Log-probability of every completion token under model: (N, P + L) long -> (N, L) float32.

    The logits at position t predict token t + 1, so the completion's L tokens are scored by the logits at
    positions P - 1 .. P + L - 2. Differentiable: wrap the call in torch.no_grad() for the old policy and
    the reference.
    """
    # TODO: logits at positions prompt_len - 1 .. -2, divided by temperature; log_softmax;
    # gather the log-probability of each completion token.
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    V, EOS, P, G, N = 13, 12, 4, 4, 6
    policy = TinyLM(V, d_model=32, n_layer=2, n_head=2, max_len=16)
    prompts = torch.randint(0, EOS, (3, P))

    # The mask: ones through the first EOS, zeros after it; no EOS means the row was cut at the budget.
    c = torch.tensor([[5, EOS, 3, EOS], [1, 2, 3, 4], [EOS, EOS, 7, 7], [4, 4, 4, EOS]])
    want = torch.tensor([[1, 1, 0, 0], [1, 1, 1, 1], [1, 0, 0, 0], [1, 1, 1, 1]], dtype=torch.float32)
    assert torch.equal(completion_mask(c, EOS), want)

    # Shapes and grouping: rows b*G .. b*G + G - 1 all start with prompt b.
    gen = torch.Generator().manual_seed(1)
    seqs, mask = generate_group(policy, prompts, G, N, temperature=1.0, eos_id=EOS, generator=gen)
    L = seqs.shape[1] - P
    assert seqs.dtype == torch.long and seqs.shape[0] == 3 * G and 1 <= L <= N, seqs.shape
    assert mask.shape == (3 * G, L) and mask.dtype == torch.float32
    assert torch.equal(seqs[:, :P], prompts[torch.arange(3 * G) // G])
    for row, m in zip(seqs[:, P:].tolist(), mask.tolist()):
        first = row.index(EOS) if EOS in row else L
        assert m == [1.0] * min(first + 1, L) + [0.0] * (L - min(first + 1, L)), (row, m)
        assert all(t == EOS for t in row[first:])

    # Determinism: the same seed draws the same completions, another seed does not.
    again, _ = generate_group(policy, prompts, G, N, 1.0, EOS, torch.Generator().manual_seed(1))
    other, _ = generate_group(policy, prompts, G, N, 1.0, EOS, torch.Generator().manual_seed(2))
    assert torch.equal(seqs, again) and not torch.equal(seqs, other)

    # Log-probs against a loop: re-run the prefix for every completion token and read the last row.
    temp = 0.7
    lp = token_logprobs(policy, seqs, P, temperature=temp)
    assert lp.shape == (3 * G, L) and lp.requires_grad
    with torch.no_grad():
        for i in range(seqs.shape[0]):
            for t in range(L):
                logits = policy(seqs[i : i + 1, : P + t])[0, -1] / temp
                ref = logits[seqs[i, P + t]] - torch.logsumexp(logits, dim=0)
                assert torch.allclose(lp[i, t], ref, atol=1e-5), (i, t, lp[i, t].item(), ref.item())
        assert not token_logprobs(policy, seqs, P).requires_grad
    print(f"{3 * G} completions of up to {N} tokens, {int(mask.sum())} unmasked")
    print("PASS")
`,
      solution: `"""GRPO rollouts: a tiny causal LM policy, G sampled completions per prompt, and per-token log-probs."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class TinyLM(nn.Module):
    """A pre-norm decoder-only Transformer small enough to train with RL on a laptop CPU."""

    def __init__(self, vocab_size: int, d_model: int = 32, n_layer: int = 2, n_head: int = 2, max_len: int = 16):
        """Token and position embeddings, n_layer causal pre-norm blocks, a final LayerNorm, the head."""
        super().__init__()
        self.tok = nn.Embedding(vocab_size, d_model)
        self.pos = nn.Embedding(max_len, d_model)
        layer = nn.TransformerEncoderLayer(
            d_model, n_head, 4 * d_model, dropout=0.0, batch_first=True, norm_first=True
        )
        self.blocks = nn.TransformerEncoder(layer, n_layer, enable_nested_tensor=False)
        self.ln_f = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size)
        causal = torch.triu(torch.full((max_len, max_len), float("-inf")), diagonal=1)
        self.register_buffer("causal", causal, persistent=False)

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        """idx (N, T) long -> logits (N, T, vocab_size); position t sees tokens 0..t only."""
        T = idx.shape[1]
        x = self.tok(idx) + self.pos(torch.arange(T, device=idx.device))
        x = self.blocks(x, mask=self.causal[:T, :T], is_causal=True)
        return self.head(self.ln_f(x))


def completion_mask(completions: torch.Tensor, eos_id: int) -> torch.Tensor:
    """(N, L) long -> (N, L) float32: 1.0 up to and including the first EOS, 0.0 after it."""
    is_eos = (completions == eos_id).long()
    eos_before = torch.cumsum(is_eos, dim=1) - is_eos  # EOS tokens strictly before each position
    return (eos_before == 0).float()


@torch.no_grad()
def generate_group(
    policy: nn.Module,
    prompts: torch.Tensor,
    G: int,
    max_new_tokens: int,
    temperature: float = 1.0,
    eos_id: int = 0,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """G sampled completions per prompt.

    prompts (B, P) long, all the same length. Returns sequences (B*G, P + L) long, rows b*G .. b*G + G - 1
    holding prompt b's group, and the completion mask (B*G, L) float32, L <= max_new_tokens. Positions after
    a row's first EOS are filled with eos_id and masked out.
    """
    seqs = prompts.repeat_interleave(G, dim=0)
    P = prompts.shape[1]
    done = torch.zeros(seqs.shape[0], dtype=torch.bool, device=seqs.device)
    for _ in range(max_new_tokens):
        logits = policy(seqs)[:, -1, :] / temperature
        probs = torch.softmax(logits, dim=-1)
        nxt = torch.multinomial(probs, 1, generator=generator).squeeze(1)
        nxt = torch.where(done, torch.full_like(nxt, eos_id), nxt)
        seqs = torch.cat([seqs, nxt[:, None]], dim=1)
        done = done | (nxt == eos_id)
        if bool(done.all()):
            break
    return seqs, completion_mask(seqs[:, P:], eos_id)


def token_logprobs(model: nn.Module, input_ids: torch.Tensor, prompt_len: int, temperature: float = 1.0) -> torch.Tensor:
    """Log-probability of every completion token under model: (N, P + L) long -> (N, L) float32.

    The logits at position t predict token t + 1, so the completion's L tokens are scored by the logits at
    positions P - 1 .. P + L - 2. Differentiable: wrap the call in torch.no_grad() for the old policy and
    the reference.
    """
    logits = model(input_ids)[:, prompt_len - 1 : -1, :] / temperature
    logp = F.log_softmax(logits.float(), dim=-1)
    targets = input_ids[:, prompt_len:]
    return torch.gather(logp, 2, targets.unsqueeze(-1)).squeeze(-1)


if __name__ == "__main__":
    torch.manual_seed(0)
    V, EOS, P, G, N = 13, 12, 4, 4, 6
    policy = TinyLM(V, d_model=32, n_layer=2, n_head=2, max_len=16)
    prompts = torch.randint(0, EOS, (3, P))

    # The mask: ones through the first EOS, zeros after it; no EOS means the row was cut at the budget.
    c = torch.tensor([[5, EOS, 3, EOS], [1, 2, 3, 4], [EOS, EOS, 7, 7], [4, 4, 4, EOS]])
    want = torch.tensor([[1, 1, 0, 0], [1, 1, 1, 1], [1, 0, 0, 0], [1, 1, 1, 1]], dtype=torch.float32)
    assert torch.equal(completion_mask(c, EOS), want)

    # Shapes and grouping: rows b*G .. b*G + G - 1 all start with prompt b.
    gen = torch.Generator().manual_seed(1)
    seqs, mask = generate_group(policy, prompts, G, N, temperature=1.0, eos_id=EOS, generator=gen)
    L = seqs.shape[1] - P
    assert seqs.dtype == torch.long and seqs.shape[0] == 3 * G and 1 <= L <= N, seqs.shape
    assert mask.shape == (3 * G, L) and mask.dtype == torch.float32
    assert torch.equal(seqs[:, :P], prompts[torch.arange(3 * G) // G])
    for row, m in zip(seqs[:, P:].tolist(), mask.tolist()):
        first = row.index(EOS) if EOS in row else L
        assert m == [1.0] * min(first + 1, L) + [0.0] * (L - min(first + 1, L)), (row, m)
        assert all(t == EOS for t in row[first:])

    # Determinism: the same seed draws the same completions, another seed does not.
    again, _ = generate_group(policy, prompts, G, N, 1.0, EOS, torch.Generator().manual_seed(1))
    other, _ = generate_group(policy, prompts, G, N, 1.0, EOS, torch.Generator().manual_seed(2))
    assert torch.equal(seqs, again) and not torch.equal(seqs, other)

    # Log-probs against a loop: re-run the prefix for every completion token and read the last row.
    temp = 0.7
    lp = token_logprobs(policy, seqs, P, temperature=temp)
    assert lp.shape == (3 * G, L) and lp.requires_grad
    with torch.no_grad():
        for i in range(seqs.shape[0]):
            for t in range(L):
                logits = policy(seqs[i : i + 1, : P + t])[0, -1] / temp
                ref = logits[seqs[i, P + t]] - torch.logsumexp(logits, dim=0)
                assert torch.allclose(lp[i, t], ref, atol=1e-5), (i, t, lp[i, t].item(), ref.item())
        assert not token_logprobs(policy, seqs, P).requires_grad
    print(f"{3 * G} completions of up to {N} tokens, {int(mask.sum())} unmasked")
    print("PASS")
`,
    },
  },
  debrief: `A rollout is the expensive half of RL for language models, and its output is small: token ids, a mask and one log-prob per token. **Groups as consecutive rows** make every later step a reshape: rewards \`view(-1, G)\`, advantages per row broadcast over its tokens. **The mask includes the EOS**: stopping is an action the policy took and must be credited or blamed like any other token; the padding after it is not. **Log-probs at the sampling temperature**: \`π_old\` in the ratio must be the distribution the tokens were drawn from, or the importance weights correct for a policy that never sampled them; this is why TRL divides the logits by the generation temperature before \`log_softmax\`. **No graph while sampling**: the gradient comes from one teacher-forced pass over the finished sequences, so sampling can run under \`no_grad\` (and, in production, on a different engine). What production adds: a KV cache instead of re-running the prefix every token; vLLM as the rollout engine with weights synced from the trainer after every update; left-padded prompts of different lengths with an attention mask; stop strings and chat templates; and generation batched across GPUs so that the G completions of one prompt land in the same reward computation.`,
};
