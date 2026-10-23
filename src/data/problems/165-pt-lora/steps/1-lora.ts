import type {Step} from '@/lib/types';

/** The small transformer the self-test adapts: part of both files, never part of the task. */
const TINY_TRANSFORMER = `# ---- a small transformer to adapt --------------------------------------------------------------------


class Block(nn.Module):
    def __init__(self, d: int, n_heads: int):
        super().__init__()
        self.n_heads = n_heads
        self.ln1 = nn.LayerNorm(d)
        self.q_proj = nn.Linear(d, d)
        self.k_proj = nn.Linear(d, d)
        self.v_proj = nn.Linear(d, d)
        self.o_proj = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.up_proj = nn.Linear(d, 4 * d)
        self.down_proj = nn.Linear(4 * d, d)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, D = x.shape
        h = self.ln1(x)
        split = lambda t: t.view(B, T, self.n_heads, D // self.n_heads).transpose(1, 2)
        q, k, v = split(self.q_proj(h)), split(self.k_proj(h)), split(self.v_proj(h))
        att = (q @ k.transpose(-2, -1)) / math.sqrt(D // self.n_heads)
        mask = torch.triu(torch.ones(T, T, dtype=torch.bool, device=x.device), diagonal=1)
        att = att.masked_fill(mask, float("-inf")).softmax(dim=-1)
        x = x + self.o_proj((att @ v).transpose(1, 2).reshape(B, T, D))
        return x + self.down_proj(F.gelu(self.up_proj(self.ln2(x))))


class TinyTransformer(nn.Module):
    def __init__(self, vocab: int = 256, d: int = 128, n_layers: int = 2, n_heads: int = 4):
        super().__init__()
        self.embed = nn.Embedding(vocab, d)
        self.blocks = nn.ModuleList(Block(d, n_heads) for _ in range(n_layers))
        self.ln_f = nn.LayerNorm(d)
        self.lm_head = nn.Linear(d, vocab, bias=False)

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        x = self.embed(idx)
        for block in self.blocks:
            x = block(x)
        return self.lm_head(self.ln_f(x))
`;

/** The self-test both files end with: identity at init, frozen base, exact merge, adapter-only training. */
const SELF_TEST = `if __name__ == "__main__":
    torch.manual_seed(0)

    # 1. A fresh adapter is the identity: B = 0, so the wrapped layer equals the original bit for bit.
    lin = nn.Linear(64, 32)
    x = torch.randn(5, 7, 64)
    y_ref = lin(x)
    lora = LoRALinear(copy.deepcopy(lin), r=8, alpha=16)
    assert torch.equal(lora.lora_B, torch.zeros(32, 8)), "B must start at zero"
    assert torch.equal(lora(x), y_ref), "a zero-init adapter must not change the output"
    assert lora.scaling == 2.0

    # 2. Only A and B carry gradients; the base weight and bias are frozen.
    trainable = sorted(n for n, p in lora.named_parameters() if p.requires_grad)
    assert trainable == ["lora_A", "lora_B"], trainable
    lora(x).square().mean().backward()
    assert lora.base.weight.grad is None and lora.base.bias.grad is None
    assert lora.lora_B.grad is not None and lora.lora_A.grad is not None
    lora.zero_grad()

    # 3. merge() folds B @ A * scaling into the weight; the output does not change; unmerge() restores W.
    #    In float64 so the 1e-6 bound measures the fold, not float32 rounding of a 64-term dot product.
    with torch.no_grad():
        nn.init.normal_(lora.lora_B, std=0.02)
    lora64, x64 = copy.deepcopy(lora).double(), x.double()
    w0 = lora64.base.weight.detach().clone()
    y_unmerged = lora64(x64)
    lora64.merge()
    assert lora64.merged and not torch.equal(lora64.base.weight, w0)
    y_merged = lora64(x64)
    assert torch.allclose(y_merged, y_unmerged, atol=1e-6, rtol=0), (y_merged - y_unmerged).abs().max()
    lora64.unmerge()
    assert not lora64.merged
    assert torch.allclose(lora64.base.weight, w0, atol=1e-12, rtol=0), (lora64.base.weight - w0).abs().max()
    assert torch.allclose(lora64(x64), y_unmerged, atol=1e-6, rtol=0)
    lora64.merge()
    lora64.merge()  # idempotent: a second merge must not add the delta twice
    assert torch.allclose(lora64(x64), y_unmerged, atol=1e-6, rtol=0)
    lora64.unmerge()

    # 4. Adapt q_proj and v_proj of a small transformer: under 2 % of the parameters train.
    model = TinyTransformer()
    pristine = copy.deepcopy(model)
    total = sum(p.numel() for p in model.parameters())
    idx = torch.randint(0, 256, (4, 16))
    logits_before = model(idx).detach().clone()
    apply_lora(model, ["q_proj", "v_proj"], r=4, alpha=8)
    n_trainable = mark_only_lora_trainable(model)
    adapters = [m for m in model.modules() if isinstance(m, LoRALinear)]
    assert len(adapters) == 4, len(adapters)
    assert all(isinstance(b.k_proj, nn.Linear) and not isinstance(b.k_proj, LoRALinear) for b in model.blocks)
    assert n_trainable == 4 * (4 * 128 + 128 * 4), n_trainable
    assert n_trainable == sum(p.numel() for p in model.parameters() if p.requires_grad)
    fraction = n_trainable / total
    assert fraction < 0.02, fraction
    assert torch.equal(model(idx), logits_before), "applying LoRA must not change the model's function"

    # 5. A few steps of training move the adapters and nothing else.
    frozen_before = {n: p.detach().clone() for n, p in model.named_parameters() if not p.requires_grad}
    a_before = {n: p.detach().clone() for n, p in model.named_parameters() if p.requires_grad}
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-2)
    targets = torch.roll(idx, shifts=-1, dims=1)
    losses = []
    for _ in range(5):
        opt.zero_grad(set_to_none=True)
        loss = F.cross_entropy(model(idx).flatten(0, 1), targets.flatten())
        loss.backward()
        opt.step()
        losses.append(loss.item())
    assert losses[-1] < losses[0], losses
    for n, p in model.named_parameters():
        if n in frozen_before:
            assert torch.equal(p, frozen_before[n]), f"{n} moved"
        else:
            assert not torch.equal(p, a_before[n]), f"{n} did not move"

    # 6. The adapter checkpoint holds only lora_A / lora_B and reproduces the adapted model when loaded.
    sd = lora_state_dict(model)
    assert len(sd) == 8 and all(k.rsplit(".", 1)[-1] in ("lora_A", "lora_B") for k in sd), sorted(sd)
    assert sum(v.numel() for v in sd.values()) == n_trainable
    fresh = pristine
    apply_lora(fresh, ["q_proj", "v_proj"], r=4, alpha=8)
    missing, unexpected = fresh.load_state_dict(sd, strict=False)
    assert not unexpected and not any(k.rsplit(".", 1)[-1] in ("lora_A", "lora_B") for k in missing)
    assert torch.allclose(fresh(idx), model(idx), atol=1e-6, rtol=0)

    # 7. Merged inference equals adapter inference on the whole model.
    adapted = model(idx).detach().clone()
    for m in adapters:
        m.merge()
    assert torch.allclose(model(idx), adapted, atol=1e-5, rtol=0), (model(idx) - adapted).abs().max()
    print(f"trainable {n_trainable} / {total} = {100 * fraction:.2f} %")
    print("PASS")
`;

const HEADER = `"""LoRA: low-rank adapters on frozen linear layers: zero-init, scaled forward, merge/unmerge, adapter-only training."""

import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F
`;

export const loraStep: Step = {
  id: 'lora',
  title: 'LoRALinear, apply_lora, mark_only_lora_trainable, merge/unmerge',
  concept: 'pytorch',
  file: 'lora',
  focus: ['base', 'lora-a', 'lora-b', 'scale', 'add-lora'],
  task: `## Task

Implement \`LoRALinear\`, \`apply_lora\`, \`mark_only_lora_trainable\` and \`lora_state_dict\` so that a frozen
\`nn.Linear\` gets a trainable rank-\`r\` update that starts at zero, costs \`r · (in + out)\` parameters, and
can be folded into the weight for inference and unfolded again.

- \`LoRALinear(base: nn.Linear, r: int, alpha: float, dropout: float = 0.0)\`: keep \`base\` as a submodule and
  freeze it with \`base.requires_grad_(False)\`. \`self.lora_A\` is \`nn.Parameter\` of shape \`(r, in_features)\`,
  initialised \`nn.init.kaiming_uniform_(…, a=math.sqrt(5))\` (Gaussian is also fine); \`self.lora_B\` is
  \`nn.Parameter(torch.zeros(out_features, r))\`. \`self.scaling = alpha / r\`; \`self.dropout\` is
  \`nn.Dropout(dropout)\` (or \`nn.Identity()\` when 0); \`self.merged = False\`.
- \`forward(x)\` → \`base(x) + (self.dropout(x) @ self.lora_A.T @ self.lora_B.T) * self.scaling\`, for \`x\` of any
  leading shape \`(…, in_features)\`. Multiply through **A first, then B**: never form \`B @ A\` (an
  \`out × in\` matrix) on the forward path. When \`self.merged\` is set, return \`base(x)\` alone.
- \`merge()\`: under \`torch.no_grad\`, \`base.weight += (lora_B @ lora_A) * scaling\`, set \`merged\`; a second
  call is a no-op. \`unmerge()\`: subtract the same delta, clear \`merged\`; a no-op when not merged. After
  \`merge()\` the output must match the unmerged output within \`1e-6\` (the self-test checks in float64), and
  \`unmerge()\` must return \`base.weight\` to its original values within \`1e-12\`.
- \`apply_lora(model, target_names, r, alpha, dropout=0.0)\`: walk \`model.named_modules()\`, and for every
  \`nn.Linear\` whose attribute name (the last dotted component, e.g. \`q_proj\`) is in \`target_names\`,
  \`setattr\` a \`LoRALinear\` wrapping *that same module* onto its parent, **in place**: no copy of the model,
  no re-initialised weights. Return \`model\`.
- \`mark_only_lora_trainable(model)\`: set \`requires_grad\` to \`True\` on every parameter whose name contains
  \`lora_\` and \`False\` on every other; return the number of trainable scalars.
- \`lora_state_dict(model)\`: the entries of \`model.state_dict()\` whose key contains \`lora_\`, i.e. the adapter
  checkpoint, loadable with \`load_state_dict(…, strict=False)\` into a freshly \`apply_lora\`'d copy of the
  base model.
- No \`peft\`, no \`loralib\`; \`torch\` only.

Size the adapter against the layer it wraps: drag the rank and the layer width and compare the trainable
\`r · (in + out)\` with the frozen \`in · out\`.

:::widget lora-rank

The file ends with a self-test: a zero-init adapter is the identity (\`torch.equal\`); only \`lora_A\` / \`lora_B\`
get gradients; merge/unmerge round-trips; adapting \`q_proj\` and \`v_proj\` of a two-block \`d = 128\`
transformer with \`r = 4\` trains \`4096\` of \`462336\` parameters (0.89 %, must be below 2 %); five
\`AdamW\` steps move every adapter tensor and no frozen one; the adapter checkpoint has eight tensors and
reproduces the adapted model; merged whole-model inference matches within \`1e-5\`. It prints \`PASS\`.

> Fine-tuning a layer is adding a matrix to its weight. LoRA bets that matrix is low-rank, writes it as
> \`B @ A\` with \`B = 0\` at the start, trains only \`A\` and \`B\`, and folds them into \`W\` when training ends,
> so training touches 1 % of the parameters and inference pays nothing.`,
  hints: [
    'The adapter is two small parameters next to the frozen layer: `lora_A` of shape `(r, in)` with a Kaiming init and `lora_B` of shape `(out, r)` all zeros, so `x @ A.T @ B.T` is zero at step 0 and the wrapped layer answers exactly what the original did. `base.requires_grad_(False)` freezes both weight and bias in one call.',
    'Forward is `base(x) + (dropout(x) @ lora_A.T @ lora_B.T) * scaling`: two thin matmuls `(…, in) → (…, r) → (…, out)`. `merge()` is the dense version of the same product, `base.weight += (lora_B @ lora_A) * scaling` under `torch.no_grad()`, guarded by a `merged` flag so it cannot be applied twice; `unmerge()` subtracts it.',
    'Finish the walk before you mutate: collect the `(name, module)` hits from `named_modules()` first, then resolve each parent from `name.rpartition(".")` with `get_submodule` and `setattr` the wrapper onto it. The new parameter names (`blocks.0.q_proj.lora_A`) carry `"lora_"`, which is all `mark_only_lora_trainable` and `lora_state_dict` need to filter on.',
  ],
  checks: [
    {
      id: 'frozen-base',
      title: 'The wrapped nn.Linear is kept and frozen',
      detail:
        '`LoRALinear` keeps the original layer as `self.base` and calls `requires_grad_(False)` on it, so neither its weight nor its bias receives a gradient; the self-test asserts `base.weight.grad is None` after `backward()`.',
      match: {
        python: {all: [/self\.base\s*=\s*base\b/, /base\.requires_grad_\(\s*False\s*\)/]},
      },
    },
    {
      id: 'zero-init',
      title: 'lora_B starts at zero, lora_A at a Kaiming or Gaussian init',
      detail:
        'An adapter must be the identity before training: `lora_B = nn.Parameter(torch.zeros(out, r))` makes `x @ A.T @ B.T` vanish, and `nn.init.kaiming_uniform_` / `nn.init.normal_` on `lora_A` keeps `B`’s first gradient well scaled. Two zero matrices would never move.',
      match: {
        python: {
          all: [
            /self\.lora_B\s*=\s*nn\.Parameter\(\s*torch\.zeros\(/,
            /nn\.init\.(kaiming_uniform_|normal_)\(\s*self\.lora_A/,
          ],
        },
      },
    },
    {
      id: 'scaled-low-rank-forward',
      title: 'forward adds dropout(x) @ Aᵀ @ Bᵀ scaled by alpha / r, A first',
      detail:
        '`self.scaling = alpha / r` and the forward path multiplies through `lora_A` then `lora_B` on the activations (two thin matmuls), never forming `lora_B @ lora_A` (or calling `delta_weight()`) inside `forward`.',
      match: {
        python: {
          all: [
            /self\.scaling\s*=\s*(self\.)?alpha\s*\/\s*(self\.)?r\b/,
            /self\.dropout\(\s*x\s*\)\s*@\s*self\.lora_A\.(T|t\(\))\s*@\s*self\.lora_B\.(T|t\(\))|F\.linear\(\s*F\.linear\(\s*self\.dropout\(\s*x\s*\)\s*,\s*self\.lora_A\s*\)\s*,\s*self\.lora_B\s*\)/,
            /\)\s*\*\s*self\.scaling/,
          ],
          none: [/def forward\((?:(?!\n {4}def )[\s\S])*?(self\.lora_B\s*@\s*self\.lora_A|delta_weight\(\))/],
        },
      },
    },
    {
      id: 'merge-folds-delta',
      title: 'merge() adds (lora_B @ lora_A) · scaling into base.weight under no_grad, once',
      detail:
        '`merge()` forms the dense delta `lora_B @ lora_A` scaled by `alpha / r`, adds it to `base.weight` in place without recording autograd history, and sets `self.merged = True` so a second call does nothing; the merged output must match the unmerged one within `1e-6`.',
      match: {
        python: {
          all: [
            /def merge\(/,
            /self\.lora_B\s*@\s*self\.lora_A/,
            /self\.base\.weight\s*(\+=|\.add_\()/,
            /self\.merged\s*=\s*True/,
            /@torch\.no_grad\(\)|with torch\.no_grad\(\)/,
          ],
        },
      },
    },
    {
      id: 'unmerge-restores',
      title: 'unmerge() subtracts the same delta and clears the flag',
      detail:
        '`unmerge()` does `base.weight -= delta` and sets `self.merged = False`, guarded so it is a no-op when nothing is merged; the weight returns to its original values within `1e-12` in float64.',
      match: {
        python: {
          all: [
            /def unmerge\(/,
            /self\.base\.weight\s*(-=|\.sub_\()/,
            /self\.merged\s*=\s*False/,
            /if\s+(not\s+)?self\.merged\b/,
          ],
        },
      },
    },
    {
      id: 'apply-in-place',
      title: 'apply_lora swaps the named nn.Linear modules in place',
      detail:
        '`apply_lora` walks `model.named_modules()`, matches `nn.Linear` instances by attribute name, and `setattr`s a `LoRALinear(module, r, alpha, …)` wrapping that same module onto its parent: the model’s weights are untouched and `k_proj` stays a plain `nn.Linear`.',
      match: {
        python: {
          all: [
            /def apply_lora\(/,
            /\.named_modules\(\)/,
            /isinstance\(\s*\w+\s*,\s*nn\.Linear\s*\)/,
            /setattr\(/,
            /LoRALinear\(\s*\w+\s*,\s*r\s*,\s*alpha/,
          ],
        },
      },
    },
    {
      id: 'only-lora-trainable',
      title: 'Only lora_ parameters train, and only they are checkpointed',
      detail:
        '`mark_only_lora_trainable` sets `requires_grad_` by `"lora_" in name` over `named_parameters()` and returns the trainable `numel()` sum (4096 of 462336 here); `lora_state_dict` filters `state_dict().items()` by the same substring, giving eight tensors.',
      match: {
        python: {
          all: [
            /def mark_only_lora_trainable\(/,
            /\.named_parameters\(\)/,
            /["']lora_["']\s+in\s+\w+/,
            /\.requires_grad_\(/,
            /\.numel\(\)/,
            /def lora_state_dict\(/,
            /\.state_dict\(\)\.items\(\)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `${HEADER}

class LoRALinear(nn.Module):
    """\`base\` frozen; \`y = base(x) + (dropout(x) @ A.T @ B.T) * alpha / r\`, with B = 0 at start so the wrap is the identity."""

    def __init__(self, base: nn.Linear, r: int, alpha: float, dropout: float = 0.0):
        super().__init__()
        # TODO: keep and freeze base; lora_A (r, in) Kaiming-uniform, lora_B (out, r) zeros; scaling, dropout, merged flag
        raise NotImplementedError("TODO")

    def delta_weight(self) -> torch.Tensor:
        """The dense update the adapter stands for: (out, in) = B @ A, scaled."""
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: base(x) + (dropout(x) @ A.T @ B.T) * scaling; base(x) alone when merged
        raise NotImplementedError("TODO")

    def merge(self) -> None:
        """Fold B @ A * scaling into the base weight: one matmul per call afterwards."""
        raise NotImplementedError("TODO")

    def unmerge(self) -> None:
        """Subtract the same delta back out; the base weight is the original again."""
        raise NotImplementedError("TODO")

    def extra_repr(self) -> str:
        return f"r={self.r}, alpha={self.alpha}, merged={self.merged}"


def apply_lora(model: nn.Module, target_names, r: int, alpha: float, dropout: float = 0.0) -> nn.Module:
    """Replace every \`nn.Linear\` whose attribute name is in \`target_names\` with a \`LoRALinear\`, in place."""
    raise NotImplementedError("TODO")


def mark_only_lora_trainable(model: nn.Module) -> int:
    """Freeze everything except \`lora_A\` / \`lora_B\`; return the number of trainable scalars."""
    raise NotImplementedError("TODO")


def lora_state_dict(model: nn.Module) -> dict:
    """Only the adapter tensors: what a LoRA checkpoint ships."""
    raise NotImplementedError("TODO")


${TINY_TRANSFORMER}

${SELF_TEST}`,
      solution: `${HEADER}

class LoRALinear(nn.Module):
    """\`base\` frozen; \`y = base(x) + (dropout(x) @ A.T @ B.T) * alpha / r\`, with B = 0 at start so the wrap is the identity."""

    def __init__(self, base: nn.Linear, r: int, alpha: float, dropout: float = 0.0):
        super().__init__()
        if r <= 0:
            raise ValueError("r must be positive")
        self.base = base
        self.base.requires_grad_(False)
        self.r = r
        self.alpha = alpha
        self.scaling = alpha / r
        self.dropout = nn.Dropout(dropout) if dropout > 0.0 else nn.Identity()
        self.lora_A = nn.Parameter(torch.empty(r, base.in_features, dtype=base.weight.dtype))
        self.lora_B = nn.Parameter(torch.zeros(base.out_features, r, dtype=base.weight.dtype))
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))
        self.merged = False

    def delta_weight(self) -> torch.Tensor:
        """The dense update the adapter stands for: (out, in) = B @ A, scaled."""
        return (self.lora_B @ self.lora_A) * self.scaling

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.base(x)
        if self.merged:
            return out
        return out + (self.dropout(x) @ self.lora_A.T @ self.lora_B.T) * self.scaling

    @torch.no_grad()
    def merge(self) -> None:
        """Fold B @ A * scaling into the base weight: one matmul per call afterwards."""
        if self.merged:
            return
        self.base.weight += self.delta_weight()
        self.merged = True

    @torch.no_grad()
    def unmerge(self) -> None:
        """Subtract the same delta back out; the base weight is the original again."""
        if not self.merged:
            return
        self.base.weight -= self.delta_weight()
        self.merged = False

    def extra_repr(self) -> str:
        return f"r={self.r}, alpha={self.alpha}, merged={self.merged}"


def apply_lora(model: nn.Module, target_names, r: int, alpha: float, dropout: float = 0.0) -> nn.Module:
    """Replace every \`nn.Linear\` whose attribute name is in \`target_names\` with a \`LoRALinear\`, in place."""
    targets = set(target_names)
    hits = [
        (name, module)
        for name, module in model.named_modules()
        if isinstance(module, nn.Linear) and name.rsplit(".", 1)[-1] in targets
    ]
    for name, module in hits:
        parent_path, _, attr = name.rpartition(".")
        parent = model.get_submodule(parent_path) if parent_path else model
        setattr(parent, attr, LoRALinear(module, r, alpha, dropout))
    return model


def mark_only_lora_trainable(model: nn.Module) -> int:
    """Freeze everything except \`lora_A\` / \`lora_B\`; return the number of trainable scalars."""
    trainable = 0
    for name, param in model.named_parameters():
        is_lora = "lora_" in name
        param.requires_grad_(is_lora)
        if is_lora:
            trainable += param.numel()
    return trainable


def lora_state_dict(model: nn.Module) -> dict:
    """Only the adapter tensors: what a LoRA checkpoint ships."""
    return {k: v.detach().clone() for k, v in model.state_dict().items() if "lora_" in k}


${TINY_TRANSFORMER}

${SELF_TEST}`,
    },
  },
  debrief: `The whole design follows from one equation: a fine-tuned weight is \`W + ΔW\`, and LoRA writes \`ΔW = B @ A · alpha / r\` with \`A\` of shape \`(r, in)\` and \`B\` of shape \`(out, r)\`. Three consequences shape the code. **Zero-init \`B\`** makes the adapter the identity at step 0: the model starts exactly where pre-training left it, and \`A\`'s Kaiming init is what gives \`B\` a well-scaled first gradient (two zero matrices would never move, because \`∂L/∂A ∝ B\` and \`∂L/∂B ∝ A\`). **The forward path never forms \`ΔW\`**: \`x @ A.T\` is \`(…, r)\`, then \`@ B.T\` is \`(…, out)\`, so the adapter path costs \`r · (in + out)\` multiply-adds per token instead of \`in · out\`, and the only extra memory is the two small matrices plus their gradients and Adam moments, which is why a 7B model adapts on one 24 GB card while full fine-tuning needs 16 bytes per parameter. **Merging is exact**: because \`ΔW\` is a plain matrix, \`W += ΔW\` under \`no_grad\` turns the adapted layer back into a single \`nn.Linear\` with zero inference overhead, and \`W -= ΔW\` returns it (float64 to \`1e-12\`, float32 to rounding error, bf16 not at all, which is why production merges once, into the checkpoint, not on every request). The surgery is done **in place** by \`setattr\` on the parent module so the base weights are the base weights (reused across adapters, never re-initialised), and the parameter names (\`blocks.0.q_proj.lora_A\`) carry the \`lora_\` substring that selects what trains and what ships: an adapter checkpoint for a 7B model is tens of megabytes, not 14 GB. What frameworks add: Hugging Face PEFT wraps exactly this (\`LoraConfig(r, lora_alpha, lora_dropout, target_modules)\`, \`merge_and_unload()\`), QLoRA keeps the frozen base in 4-bit NF4 and dequantises on the fly so \`W\` costs half a byte per weight, rsLoRA scales by \`alpha / sqrt(r)\` so large ranks train stably, DoRA splits the update into magnitude and direction, and serving systems (S-LoRA, Punica, vLLM's multi-LoRA) keep one base model resident and batch requests across thousands of unmerged adapters with a custom gather-matmul kernel: the one case where *not* merging is the point.`,
};
