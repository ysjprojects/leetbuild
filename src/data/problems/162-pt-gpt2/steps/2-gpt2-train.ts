import type {Step} from '@/lib/types';

export const gpt2TrainStep: Step = {
  id: 'gpt2-train',
  title: 'Training: decay groups, warmup + cosine, clipping, bf16, checkpoints',
  concept: 'pytorch',
  file: 'gpt2_train',
  focus: ['tokens', 'head', 'train'],
  task: `## Task

Train the step-1 model the way nanoGPT trains GPT-2 small (\`from gpt2_model import GPT, GPTConfig\`).
Use \`torch.optim.AdamW\` itself — the optimizer is not the point here; how it is fed is.

- \`configure_optimizers(model, weight_decay, lr, betas) -> torch.optim.AdamW\`: two parameter groups
  from \`model.parameters()\` (the tied \`wte\`/\`lm_head\` tensor appears once) — every parameter with
  \`p.dim() >= 2\` (Linear weights, both embedding tables) gets \`weight_decay\`, every \`p.dim() < 2\`
  (biases, LayerNorm gains and shifts) gets \`0.0\`. \`fused=True\` when every parameter is on CUDA.
- \`get_batch(data, block_size, batch_size, device="cpu") -> (x, y)\`: \`data\` is a 1-D \`long\` token
  tensor; \`batch_size\` random start offsets from \`torch.randint(len(data) - block_size, …)\`;
  \`x[b] = data[i : i + block_size]\`, \`y[b] = data[i + 1 : i + 1 + block_size]\`, both \`(B, block_size)\`.
- \`get_lr(it, warmup_iters, lr_decay_iters, max_lr, min_lr)\`: \`max_lr · (it + 1) / warmup_iters\` while
  \`it < warmup_iters\`; then \`min_lr + ½(1 + cos(π · ratio)) · (max_lr − min_lr)\` with
  \`ratio = (it − warmup) / (decay − warmup)\`; \`min_lr\` from \`lr_decay_iters\` on.
- \`autocast_ctx(device)\`: \`torch.autocast(device_type="cuda", dtype=torch.bfloat16)\` when the device
  is CUDA and \`torch.cuda.is_bf16_supported()\`, else \`contextlib.nullcontext()\`. No \`GradScaler\`, no
  \`.half()\`: bf16 keeps fp32's exponent range, and the weights stay fp32.
- \`@torch.no_grad() estimate_loss(model, splits, batch_size, eval_iters, device="cpu") -> dict\`: for
  each named split, the mean loss of \`eval_iters\` batches under \`model.eval()\`; \`model.train()\` on exit.
- \`train(model, train_data, val_data, max_iters, batch_size=12, max_lr=6e-4, min_lr=6e-5,
  warmup_iters=100, weight_decay=0.1, betas=(0.9, 0.95), grad_clip=1.0, eval_interval=100,
  eval_iters=20, ckpt_path=None, device="cpu") -> list[float]\`: per iteration set \`group["lr"]\` for
  every group from \`get_lr(it, warmup_iters, max_iters, …)\`; every \`eval_interval\` iterations (and on
  the last) estimate both losses and, when \`val\` improves and \`ckpt_path\` is set, \`torch.save\`
  \`{"model": state_dict, "optimizer": state_dict, "config": asdict(config), "step": it}\`; then batch →
  forward under autocast → \`zero_grad(set_to_none=True)\` → \`backward\` →
  \`clip_grad_norm_(model.parameters(), grad_clip)\` → \`optimizer.step()\`. Return every training loss.

The self-test checks the groups (\`2 + 4 · n_layer\` matrices decay, all vectors do not, the sizes sum to
\`num_params(non_embedding=False)\`), that windows are contiguous and targets shifted by one, the schedule's
endpoints and midpoint, then overfits a periodic token stream (\`randperm(16)\` repeated) with a 2-layer,
32-wide model for 300 iterations: the first loss is above 2.0 (≈ ln 16), the final validation loss below
0.05. It reloads the checkpoint with \`torch.load(…, weights_only=True)\` into a fresh \`GPT\` and prints \`PASS\`.

> A training loop is mostly bookkeeping around three lines — forward, backward, step — and each piece of
> bookkeeping (which tensors decay, how big a step may be, how fast the learning rate moves) is a
> stability decision made once for every run.`,
  sequence: {
    participants: ['train()', 'get_batch', 'GPT', 'AdamW', 'checkpoint'],
    messages: [
      {from: 'train()', to: 'AdamW', label: 'group["lr"] = get_lr(it): warmup, then cosine', kind: 'sync'},
      {from: 'train()', to: 'GPT', label: 'every eval_interval: estimate_loss (no_grad, eval)', kind: 'sync'},
      {
        from: 'train()',
        to: 'checkpoint',
        label: 'val improved → torch.save({model, optimizer, config, step})',
        kind: 'async',
      },
      {from: 'train()', to: 'get_batch', label: 'random windows of block_size + 1 tokens', kind: 'sync'},
      {from: 'get_batch', to: 'train()', label: 'x, y = window[:-1], window[1:]', kind: 'reply'},
      {from: 'train()', to: 'GPT', label: 'autocast(bf16): logits, loss = model(x, y)', kind: 'sync'},
      {from: 'train()', to: 'GPT', label: 'zero_grad · loss.backward() · clip_grad_norm_(…, 1.0)', kind: 'sync'},
      {from: 'train()', to: 'AdamW', label: 'step(): decay on matrices only', kind: 'sync'},
    ],
  },
  hints: [
    'The groups are a list of dicts — `[{"params": decay, "weight_decay": wd}, {"params": no_decay, "weight_decay": 0.0}]` — passed as AdamW\'s first argument; `model.parameters()` already yields the tied tensor once, so no de-duplication is needed.',
    'Shift by slicing the stream, not the batch: `y` is `data[i + 1 : i + 1 + block_size]`. The schedule is set by hand each iteration (`for group in optimizer.param_groups: group["lr"] = lr`), which is why `torch.optim.lr_scheduler` is not needed.',
    'Clip after `backward` and before `step`, on all parameters at once (one global norm). Save `asdict(model.config)` rather than the dataclass: `torch.load(weights_only=True)`, the default since PyTorch 2.6, refuses arbitrary classes.',
  ],
  checks: [
    {
      id: 'decay-groups',
      title: 'Weight decay on matrices only',
      detail:
        'Parameters are split by `p.dim() >= 2` and `p.dim() < 2` into two groups, the second with `"weight_decay": 0.0`: decaying LayerNorm gains and biases pulls them towards zero for no regularisation benefit.',
      match: {python: {all: [/p\.dim\(\)\s*>=\s*2/, /p\.dim\(\)\s*<\s*2/, /"weight_decay":\s*0\.0/]}},
    },
    {
      id: 'adamw',
      title: 'torch.optim.AdamW over the groups',
      detail:
        '`torch.optim.AdamW(groups, lr=lr, betas=betas, …)` — decoupled decay, GPT-2’s `betas=(0.9, 0.95)` passed through. Plain `Adam` (L2 in the gradient) or SGD is not the recipe.',
      match: {python: {all: [/torch\.optim\.AdamW\(/], none: [/torch\.optim\.Adam\(/, /torch\.optim\.SGD\(/]}},
    },
    {
      id: 'windows',
      title: 'Random contiguous windows, targets shifted by one',
      detail:
        'Offsets from `torch.randint(len(data) - block_size, (batch_size,))`; `x` stacks `data[i : i + block_size]` and `y` stacks `data[i + 1 : i + 1 + block_size]` — every position of every window is a training example.',
      match: {
        python: {
          all: [
            /torch\.randint\(\s*len\(data\)\s*-\s*block_size/,
            /torch\.stack\(/,
            /\[\s*i\s*\+\s*1\s*:\s*i\s*\+\s*(?:1\s*\+\s*block_size|block_size\s*\+\s*1)\s*\]/,
          ],
        },
      },
    },
    {
      id: 'schedule',
      title: 'Linear warmup, cosine decay, set on every group',
      detail:
        '`it < warmup_iters` ramps linearly; after it `0.5 * (1 + math.cos(math.pi * ratio))` interpolates to `min_lr`; the value is written into `group["lr"]` of every parameter group each iteration.',
      match: {python: {all: [/it\s*<\s*warmup_iters/, /math\.cos\(\s*math\.pi\s*\*/, /group\["lr"\]\s*=\s*lr/]}},
    },
    {
      id: 'clip-order',
      title: 'zero_grad → backward → clip at 1.0 → step',
      detail:
        '`clip_grad_norm_(model.parameters(), grad_clip)` with `grad_clip: float = 1.0`, after `loss.backward()` and before `optimizer.step()` — clipping before backward clips nothing, after step is too late.',
      match: {
        python: {
          all: [/clip_grad_norm_\(\s*model\.parameters\(\)\s*,\s*grad_clip\s*\)/, /grad_clip:\s*float\s*=\s*1\.0/],
          order: [/zero_grad\(/, /\.backward\(\)/, /clip_grad_norm_\(/, /optimizer\.step\(\)/],
        },
      },
    },
    {
      id: 'eval-mode',
      title: 'Evaluation without a graph, in eval mode',
      detail:
        '`estimate_loss` is decorated `@torch.no_grad()`, switches to `model.eval()` (dropout off) and back to `model.train()` before returning.',
      match: {python: {all: [/@torch\.no_grad\(\)\s*\ndef estimate_loss\(/, /model\.eval\(\)/, /model\.train\(\)/]}},
    },
    {
      id: 'bf16-autocast',
      title: 'bfloat16 autocast when the GPU has it, no loss scaling',
      detail:
        '`torch.autocast(device_type="cuda", dtype=torch.bfloat16)` guarded by `torch.cuda.is_bf16_supported()` and used around the forward. bf16 has fp32’s exponent, so neither `GradScaler` nor `.half()` weights belong here.',
      match: {
        python: {
          all: [
            /torch\.autocast\(\s*device_type\s*=\s*"cuda"\s*,\s*dtype\s*=\s*torch\.bfloat16/,
            /torch\.cuda\.is_bf16_supported\(\)/,
            /with autocast_ctx\(/,
          ],
          none: [/GradScaler\(/, /\.half\(\)/],
        },
      },
    },
    {
      id: 'checkpoint',
      title: 'Checkpoint holds model, optimizer, config and step',
      detail:
        '`torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "config": …, "step": it}, ckpt_path)` — without the optimizer’s moments a resumed run restarts AdamW cold; without the config the weights cannot be rebuilt.',
      match: {
        python: {
          all: [
            /torch\.save\(/,
            /"model":\s*model\.state_dict\(\)/,
            /"optimizer":\s*optimizer\.state_dict\(\)/,
            /"config":/,
            /"step":\s*it\b/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Training GPT-2: decay groups for AdamW, random windows, warmup + cosine, clipping, bf16 autocast, checkpoints."""

import contextlib
import math
import os
import tempfile
from dataclasses import asdict

import torch

from gpt2_model import GPT, GPTConfig


def configure_optimizers(model: GPT, weight_decay: float, lr: float, betas: tuple[float, float]) -> torch.optim.AdamW:
    """AdamW with two groups: matrices (Linear weights, embeddings) decay; biases and LayerNorm gains do not."""
    # TODO: split model.parameters() by p.dim(); two groups (weight_decay, 0.0); fused AdamW on CUDA.
    raise NotImplementedError("TODO")


def get_batch(data: torch.Tensor, block_size: int, batch_size: int, device: str = "cpu"):
    """\`batch_size\` random contiguous windows of a 1-D token tensor; targets are the inputs shifted by one."""
    # TODO: random start offsets; x = data[i : i + block_size], y = the same window one token later.
    raise NotImplementedError("TODO")


def get_lr(it: int, warmup_iters: int, lr_decay_iters: int, max_lr: float, min_lr: float) -> float:
    """Linear warmup to \`max_lr\`, cosine decay to \`min_lr\` at \`lr_decay_iters\`, then flat."""
    raise NotImplementedError("TODO")


def autocast_ctx(device: str):
    """bfloat16 autocast where the GPU supports it, a no-op context otherwise."""
    raise NotImplementedError("TODO")


# TODO: no autograd graph while evaluating.
def estimate_loss(model: GPT, splits: dict, batch_size: int, eval_iters: int, device: str = "cpu") -> dict:
    """Mean loss over \`eval_iters\` random batches of each split, in eval mode (dropout off)."""
    raise NotImplementedError("TODO")


def train(
    model: GPT,
    train_data: torch.Tensor,
    val_data: torch.Tensor,
    max_iters: int,
    batch_size: int = 12,
    max_lr: float = 6e-4,
    min_lr: float = 6e-5,
    warmup_iters: int = 100,
    weight_decay: float = 0.1,
    betas: tuple[float, float] = (0.9, 0.95),
    grad_clip: float = 1.0,
    eval_interval: int = 100,
    eval_iters: int = 20,
    ckpt_path: str | None = None,
    device: str = "cpu",
) -> list[float]:
    """The nanoGPT loop; returns the training loss of every iteration."""
    # TODO: optimizer; per iteration set the lr of every group, evaluate and checkpoint every
    # eval_interval (and on the last iteration) when val improves, then batch -> autocast forward ->
    # zero_grad -> backward -> clip to grad_clip -> step.
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    V, L = 16, 8
    config = GPTConfig(vocab_size=V, block_size=L, n_layer=2, n_head=2, n_embd=32, dropout=0.0)
    model = GPT(config)

    # Parameter groups: every matrix decays, every vector does not, the tied tensor appears once.
    opt = configure_optimizers(model, weight_decay=0.1, lr=1e-3, betas=(0.9, 0.95))
    decay, no_decay = opt.param_groups
    assert decay["weight_decay"] == 0.1 and no_decay["weight_decay"] == 0.0
    assert all(p.dim() >= 2 for p in decay["params"]) and all(p.dim() < 2 for p in no_decay["params"])
    assert len(decay["params"]) == 2 + 4 * config.n_layer  # wte (= lm_head), wpe, c_attn, c_proj, c_fc, c_proj
    assert sum(p.numel() for g in opt.param_groups for p in g["params"]) == model.num_params(non_embedding=False)
    assert opt.param_groups[0]["betas"] == (0.9, 0.95)

    # Windows are contiguous slices of the stream; targets are the inputs shifted by one.
    stream = torch.arange(100)
    x, y = get_batch(stream, L, 5)
    assert x.shape == y.shape == (5, L) and x.dtype == torch.long
    assert torch.equal(y, x + 1) and torch.equal(x[:, 1:] - x[:, :-1], torch.ones(5, L - 1, dtype=torch.long))

    # The schedule: linear warmup to max_lr, cosine down to min_lr, flat after.
    lrs = [get_lr(it, 10, 100, 1e-3, 1e-4) for it in range(120)]
    assert math.isclose(lrs[0], 1e-4) and math.isclose(lrs[9], 1e-3)
    assert all(a >= b for a, b in zip(lrs[10:100], lrs[11:101]))
    assert math.isclose(lrs[55], 0.5 * (1e-3 + 1e-4)) and math.isclose(lrs[119], 1e-4)

    # Overfit a periodic sequence: the next token is a function of the current one.
    perm = torch.randperm(V)
    data = perm.repeat(64)
    with tempfile.TemporaryDirectory() as tmp:
        ckpt_path = os.path.join(tmp, "ckpt.pt")
        history = train(
            model, data[:768], data[768:], max_iters=300, batch_size=16, max_lr=3e-3, min_lr=3e-4,
            warmup_iters=20, eval_interval=50, eval_iters=5, ckpt_path=ckpt_path,
        )
        assert history[0] > 2.0, history[0]
        final = estimate_loss(model, {"val": data[768:]}, batch_size=16, eval_iters=5)["val"]
        assert final < 0.05, final

        # The checkpoint restores a model from nothing but its own contents.
        ckpt = torch.load(ckpt_path, weights_only=True)
        assert set(ckpt) == {"model", "optimizer", "config", "step"} and ckpt["step"] > 0
        restored = GPT(GPTConfig(**ckpt["config"]))
        restored.load_state_dict(ckpt["model"])
        assert restored.lm_head.weight is restored.transformer.wte.weight
        assert len(ckpt["optimizer"]["param_groups"]) == 2
    print(f"loss {history[0]:.3f} -> {final:.4f}")
    print("PASS")
`,
      solution: `"""Training GPT-2: decay groups for AdamW, random windows, warmup + cosine, clipping, bf16 autocast, checkpoints."""

import contextlib
import math
import os
import tempfile
from dataclasses import asdict

import torch

from gpt2_model import GPT, GPTConfig


def configure_optimizers(model: GPT, weight_decay: float, lr: float, betas: tuple[float, float]) -> torch.optim.AdamW:
    """AdamW with two groups: matrices (Linear weights, embeddings) decay; biases and LayerNorm gains do not."""
    params = [p for p in model.parameters() if p.requires_grad]  # the tied weight appears once
    decay = [p for p in params if p.dim() >= 2]
    no_decay = [p for p in params if p.dim() < 2]
    groups = [
        {"params": decay, "weight_decay": weight_decay},
        {"params": no_decay, "weight_decay": 0.0},
    ]
    fused = all(p.is_cuda for p in params)  # one multi-tensor kernel per step on the GPU
    return torch.optim.AdamW(groups, lr=lr, betas=betas, fused=fused)


def get_batch(data: torch.Tensor, block_size: int, batch_size: int, device: str = "cpu"):
    """\`batch_size\` random contiguous windows of a 1-D token tensor; targets are the inputs shifted by one."""
    ix = torch.randint(len(data) - block_size, (batch_size,))
    x = torch.stack([data[i : i + block_size] for i in ix])
    y = torch.stack([data[i + 1 : i + 1 + block_size] for i in ix])
    return x.to(device), y.to(device)


def get_lr(it: int, warmup_iters: int, lr_decay_iters: int, max_lr: float, min_lr: float) -> float:
    """Linear warmup to \`max_lr\`, cosine decay to \`min_lr\` at \`lr_decay_iters\`, then flat."""
    if it < warmup_iters:
        return max_lr * (it + 1) / warmup_iters
    if it >= lr_decay_iters:
        return min_lr
    ratio = (it - warmup_iters) / (lr_decay_iters - warmup_iters)
    coeff = 0.5 * (1.0 + math.cos(math.pi * ratio))
    return min_lr + coeff * (max_lr - min_lr)


def autocast_ctx(device: str):
    """bfloat16 autocast where the GPU supports it (no GradScaler: bf16 has fp32's exponent range)."""
    if str(device).startswith("cuda") and torch.cuda.is_bf16_supported():
        return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    return contextlib.nullcontext()


@torch.no_grad()
def estimate_loss(model: GPT, splits: dict, batch_size: int, eval_iters: int, device: str = "cpu") -> dict:
    """Mean loss over \`eval_iters\` random batches of each split, in eval mode (dropout off)."""
    out = {}
    model.eval()
    for name, data in splits.items():
        losses = torch.zeros(eval_iters)
        for k in range(eval_iters):
            x, y = get_batch(data, model.config.block_size, batch_size, device)
            with autocast_ctx(device):
                _, loss = model(x, y)
            losses[k] = loss.item()
        out[name] = losses.mean().item()
    model.train()
    return out


def train(
    model: GPT,
    train_data: torch.Tensor,
    val_data: torch.Tensor,
    max_iters: int,
    batch_size: int = 12,
    max_lr: float = 6e-4,
    min_lr: float = 6e-5,
    warmup_iters: int = 100,
    weight_decay: float = 0.1,
    betas: tuple[float, float] = (0.9, 0.95),
    grad_clip: float = 1.0,
    eval_interval: int = 100,
    eval_iters: int = 20,
    ckpt_path: str | None = None,
    device: str = "cpu",
) -> list[float]:
    """The nanoGPT loop; returns the training loss of every iteration."""
    model.to(device)
    model.train()
    optimizer = configure_optimizers(model, weight_decay, max_lr, betas)
    best_val = float("inf")
    history = []
    for it in range(max_iters):
        lr = get_lr(it, warmup_iters, max_iters, max_lr, min_lr)
        for group in optimizer.param_groups:
            group["lr"] = lr

        if it % eval_interval == 0 or it == max_iters - 1:
            losses = estimate_loss(model, {"train": train_data, "val": val_data}, batch_size, eval_iters, device)
            if ckpt_path is not None and losses["val"] < best_val:
                best_val = losses["val"]
                checkpoint = {
                    "model": model.state_dict(),
                    "optimizer": optimizer.state_dict(),
                    "config": asdict(model.config),  # plain dict: loads with weights_only=True
                    "step": it,
                }
                torch.save(checkpoint, ckpt_path)

        x, y = get_batch(train_data, model.config.block_size, batch_size, device)
        with autocast_ctx(device):
            _, loss = model(x, y)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        optimizer.step()
        history.append(loss.item())
    return history


if __name__ == "__main__":
    torch.manual_seed(0)
    V, L = 16, 8
    config = GPTConfig(vocab_size=V, block_size=L, n_layer=2, n_head=2, n_embd=32, dropout=0.0)
    model = GPT(config)

    # Parameter groups: every matrix decays, every vector does not, the tied tensor appears once.
    opt = configure_optimizers(model, weight_decay=0.1, lr=1e-3, betas=(0.9, 0.95))
    decay, no_decay = opt.param_groups
    assert decay["weight_decay"] == 0.1 and no_decay["weight_decay"] == 0.0
    assert all(p.dim() >= 2 for p in decay["params"]) and all(p.dim() < 2 for p in no_decay["params"])
    assert len(decay["params"]) == 2 + 4 * config.n_layer  # wte (= lm_head), wpe, c_attn, c_proj, c_fc, c_proj
    assert sum(p.numel() for g in opt.param_groups for p in g["params"]) == model.num_params(non_embedding=False)
    assert opt.param_groups[0]["betas"] == (0.9, 0.95)

    # Windows are contiguous slices of the stream; targets are the inputs shifted by one.
    stream = torch.arange(100)
    x, y = get_batch(stream, L, 5)
    assert x.shape == y.shape == (5, L) and x.dtype == torch.long
    assert torch.equal(y, x + 1) and torch.equal(x[:, 1:] - x[:, :-1], torch.ones(5, L - 1, dtype=torch.long))

    # The schedule: linear warmup to max_lr, cosine down to min_lr, flat after.
    lrs = [get_lr(it, 10, 100, 1e-3, 1e-4) for it in range(120)]
    assert math.isclose(lrs[0], 1e-4) and math.isclose(lrs[9], 1e-3)
    assert all(a >= b for a, b in zip(lrs[10:100], lrs[11:101]))
    assert math.isclose(lrs[55], 0.5 * (1e-3 + 1e-4)) and math.isclose(lrs[119], 1e-4)

    # Overfit a periodic sequence: the next token is a function of the current one.
    perm = torch.randperm(V)
    data = perm.repeat(64)
    with tempfile.TemporaryDirectory() as tmp:
        ckpt_path = os.path.join(tmp, "ckpt.pt")
        history = train(
            model, data[:768], data[768:], max_iters=300, batch_size=16, max_lr=3e-3, min_lr=3e-4,
            warmup_iters=20, eval_interval=50, eval_iters=5, ckpt_path=ckpt_path,
        )
        assert history[0] > 2.0, history[0]
        final = estimate_loss(model, {"val": data[768:]}, batch_size=16, eval_iters=5)["val"]
        assert final < 0.05, final

        # The checkpoint restores a model from nothing but its own contents.
        ckpt = torch.load(ckpt_path, weights_only=True)
        assert set(ckpt) == {"model", "optimizer", "config", "step"} and ckpt["step"] > 0
        restored = GPT(GPTConfig(**ckpt["config"]))
        restored.load_state_dict(ckpt["model"])
        assert restored.lm_head.weight is restored.transformer.wte.weight
        assert len(ckpt["optimizer"]["param_groups"]) == 2
    print(f"loss {history[0]:.3f} -> {final:.4f}")
    print("PASS")
`,
    },
  },
  debrief: `Every line of this loop is in nanoGPT's \`train.py\`, and each is there because a GPT-2 run fails without it. **Decay groups**: weight decay is a prior that weights should be small; it makes sense for the matrices that do the work and for the embedding tables, not for LayerNorm gains (whose natural value is 1) or biases — splitting by \`p.dim()\` gets this right without naming modules, and the tied \`wte\`/\`lm_head\` tensor, being one \`Parameter\`, lands in the decay group once. **Warmup + cosine**: Adam's second-moment estimate is noise for the first few hundred steps, so a full-size step then can throw the model into a region it never leaves; the warmup holds the step small until \`v\` means something, and the cosine tail anneals into a minimum (\`min_lr = max_lr / 10\` as in Chinchilla). **Clipping at 1.0**: one bad batch can produce a gradient norm hundreds of times the typical one; clipping the global norm bounds the step's length without changing its direction. **bf16 autocast**: matmuls run in bfloat16 on tensor cores while the weights, the optimizer state and reductions such as the softmax and the loss stay in fp32; bf16's 8-bit exponent matches fp32's, so gradients do not underflow and fp16's \`GradScaler\` is unnecessary. **Checkpoints** carry the optimizer state — two fp32 tensors per parameter, twice the model — because resuming AdamW with zeroed moments repeats the warmup's instability without its small learning rate. What production adds: \`torch.compile(model)\` (nanoGPT's ~2× speed-up), gradient accumulation to reach a 0.5M-token batch on small GPUs, \`DistributedDataParallel\` or FSDP/ZeRO to shard the optimizer state, a memory-mapped \`uint16\` token file instead of an in-memory tensor, and \`fused=True\` AdamW, which updates every parameter in one kernel.`,
};
