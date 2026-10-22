import type {Step} from '@/lib/types';

/** The solution, verbatim; the starter below is the same file with the three mechanism bodies cut out. */
const solution = `"""Mixture of experts: a top-k router with the Switch/GShard load-balancing loss, and an MoE layer that
dispatches tokens to experts in one loop over experts, drops what exceeds an expert's capacity, and
combines the expert outputs weighted by the gate."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class TopKRouter(nn.Module):
    """Gate logits → softmax → top-k experts per token with renormalised weights, plus the auxiliary losses."""

    def __init__(self, d_model: int, n_experts: int, k: int, z_loss_coef: float = 0.0):
        super().__init__()
        self.n_experts = n_experts
        self.k = k
        self.z_loss_coef = z_loss_coef
        self.gate = nn.Linear(d_model, n_experts, bias=False)

    def forward(self, tokens: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """tokens (T, D) → (idx (T, k) int64, weights (T, k) summing to 1 per token, aux scalar)."""
        logits = self.gate(tokens).float()  # (T, E): the router runs in float32 whatever the model dtype
        probs = F.softmax(logits, dim=-1)  # (T, E)
        topk_probs, idx = torch.topk(probs, self.k, dim=-1)  # (T, k) each
        weights = topk_probs / topk_probs.sum(dim=-1, keepdim=True)  # renormalise over the k chosen
        # Load-balancing loss (Switch Transformer eq. 4): E · Σ_e f_e · P_e.
        # f_e: fraction of the T·k routing slots assigned to expert e (hard, no gradient);
        # P_e: mean router probability of expert e (soft, carries the gradient to the gate).
        mask = F.one_hot(idx, self.n_experts).sum(dim=1).float()  # (T, E) ∈ {0, 1}
        f = mask.sum(dim=0) / (tokens.shape[0] * self.k)  # (E,)
        P = probs.mean(dim=0)  # (E,)
        aux = self.n_experts * torch.sum(f * P)
        if self.z_loss_coef > 0:
            # Router z-loss (ST-MoE): keeps the logits small so the softmax never saturates.
            z = torch.logsumexp(logits, dim=-1)  # (T,)
            aux = aux + self.z_loss_coef * torch.mean(z**2)
        return idx, weights, aux


class Expert(nn.Module):
    """One feed-forward expert: D → d_ff → D with a GELU."""

    def __init__(self, d_model: int, d_ff: int):
        super().__init__()
        self.w1 = nn.Linear(d_model, d_ff)
        self.w2 = nn.Linear(d_ff, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.w2(F.gelu(self.w1(x)))


class MoE(nn.Module):
    """A sparse MoE feed-forward sub-layer: route, dispatch per expert under a capacity, combine."""

    def __init__(
        self, d_model: int, d_ff: int, n_experts: int, k: int, capacity_factor: float = 1.25, z_loss_coef: float = 0.0
    ):
        super().__init__()
        self.router = TopKRouter(d_model, n_experts, k, z_loss_coef)
        self.experts = nn.ModuleList([Expert(d_model, d_ff) for _ in range(n_experts)])
        self.capacity_factor = capacity_factor

    def capacity(self, n_tokens: int) -> int:
        """Slots each expert accepts in one forward pass."""
        return math.ceil(self.capacity_factor * n_tokens * self.router.k / self.router.n_experts)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """x (B, S, D) → (y (B, S, D), aux). y is the expert mix only: a dropped token's row is zero."""
        B, S, D = x.shape
        tokens = x.reshape(-1, D)  # (T, D)
        T = tokens.shape[0]
        idx, weights, aux = self.router(tokens)  # (T, k), (T, k), scalar
        capacity = self.capacity(T)
        y = torch.zeros_like(tokens)
        for e, expert in enumerate(self.experts):
            tok, slot = torch.where(idx == e)  # the tokens that chose e, in token order, and which of their k slots did
            tok, slot = tok[:capacity], slot[:capacity]  # first \`capacity\` in token order are kept, the rest dropped
            if tok.numel() == 0:
                continue
            out = expert(tokens[tok])  # (n_e, D): one batched expert call, no per-token loop
            y.index_add_(0, tok, out * weights[tok, slot].unsqueeze(-1))
        return y.reshape(B, S, D), aux


def moe_reference(moe: MoE, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """The same layer, one token and one slot at a time, keeping a per-expert counter for the capacity."""
    B, S, D = x.shape
    tokens = x.reshape(-1, D)
    idx, weights, aux = moe.router(tokens)
    capacity = moe.capacity(tokens.shape[0])
    used = [0] * moe.router.n_experts
    rows = []
    for t in range(tokens.shape[0]):
        acc = torch.zeros(D)
        for j in range(moe.router.k):
            e = int(idx[t, j])
            if used[e] >= capacity:
                continue
            used[e] += 1
            acc = acc + weights[t, j] * moe.experts[e](tokens[t : t + 1])[0]
        rows.append(acc)
    return torch.stack(rows).reshape(B, S, D), aux


if __name__ == "__main__":
    torch.manual_seed(0)
    B, S, D, FF, E, K = 2, 16, 32, 64, 4, 2
    T = B * S

    # 1. Uniform gate logits: f_e and P_e are both 1/E, the aux loss sits at its minimum of 1.
    router = TopKRouter(D, E, K)
    with torch.no_grad():
        router.gate.weight.zero_()
    _, w, aux = router(torch.randn(T, D))
    assert torch.allclose(w.sum(dim=-1), torch.ones(T), atol=1e-6), "top-k weights must sum to 1 per token"
    assert abs(aux.item() - 1.0) < 1e-5, f"uniform routing should give aux = 1, got {aux.item():.4f}"

    # 2. Every token prefers expert 0: f_0 → 1 and P_0 → 1, so the loss climbs toward E.
    router1 = TopKRouter(D, E, 1)
    with torch.no_grad():
        router1.gate.weight.zero_()
        router1.gate.weight[0] = 10.0  # expert 0's logit is 10·Σx, every token lands there
    _, _, aux_peaked = router1(torch.ones(T, D))
    assert aux_peaked.item() > E * 0.9, f"collapsed routing should give aux ≈ {E}, got {aux_peaked.item():.4f}"

    # 3. The vectorised dispatch matches the per-token reference, including which tokens are dropped.
    moe = MoE(D, FF, E, K, capacity_factor=1.0, z_loss_coef=1e-3)
    x = torch.randn(B, S, D)
    y, aux = moe(x)
    y_ref, aux_ref = moe_reference(moe, x)
    assert y.shape == x.shape
    assert torch.allclose(y, y_ref, atol=1e-5), f"max abs diff {(y - y_ref).abs().max().item():.2e}"
    assert torch.allclose(aux, aux_ref)

    # 4. Capacity drops exactly the tokens beyond each expert's quota (k = 1: a dropped token's row is zero).
    moe1 = MoE(D, FF, E, 1, capacity_factor=0.5)
    idx, _, _ = moe1.router(x.reshape(T, D))
    counts = torch.bincount(idx[:, 0], minlength=E)
    expected_dropped = int((counts - moe1.capacity(T)).clamp(min=0).sum())
    assert expected_dropped > 0, "the test needs some overflow"
    y1, _ = moe1(x)
    dropped = int((y1.reshape(T, D) == 0).all(dim=-1).sum())
    assert dropped == expected_dropped, f"dropped {dropped} tokens, expected {expected_dropped}"
    assert moe1.capacity(T) == math.ceil(0.5 * T * 1 / E)

    # 5. The gate learns: both the weighted combine and the aux loss send gradients to it.
    moe.zero_grad()
    (y.sum() + aux).backward()
    g = moe.router.gate.weight.grad
    assert g is not None and g.abs().sum().item() > 0, "no gradient reached the gate"
    moe.zero_grad()
    _, aux_only = moe(x)
    aux_only.backward()
    assert moe.router.gate.weight.grad.abs().sum().item() > 0, "the aux loss alone must move the gate"

    print("PASS")
`;

const starter = solution
  .replace(
    / {8}logits = self\.gate\(tokens\)\.float\(\)[\s\S]*? {8}return idx, weights, aux\n/,
    `        # TODO: logits = gate(tokens) in float32 → softmax → top-k → renormalise the k weights;
        # TODO: aux = n_experts · Σ_e f_e · P_e (f_e from a one-hot of idx, P_e = probs.mean(0)),
        # TODO: plus z_loss_coef · mean(logsumexp(logits)²) when z_loss_coef > 0.
        raise NotImplementedError("TODO")
`,
  )
  .replace(
    / {8}return math\.ceil\(self\.capacity_factor \* n_tokens \* self\.router\.k \/ self\.router\.n_experts\)\n/,
    `        raise NotImplementedError("TODO: ceil(capacity_factor · n_tokens · k / n_experts)")
`,
  )
  .replace(
    / {8}B, S, D = x\.shape\n {8}tokens = x\.reshape\(-1, D\) {2}# \(T, D\)[\s\S]*? {8}return y\.reshape\(B, S, D\), aux\n/,
    `        # TODO: flatten to (T, D), route, compute the capacity, start y at zeros; then for each expert
        # TODO: gather its tokens with torch.where(idx == e), keep the first \`capacity\`, run the expert
        # TODO: once on the gathered rows and index_add_ the gate-weighted output back into y.
        raise NotImplementedError("TODO")
`,
  );

export const moeStep: Step = {
  id: 'moe',
  title: 'TopKRouter and MoE: route, balance, dispatch under capacity, combine',
  concept: 'pytorch',
  file: 'moe',
  focus: ['router', 'experts', 'combine'],
  task: `## Task

Implement a sparse mixture-of-experts feed-forward sub-layer in PyTorch: the router that picks \`k\` of
\`E\` experts per token and the layer that runs each expert once on the tokens it won.

- \`TopKRouter(d_model, n_experts, k, z_loss_coef=0.0)\` holds one \`nn.Linear(d_model, n_experts, bias=False)\`
  gate. \`forward(tokens)\` with \`tokens\` of shape \`(T, D)\` returns \`(idx, weights, aux)\`: \`idx\` \`(T, k)\`
  int64 expert ids, \`weights\` \`(T, k)\` the top-k softmax probabilities **renormalised to sum to 1 per
  token**, and \`aux\` a float32 scalar. Compute the logits in float32 (\`.float()\`), \`F.softmax\` over the
  expert axis, then \`torch.topk\`.
- The **load-balancing loss** is the Switch Transformer's: \`aux = n_experts · Σ_e f_e · P_e\` where \`f_e\`
  is the fraction of the \`T·k\` routing slots that went to expert \`e\` (from a one-hot of \`idx\`, no
  gradient) and \`P_e = probs.mean(dim=0)\` (soft, carries the gradient). Uniform routing gives exactly 1;
  every token on one expert gives \`n_experts\`.
- The **router z-loss** is optional: when \`z_loss_coef > 0\` add \`z_loss_coef · mean(logsumexp(logits)²)\`
  to \`aux\`.
- \`Expert(d_model, d_ff)\` is given: \`w2(gelu(w1(x)))\`.
- \`MoE(d_model, d_ff, n_experts, k, capacity_factor=1.25, z_loss_coef=0.0)\` holds the router and an
  \`nn.ModuleList\` of \`n_experts\` experts. \`capacity(n_tokens) = ceil(capacity_factor · n_tokens · k / n_experts)\`.
- \`MoE.forward(x)\` with \`x\` \`(B, S, D)\` returns \`(y, aux)\`, \`y\` \`(B, S, D)\`. Flatten to \`(T, D)\`, route,
  start \`y\` at \`torch.zeros_like(tokens)\`, then **one loop over experts**: \`tok, slot = torch.where(idx == e)\`
  (token order), keep the first \`capacity\` of them, run the expert **once** on \`tokens[tok]\`, and
  \`y.index_add_(0, tok, out * weights[tok, slot].unsqueeze(-1))\`. No per-token Python loop, no running
  every expert on every token and masking.
- A token whose slot overflowed the capacity gets nothing from that expert; a token that lost all its
  slots leaves \`y\` as a zero row. \`y\` is the expert mix only — the block's residual \`h + moe(norm(h))\`
  carries a dropped token through unchanged. Never add \`x\` inside \`forward\`.
- Keep the graph intact: no \`.detach()\`, no \`torch.no_grad()\` around the router, so the gate receives
  gradients through both the combine weights and \`aux\`.
- The self-test at the end of the file: zeroed gate → \`aux = 1 ± 1e-5\` and weights summing to 1; a gate
  that sends every token to expert 0 → \`aux > 0.9 · E\`; the vectorised layer matches \`moe_reference\`
  (a slow per-token loop with per-expert counters) within \`atol=1e-5\`; with \`k = 1\` and
  \`capacity_factor = 0.5\` the number of zero rows equals \`Σ_e max(0, count_e − capacity)\`; and
  \`gate.weight.grad\` is non-zero after \`(y.sum() + aux).backward()\` and after \`aux.backward()\` alone.

> A router is a classifier that nobody labels: the hard choice \`f_e\` has no gradient, so the balancing
> loss multiplies it by the soft \`P_e\` — pushing probability away from crowded experts is the only
> signal that keeps the gate from collapsing onto one.`,
  sequence: {
    participants: ['tokens (T, D)', 'TopKRouter', 'MoE', 'expert e', 'y'],
    messages: [
      {from: 'tokens (T, D)', to: 'TopKRouter', label: 'gate → logits (T, E) · softmax · topk(k)', kind: 'sync'},
      {
        from: 'TopKRouter',
        to: 'TopKRouter',
        label: 'f = one_hot(idx).sum / (T·k) · P = probs.mean(0) · aux = E·Σ f·P',
        kind: 'sync',
      },
      {from: 'TopKRouter', to: 'MoE', label: 'idx (T, k) · weights (T, k) · aux', kind: 'reply'},
      {from: 'MoE', to: 'MoE', label: 'capacity = ceil(cf · T · k / E) · y = zeros (T, D)', kind: 'sync'},
      {
        from: 'MoE',
        to: 'expert e',
        label: 'for e: tok, slot = where(idx == e) → [:capacity] → expert(tokens[tok])',
        kind: 'sync',
      },
      {from: 'expert e', to: 'MoE', label: 'out (n_e, D)', kind: 'reply'},
      {from: 'MoE', to: 'y', label: 'y.index_add_(0, tok, out · weights[tok, slot])', kind: 'sync'},
      {
        from: 'y',
        to: 'tokens (T, D)',
        label: 'reshape (B, S, D); dropped rows stay 0 — the residual carries them',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Router first, in float32: `probs = F.softmax(self.gate(tokens).float(), -1)`, `topk_probs, idx = torch.topk(probs, self.k, -1)`, `weights = topk_probs / topk_probs.sum(-1, keepdim=True)`. For the loss build `mask = F.one_hot(idx, E).sum(1).float()` of shape `(T, E)`; `f = mask.sum(0) / (T * k)`, `P = probs.mean(0)`.',
    '`torch.where(idx == e)` on the `(T, k)` index tensor gives two vectors in row-major order: the token ids that chose `e` and which of their `k` slots did. Slicing both with `[:capacity]` keeps the earliest tokens — the same tokens a per-token loop with a counter would keep.',
    'The combine is one `index_add_` per expert: `y.index_add_(0, tok, out * weights[tok, slot].unsqueeze(-1))` scatters each weighted output row back to its token; two slots of one token add into the same row. Return `y.reshape(B, S, D)` without adding `x`.',
  ],
  checks: [
    {
      id: 'softmax-topk',
      title: 'Softmax over experts, top-k, weights renormalised per token',
      detail:
        'Gate logits go through `F.softmax` over the expert axis, then `torch.topk(probs, k)`, and the k probabilities are divided by their sum so each token’s weights add to 1 — with a zeroed gate every token’s weights are `1/k`.',
      match: {
        python: {
          all: [
            /F\.softmax\(|torch\.softmax\(/,
            /torch\.topk\(/,
            /\/\s*\w+\.sum\(\s*(dim\s*=\s*)?-1\s*,\s*keepdim\s*=\s*True\s*\)/,
          ],
          order: [/F\.softmax\(|torch\.softmax\(/, /torch\.topk\(/],
        },
      },
    },
    {
      id: 'aux-loss',
      title: 'Load-balancing loss is n_experts · Σ f_e · P_e',
      detail:
        '`f_e` comes from a one-hot of the chosen indices summed over tokens, `P_e` is the mean softmax probability, and the loss scales their dot product by `n_experts` — exactly 1 under uniform routing, `n_experts` when every token picks one expert.',
      match: {
        python: {
          all: [
            /F\.one_hot\(/,
            /\.mean\(\s*(dim\s*=\s*)?0\s*\)/,
            /n_experts\s*\*\s*torch\.sum\(|n_experts\s*\*\s*\([^\n]*\)\.sum\(\)|\.sum\(\)\s*\*\s*self\.n_experts/,
          ],
        },
      },
    },
    {
      id: 'z-loss',
      title: 'Router z-loss is mean(logsumexp(logits)²), only when enabled',
      detail:
        'When `z_loss_coef > 0` the router adds `z_loss_coef · mean(logsumexp(logits, -1) ** 2)` to `aux`, keeping the gate logits small so the softmax never saturates; a coefficient of 0 adds nothing.',
      match: {
        python: {all: [/if self\.z_loss_coef\s*>\s*0/, /torch\.logsumexp\(/, /\*\*\s*2|\.square\(\)|\.pow\(\s*2\s*\)/]},
      },
    },
    {
      id: 'capacity',
      title: 'Capacity is ceil(capacity_factor · T · k / n_experts) and truncates each expert’s list',
      detail:
        '`capacity()` uses `math.ceil` on the factor times tokens times k over experts, and the dispatch keeps only the first `capacity` tokens of each expert (`[:capacity]`) — 32 tokens, k = 1, factor 0.5 and 4 experts give a capacity of 4.',
      match: {
        python: {all: [/math\.ceil\(\s*self\.capacity_factor\s*\*/, /\[\s*:\s*capacity\s*\]/]},
      },
    },
    {
      id: 'expert-loop',
      title: 'Dispatches in one loop over experts with index gathers',
      detail:
        'The layer iterates `enumerate(self.experts)`, finds each expert’s tokens with `torch.where(idx == e)`, runs the expert once on the gathered rows and scatters back with `index_add_` — not a Python loop over tokens and not every expert over every token with a mask.',
      match: {
        python: {
          all: [
            /for \w+, \w+ in enumerate\(self\.experts\)/,
            /torch\.where\(\s*\w+\s*==\s*\w+\s*\)/,
            /\.index_add_\(\s*0\s*,/,
          ],
          none: [/\[\s*\w+\(tokens\)\s+for\s+\w+\s+in\s+self\.experts\s*\]/],
        },
      },
    },
    {
      id: 'dropped-zero',
      title: 'Dropped tokens leave a zero row; the residual is the block’s, not the layer’s',
      detail:
        '`y` starts as `torch.zeros_like(tokens)` and only routed slots add to it, so a token that overflowed every expert it chose comes out as zeros and the block’s `h + moe(norm(h))` carries it unchanged — the layer must not add `x` itself.',
      match: {
        python: {
          all: [/torch\.zeros_like\(/, /\.reshape\(B, S, D\)/],
          none: [/return\s+(tokens|x)\s*\+/, /\+\s*tokens\.reshape|\+\s*x\.reshape/],
        },
      },
    },
    {
      id: 'gate-grad',
      title: 'The gate weights multiply the expert outputs inside the graph',
      detail:
        'The combine multiplies each expert output by `weights[tok, slot]` (unsqueezed to a column) with nothing detached and no `no_grad` around the router, so `gate.weight.grad` is non-zero after `(y.sum() + aux).backward()`.',
      match: {
        python: {
          all: [/weights\[\s*\w+\s*,\s*\w+\s*\]\.unsqueeze\(\s*-1\s*\)|weights\[\s*\w+\s*,\s*\w+\s*,\s*None\s*\]/],
          none: [/\.detach\(\)/, /with torch\.no_grad\(\):\s*\n\s+\w+[^\n]*=\s*self\.router\(/],
        },
      },
    },
  ],
  code: {python: {starter, solution}},
  debrief: `The layer is two loops' worth of ideas and one loop of code. Routing is a softmax over experts — a classifier with no labels — and the only things that train it are the gradient through the combine weights (a token's expert did well, so send more probability there) and the auxiliary loss. The balancing loss is shaped the way it is because the hard assignment \`f_e\` has no gradient: multiplying it by the soft \`P_e\` turns "expert 0 took 80 % of the tokens" into a push on the probabilities themselves, and the \`n_experts\` factor makes the loss 1 at the optimum regardless of \`E\` so one coefficient works across model sizes. The z-loss is the same medicine for a different disease — logits that drift large make the softmax a step function and the router stops learning. Dispatching per expert rather than per token is what makes an MoE a real speed-up: each expert sees one \`(n_e, D)\` matmul instead of \`n_e\` row-by-row calls, and \`index_add_\` is the scatter that puts the rows back; \`torch.where\` returning tokens in order is what lets a capacity cut agree with the slow reference. Capacity exists because experts live on different devices in a real model: every device must know its buffer size before the all-to-all, so overflow is dropped rather than queued and the residual carries the token on. Frameworks go further — Megatron-Core and DeepSpeed-MoE fuse the permute/unpermute into one sort and all-to-all, MegaBlocks turns dropless MoE into a block-sparse matmul so no capacity is needed, Mixtral and DeepSeek-V3 ship the same top-k router with \`k = 2\` and \`k = 8\`, and DeepSeek replaces the aux loss with a per-expert bias nudged by a load counter so the balancing never fights the language loss.`,
};
