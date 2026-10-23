import type {Step} from '@/lib/types';

export const nvfp4TrainStep: Step = {
  id: 'nvfp4-train',
  title: 'NVFP4Linear: three quantized GEMMs, and a tiny LM trained with them',
  concept: 'pytorch',
  file: 'nvfp4_train',
  localOnly: 'its self-test runs for minutes on the single CPU thread PyTorch gets in the browser',
  focus: ['fprop', 'dgrad', 'q-wgrad', 'wgrad', 'w-reuse', 'grads', 'lm-qkv', 'lm-proj', 'lm-fc', 'lm-fc2'],
  task: `## Task

Write the custom autograd function that makes a linear layer train in NVFP4 the way the pretraining
paper prescribes: every GEMM operand quantized along that GEMM's reduction dimension, weights in
16 × 16 tiles, gradients stochastically rounded, and the weight-gradient inputs Hadamard-rotated. The
module around it, a 3-block GPT-style LM, the data and the training loop are given.

- \`NVFP4LinearFn.forward(ctx, x, weight, recipe, generator) -> y\`: \`x\` is \`(N, in)\` FP32, \`weight\`
  the \`(out, in)\` FP32 master weight. **Fprop** \`y = Q(x) Q(W)ᵀ\` with \`Q(x)\` in 1 × 16 blocks along
  \`in\`, round-to-nearest, and \`Q(W)\` in 16 × 16 tiles (1 × 16 when \`recipe.weights_2d\` is off).
  Save \`x\`, \`weight\` and the quantized weight with \`ctx.save_for_backward\`; keep \`recipe\` and
  \`generator\` on \`ctx\`.
- \`backward(ctx, dy) -> (dx, dw, None, None)\`. **Dgrad** \`dX = Q(dY) Q(W)\`: \`dY\` \`(N, out)\` in
  1 × 16 blocks along \`out\`, stochastically rounded from \`ctx\`'s generator (round-to-nearest when
  \`recipe.stochastic_grads\` is off); the weight blocked along \`out\`: with 16 × 16 tiles that is the
  forward's own \`Q(W)\`, reused; with 1 × 16 it is \`quantize_nvfp4(weight.T).T\`, a different matrix.
- **Wgrad** \`dW = dYᵀ X\`, the reduction over the \`N\` tokens: take \`dy.T\` \`(out, N)\` and \`x.T\`
  \`(in, N)\`, rotate both with \`rht(·, RHT)\` along tokens when \`recipe.rht_wgrad\` is on, quantize both
  in 1 × 16 blocks (stochastic on the gradient, nearest on the activation) and multiply. \`N\` is a
  multiple of 16.
- Order matters for reproducibility: dgrad's draw first, then wgrad's, from the one generator.
- Kept in FP32, as the paper keeps them in high precision: embeddings, LayerNorms, attention (the
  softmax and both batched matmuls), the head, and the last block (\`Config.hp_last = 1\`, so 8 of the
  12 block linears run in NVFP4). Master weights and AdamW state are FP32.
- No \`torch._scaled_mm\`, torchao or Transformer Engine; every GEMM is a plain FP32 matmul of
  fake-quantized operands.

The self-test checks fprop, dgrad and wgrad against the formulas with the same stochastic-rounding
stream, and the layer's gradients within 0.3 relative error of FP32's. It trains the FP32 baseline
and the NVFP4 model from the same init on the same 200 batches of 8 × 64 tokens of a Markov stream
(vocabulary 64, AdamW, warmup then cosine): both must reach a validation loss below 1.6 (from
ln 64 = 4.16), and NVFP4 must stay within **0.05 nats** of FP32 (it measures 1.277 against 1.274).
Then it measures one ablation on the trained model: the bias of dgrad, the mean of K draws of \`dX\`
against \`dY · W_fwd\`, the gradient of the function the forward computed. With SR and 2-D weights it
falls as the draws add up (0.043 at K = 4, 0.013 at K = 64); without SR it is stuck at 0.059 and with
1 × 16 weights at 0.081 or more, because the backward multiplies by another matrix. The test asserts
that ordering, then prints \`PASS\`. About 15 s on a laptop CPU.

> Three GEMMs, three reduction dimensions, three different ways to quantize the same tensors. The
> recipe chooses each one so the backward still differentiates the forward: one weight for both
> passes, gradients unbiased in expectation, and the rotation only where both operands can take it.`,
  hints: [
    'Forward: quantize `x` and `weight` once each and return their product. Save the quantized weight `wq` with `ctx.save_for_backward` too: with 2-D tiles dgrad reuses it instead of quantizing again. Non-tensor arguments (`recipe`, `generator`) go on `ctx` as attributes, and `backward` returns `None` for each of them.',
    'Dgrad: `rounding = "stochastic" if r.stochastic_grads else "nearest"`; `w_dgrad = wq if r.weights_2d else quantize_nvfp4(weight.T, "nearest", block=(1, 16)).T`; `dx = quantize_nvfp4(dy, rounding, gen, block=(1, 16)) @ w_dgrad`. The 1 × 16 blocks of `wq` run along `in`, the wrong dimension for a product over `out`.',
    'Wgrad: `a, b = dy.T, x.T`, then `a, b = rht(a, RHT), rht(b, RHT)` when the recipe says so; `dw = quantize_nvfp4(a, rounding, gen, block=(1, 16)) @ quantize_nvfp4(b, "nearest", block=(1, 16)).T`. Because `(dYᵀH)(XᵀH)ᵀ = dYᵀX`, the rotation needs no inverse.',
  ],
  checks: [
    {
      id: 'autograd-fn',
      title: 'A custom autograd Function that saves its operands',
      detail:
        '`forward` runs under `no_grad`, so the operands `backward` needs are stored with `ctx.save_for_backward`. Every GEMM is a matmul of fake-quantized FP32 operands; `torch._scaled_mm`, torchao and Transformer Engine would hide the recipe.',
      match: {
        python: {
          all: [/class\s+\w+\(\s*torch\.autograd\.Function\s*\)/, /ctx\.save_for_backward\(/],
          none: [/_scaled_mm/, /torchao/, /transformer_engine/],
        },
      },
    },
    {
      id: 'fprop',
      title: 'Fprop: x in 1 × 16 blocks, the weight in 16 × 16 tiles',
      detail:
        '`quantize_nvfp4(x, …)` blocks along `in_features`, the reduction dimension of `x Wᵀ`, and `quantize_nvfp4(weight, …, block=(16, 16))` tiles the weight so its transpose quantizes the same way.',
      match: {
        python: {
          all: [/quantize_nvfp4\(\s*x\b/, /quantize_nvfp4\(\s*weight\b[^\n]*\(\s*16\s*,\s*16\s*\)/],
        },
      },
    },
    {
      id: 'dgrad',
      title: 'Dgrad quantizes dY along out_features',
      detail:
        '`quantize_nvfp4(dy, rounding, generator, block=(1, 16))`: `dy` is `(N, out)`, so its 1 × 16 blocks run along `out`, the reduction dimension of `dY W`, and the rounding is stochastic.',
      match: {python: {all: [/quantize_nvfp4\(\s*dy\s*,/]}},
    },
    {
      id: 'wgrad-transposed',
      title: 'Wgrad rotates and quantizes dYᵀ and Xᵀ along tokens',
      detail:
        '`dy.T` and `x.T` put the token dimension last, the reduction dimension of `dYᵀ X`; `rht` rotates both 16-token tiles with the same `H`, which cancels in the product.',
      match: {
        python: {
          all: [
            /\bdy\.(?:T\b|t\(\)|transpose\(\s*0\s*,\s*1\s*\)|mT\b)/,
            /\bx\.(?:T\b|t\(\)|transpose\(\s*0\s*,\s*1\s*\)|mT\b)/,
            /\brht\(/,
          ],
        },
      },
    },
    {
      id: 'recipe-flags',
      title: 'Each recipe flag switches its technique',
      detail:
        '`recipe.stochastic_grads` picks SR or nearest for both gradient operands, `recipe.rht_wgrad` the rotation, `recipe.weights_2d` the weight tiles: the self-test turns each off to measure what it does.',
      match: {python: {all: [/\.stochastic_grads\b/, /\.rht_wgrad\b/, /\.weights_2d\b/]}},
    },
    {
      id: 'grads-returned',
      title: 'backward returns dx, dw and None for the rest',
      detail:
        'One gradient per `forward` input: `dx` for `x`, `dw` for `weight`, and `None` for `recipe` and `generator`.',
      match: {python: {all: [/return\s+\w+\s*,\s*\w+\s*,\s*None\s*,\s*None\b/]}},
    },
  ],
  code: {
    python: {
      starter: `"""NVFP4 training at toy scale: a linear layer whose three GEMMs run on NVFP4 operands, and a tiny LM."""

import math
import time
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from nvfp4_rht import random_signs, rht, rht_matrix
from nvfp4_sr import quantize_nvfp4

# One random sign vector for every layer and every step, as the paper does; a 16 x 16 transform.
RHT = rht_matrix(random_signs(16, torch.Generator().manual_seed(1234)))


@dataclass
class Recipe:
    """The paper's recipe; each flag off is one ablation."""

    stochastic_grads: bool = True  # SR on dY for dgrad and wgrad
    rht_wgrad: bool = True  # 16 x 16 RHT on both wgrad operands
    weights_2d: bool = True  # 16 x 16 weight blocks, so fprop and dgrad see one quantized W


class NVFP4LinearFn(torch.autograd.Function):
    """y = x W^T with every GEMM operand fake-quantized to NVFP4 along that GEMM's reduction dim."""

    @staticmethod
    def forward(ctx, x, weight, recipe: Recipe, generator: torch.Generator):
        # TODO fprop: y = x W^T. x in 1 x 16 blocks along in_features, round-to-nearest; the weight in 16 x 16
        # tiles (1 x 16 when the recipe turns 2-D weights off). Save what backward needs; return the product.
        raise NotImplementedError("TODO: fprop")

    @staticmethod
    def backward(ctx, dy):
        # TODO dgrad: dX = dY W. dY in 1 x 16 blocks along out_features, stochastically rounded unless the recipe
        # turns SR off; the weight blocked along out_features (with 2-D tiles, the forward's own quantized weight).
        # TODO wgrad: dW = dY^T X, the reduction over tokens. Transpose both, rotate both with rht(., RHT) along
        # tokens when the recipe says so, quantize both in 1 x 16 blocks (SR on the gradient only), multiply.
        # Return one gradient per forward input: dx, dw, None, None.
        raise NotImplementedError("TODO: dgrad and wgrad")


class NVFP4Linear(nn.Module):
    """A bias-free linear layer whose fprop, dgrad and wgrad GEMMs run on NVFP4 operands."""

    def __init__(self, in_features: int, out_features: int, recipe: Recipe, generator: torch.Generator):
        super().__init__()
        assert in_features % 16 == 0 and out_features % 16 == 0
        self.weight = nn.Parameter(torch.empty(out_features, in_features))  # FP32 master weight
        nn.init.normal_(self.weight, std=0.02)
        self.recipe, self.generator = recipe, generator

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = NVFP4LinearFn.apply(x.reshape(-1, x.shape[-1]), self.weight, self.recipe, self.generator)
        return y.reshape(*x.shape[:-1], -1)


# ---- a tiny LM, given ------------------------------------------------------------------------------


@dataclass
class Config:
    vocab: int = 64
    block: int = 64
    d: int = 64
    n_head: int = 4
    n_layer: int = 3
    hp_last: int = 1  # the last blocks stay in high precision, as the paper keeps its final layers in BF16


class Block(nn.Module):
    def __init__(self, cfg: Config, linear):
        super().__init__()
        self.n_head = cfg.n_head
        self.ln1, self.ln2 = nn.LayerNorm(cfg.d), nn.LayerNorm(cfg.d)
        self.qkv, self.proj = linear(cfg.d, 3 * cfg.d), linear(cfg.d, cfg.d)
        self.fc, self.fc2 = linear(cfg.d, 4 * cfg.d), linear(4 * cfg.d, cfg.d)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(C, dim=2)
        q, k, v = (t.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) for t in (q, k, v))
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)  # attention itself stays in FP32
        x = x + self.proj(y.transpose(1, 2).reshape(B, T, C))
        return x + self.fc2(F.gelu(self.fc(self.ln2(x))))


class TinyLM(nn.Module):
    """Embeddings, LayerNorms, attention and the head in FP32; the block linears in NVFP4 when a recipe is given."""

    def __init__(self, cfg: Config, recipe: Recipe | None = None, seed: int = 0):
        super().__init__()
        torch.manual_seed(seed)
        self.generator = torch.Generator().manual_seed(seed + 1)  # the stochastic-rounding stream

        def linear(i: int):
            """Block i's linear layers: NVFP4 unless the block is one of the last hp_last."""
            if recipe is not None and i < cfg.n_layer - cfg.hp_last:
                return lambda n_in, n_out: NVFP4Linear(n_in, n_out, recipe, self.generator)
            return lambda n_in, n_out: nn.Linear(n_in, n_out, bias=False)

        self.wte, self.wpe = nn.Embedding(cfg.vocab, cfg.d), nn.Embedding(cfg.block, cfg.d)
        self.blocks = nn.ModuleList(Block(cfg, linear(i)) for i in range(cfg.n_layer))
        self.ln_f, self.head = nn.LayerNorm(cfg.d), nn.Linear(cfg.d, cfg.vocab, bias=False)
        torch.manual_seed(seed)  # the same init with or without a recipe
        for name, p in self.named_parameters():
            if p.dim() == 2:  # GPT-2's init, residual projections scaled down
                std = 0.02 / math.sqrt(2 * cfg.n_layer) if name.endswith(("proj.weight", "fc2.weight")) else 0.02
                nn.init.normal_(p, std=std)

    def forward(self, idx: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        x = self.wte(idx) + self.wpe(torch.arange(idx.shape[1]))
        for blk in self.blocks:
            x = blk(x)
        logits = self.head(self.ln_f(x))
        return F.cross_entropy(logits.reshape(-1, logits.shape[-1]), targets.reshape(-1))


def make_corpus(vocab: int, n: int, seed: int = 0) -> torch.Tensor:
    """A first-order Markov stream: every token has 4 successors with probabilities 0.5, 0.25, 0.15, 0.1."""
    g = torch.Generator().manual_seed(seed)
    succ = torch.randint(0, vocab, (vocab, 4), generator=g)
    choice = torch.multinomial(torch.tensor([0.5, 0.25, 0.15, 0.1]), n, replacement=True, generator=g)
    out = torch.zeros(n, dtype=torch.long)
    for t in range(1, n):
        out[t] = succ[out[t - 1], choice[t]]
    return out


def batches(data: torch.Tensor, steps: int, B: int, T: int, seed: int):
    g = torch.Generator().manual_seed(seed)
    for _ in range(steps):
        i = torch.randint(0, len(data) - T - 1, (B,), generator=g)
        yield torch.stack([data[j : j + T] for j in i]), torch.stack([data[j + 1 : j + 1 + T] for j in i])


def train(model: nn.Module, data: torch.Tensor, steps: int, B: int, T: int, lr: float = 3e-3) -> list[float]:
    opt = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.0)
    losses = []
    for it, (x, y) in enumerate(batches(data, steps, B, T, seed=7)):
        for gr in opt.param_groups:
            gr["lr"] = lr * min(1.0, (it + 1) / 20) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * it / steps)))
        loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(loss.item())
    return losses


@torch.no_grad()
def evaluate(model: nn.Module, data: torch.Tensor, B: int, T: int) -> float:
    return sum(model(x, y).item() for x, y in batches(data, 8, B, T, seed=99)) / 8


if __name__ == "__main__":
    t0 = time.time()
    torch.manual_seed(0)
    rel = lambda a, b: ((a - b).norm() / b.norm()).item()  # noqa: E731

    # 1. The three GEMMs against the formulas, drawing the same stochastic-rounding stream.
    g = torch.Generator().manual_seed(3)
    inp = torch.randn(256, 64, generator=g, requires_grad=True)
    w_test = (torch.randn(128, 64, generator=g) * 0.05).requires_grad_()
    dout = torch.randn(256, 128, generator=g)
    out = NVFP4LinearFn.apply(inp, w_test, Recipe(), torch.Generator().manual_seed(5))
    out.backward(dout)
    sr = torch.Generator().manual_seed(5)  # the same stream: dgrad draws first, then wgrad
    wq = quantize_nvfp4(w_test.detach(), block=(16, 16))
    assert torch.allclose(out, quantize_nvfp4(inp.detach()) @ wq.T, atol=1e-5), "fprop"
    assert torch.allclose(inp.grad, quantize_nvfp4(dout, "stochastic", sr) @ wq, atol=1e-5), "dgrad"
    dw = quantize_nvfp4(rht(dout.T, RHT), "stochastic", sr) @ quantize_nvfp4(rht(inp.detach().T, RHT)).T
    assert torch.allclose(w_test.grad, dw, atol=1e-4), "wgrad"
    ex, ew = rel(inp.grad, dout @ w_test.detach()), rel(w_test.grad, dout.T @ inp.detach())
    assert ex < 0.3 and ew < 0.3
    print(f"one layer vs FP32: dX {ex:.3f}, dW {ew:.3f} relative error")

    # 2. Train the FP32 baseline and the NVFP4 model from the same init on the same batches.
    cfg = Config()
    data = make_corpus(cfg.vocab, 60_000)
    train_data, val_data = data[:50_000], data[50_000:]
    STEPS, B, T = 200, 8, 64
    base, fp4 = TinyLM(cfg), TinyLM(cfg, Recipe())
    assert torch.equal(base.blocks[0].fc.weight, fp4.blocks[0].fc.weight), "same init"
    t1 = time.time()
    lb = train(base, train_data, STEPS, B, T)
    t2 = time.time()
    lf = train(fp4, train_data, STEPS, B, T)
    t3 = time.time()
    vb, vf = evaluate(base, val_data, B, T), evaluate(fp4, val_data, B, T)
    print(f"{STEPS} steps: FP32 {t2 - t1:.1f} s, NVFP4 {t3 - t2:.1f} s; first loss {lb[0]:.3f} / {lf[0]:.3f}")
    print(f"validation loss: FP32 {vb:.4f}, NVFP4 {vf:.4f}, gap {vf - vb:+.4f} nats")
    assert vb < 1.6 and vf < 1.6, "both learn the stream (ln 64 = 4.16 at the start)"
    assert abs(vf - vb) < 0.05, "NVFP4 within 0.05 nats of FP32"

    # 3. Ablation, measured on the trained model: is dgrad an unbiased gradient of the forward pass?
    # E[dX] over the SR draws should be dY @ W_fwd, with W_fwd the weight the forward multiplied by.
    layer = fp4.blocks[0].fc2
    Wl = layer.weight.detach()
    cap = {}
    h1 = layer.register_forward_hook(lambda m, i, o: cap.update(x=i[0].detach().reshape(-1, i[0].shape[-1])))
    h2 = layer.register_full_backward_hook(lambda m, gi, go: cap.update(dy=go[0].detach().reshape(-1, Wl.shape[0])))
    xb, yb = next(batches(val_data, 1, B, T, seed=5))
    fp4(xb, yb).backward()
    h1.remove()
    h2.remove()

    def dgrad_bias(recipe: Recipe, K: int) -> float:
        gen = torch.Generator().manual_seed(11)
        w_fwd = quantize_nvfp4(Wl, block=(16, 16) if recipe.weights_2d else (1, 16))
        acc = torch.zeros_like(cap["x"])
        for _ in range(K):
            xr = cap["x"].clone().requires_grad_()
            NVFP4LinearFn.apply(xr, Wl, recipe, gen).backward(cap["dy"])
            acc += xr.grad
        return rel(acc / K, cap["dy"] @ w_fwd)

    bias = {}
    ablations = {
        "paper: SR + 2-D W": Recipe(),
        "no SR": Recipe(stochastic_grads=False),
        "1 x 16 W": Recipe(weights_2d=False),
    }
    for name, r in ablations.items():
        bias[name] = [dgrad_bias(r, K) for K in (4, 64)]
        print(f"dgrad bias, mean of 4 / 64 draws, {name:18s} {bias[name][0]:.4f} / {bias[name][1]:.4f}")
    paper, no_sr, one_d = bias["paper: SR + 2-D W"], bias["no SR"], bias["1 x 16 W"]
    assert paper[1] < paper[0] / 2, "with SR the error averages away"
    assert no_sr[1] > 0.95 * no_sr[0] and one_d[1] > 0.8 * one_d[0], "without it, or with 1 x 16 weights, it stays"
    assert paper[1] < no_sr[1] / 2 and paper[1] < one_d[1] / 2
    print(f"total {time.time() - t0:.1f} s")
    print("PASS")
`,
      solution: `"""NVFP4 training at toy scale: a linear layer whose three GEMMs run on NVFP4 operands, and a tiny LM."""

import math
import time
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from nvfp4_rht import random_signs, rht, rht_matrix
from nvfp4_sr import quantize_nvfp4

# One random sign vector for every layer and every step, as the paper does; a 16 x 16 transform.
RHT = rht_matrix(random_signs(16, torch.Generator().manual_seed(1234)))


@dataclass
class Recipe:
    """The paper's recipe; each flag off is one ablation."""

    stochastic_grads: bool = True  # SR on dY for dgrad and wgrad
    rht_wgrad: bool = True  # 16 x 16 RHT on both wgrad operands
    weights_2d: bool = True  # 16 x 16 weight blocks, so fprop and dgrad see one quantized W


class NVFP4LinearFn(torch.autograd.Function):
    """y = x W^T with every GEMM operand fake-quantized to NVFP4 along that GEMM's reduction dim."""

    @staticmethod
    def forward(ctx, x, weight, recipe: Recipe, generator: torch.Generator):
        # fprop  y = x W^T, reduction over in_features: x in 1 x 16 blocks along in, W in 16 x 16 tiles.
        xq = quantize_nvfp4(x, "nearest", block=(1, 16))
        wq = quantize_nvfp4(weight, "nearest", block=(16, 16) if recipe.weights_2d else (1, 16))
        ctx.save_for_backward(x, weight, wq)
        ctx.recipe, ctx.generator = recipe, generator
        return xq @ wq.T

    @staticmethod
    def backward(ctx, dy):
        x, weight, wq = ctx.saved_tensors
        r, gen = ctx.recipe, ctx.generator
        rounding = "stochastic" if r.stochastic_grads else "nearest"
        # dgrad  dX = dY W, reduction over out_features: dY in 1 x 16 blocks along out, stochastically rounded.
        # With 2-D weight tiles the forward's wq is already blocked along out as well: reuse it.
        w_dgrad = wq if r.weights_2d else quantize_nvfp4(weight.T, "nearest", block=(1, 16)).T
        dx = quantize_nvfp4(dy, rounding, gen, block=(1, 16)) @ w_dgrad
        # wgrad  dW = dY^T X, reduction over tokens: both operands transposed, so blocks run along tokens.
        a, b = dy.T, x.T  # (out, N), (in, N)
        if r.rht_wgrad:
            a, b = rht(a, RHT), rht(b, RHT)  # (dY^T H)(X^T H)^T = dY^T X
        dw = quantize_nvfp4(a, rounding, gen, block=(1, 16)) @ quantize_nvfp4(b, "nearest", block=(1, 16)).T
        return dx, dw, None, None


class NVFP4Linear(nn.Module):
    """A bias-free linear layer whose fprop, dgrad and wgrad GEMMs run on NVFP4 operands."""

    def __init__(self, in_features: int, out_features: int, recipe: Recipe, generator: torch.Generator):
        super().__init__()
        assert in_features % 16 == 0 and out_features % 16 == 0
        self.weight = nn.Parameter(torch.empty(out_features, in_features))  # FP32 master weight
        nn.init.normal_(self.weight, std=0.02)
        self.recipe, self.generator = recipe, generator

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = NVFP4LinearFn.apply(x.reshape(-1, x.shape[-1]), self.weight, self.recipe, self.generator)
        return y.reshape(*x.shape[:-1], -1)


# ---- a tiny LM, given ------------------------------------------------------------------------------


@dataclass
class Config:
    vocab: int = 64
    block: int = 64
    d: int = 64
    n_head: int = 4
    n_layer: int = 3
    hp_last: int = 1  # the last blocks stay in high precision, as the paper keeps its final layers in BF16


class Block(nn.Module):
    def __init__(self, cfg: Config, linear):
        super().__init__()
        self.n_head = cfg.n_head
        self.ln1, self.ln2 = nn.LayerNorm(cfg.d), nn.LayerNorm(cfg.d)
        self.qkv, self.proj = linear(cfg.d, 3 * cfg.d), linear(cfg.d, cfg.d)
        self.fc, self.fc2 = linear(cfg.d, 4 * cfg.d), linear(4 * cfg.d, cfg.d)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(C, dim=2)
        q, k, v = (t.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) for t in (q, k, v))
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)  # attention itself stays in FP32
        x = x + self.proj(y.transpose(1, 2).reshape(B, T, C))
        return x + self.fc2(F.gelu(self.fc(self.ln2(x))))


class TinyLM(nn.Module):
    """Embeddings, LayerNorms, attention and the head in FP32; the block linears in NVFP4 when a recipe is given."""

    def __init__(self, cfg: Config, recipe: Recipe | None = None, seed: int = 0):
        super().__init__()
        torch.manual_seed(seed)
        self.generator = torch.Generator().manual_seed(seed + 1)  # the stochastic-rounding stream

        def linear(i: int):
            """Block i's linear layers: NVFP4 unless the block is one of the last hp_last."""
            if recipe is not None and i < cfg.n_layer - cfg.hp_last:
                return lambda n_in, n_out: NVFP4Linear(n_in, n_out, recipe, self.generator)
            return lambda n_in, n_out: nn.Linear(n_in, n_out, bias=False)

        self.wte, self.wpe = nn.Embedding(cfg.vocab, cfg.d), nn.Embedding(cfg.block, cfg.d)
        self.blocks = nn.ModuleList(Block(cfg, linear(i)) for i in range(cfg.n_layer))
        self.ln_f, self.head = nn.LayerNorm(cfg.d), nn.Linear(cfg.d, cfg.vocab, bias=False)
        torch.manual_seed(seed)  # the same init with or without a recipe
        for name, p in self.named_parameters():
            if p.dim() == 2:  # GPT-2's init, residual projections scaled down
                std = 0.02 / math.sqrt(2 * cfg.n_layer) if name.endswith(("proj.weight", "fc2.weight")) else 0.02
                nn.init.normal_(p, std=std)

    def forward(self, idx: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        x = self.wte(idx) + self.wpe(torch.arange(idx.shape[1]))
        for blk in self.blocks:
            x = blk(x)
        logits = self.head(self.ln_f(x))
        return F.cross_entropy(logits.reshape(-1, logits.shape[-1]), targets.reshape(-1))


def make_corpus(vocab: int, n: int, seed: int = 0) -> torch.Tensor:
    """A first-order Markov stream: every token has 4 successors with probabilities 0.5, 0.25, 0.15, 0.1."""
    g = torch.Generator().manual_seed(seed)
    succ = torch.randint(0, vocab, (vocab, 4), generator=g)
    choice = torch.multinomial(torch.tensor([0.5, 0.25, 0.15, 0.1]), n, replacement=True, generator=g)
    out = torch.zeros(n, dtype=torch.long)
    for t in range(1, n):
        out[t] = succ[out[t - 1], choice[t]]
    return out


def batches(data: torch.Tensor, steps: int, B: int, T: int, seed: int):
    g = torch.Generator().manual_seed(seed)
    for _ in range(steps):
        i = torch.randint(0, len(data) - T - 1, (B,), generator=g)
        yield torch.stack([data[j : j + T] for j in i]), torch.stack([data[j + 1 : j + 1 + T] for j in i])


def train(model: nn.Module, data: torch.Tensor, steps: int, B: int, T: int, lr: float = 3e-3) -> list[float]:
    opt = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.0)
    losses = []
    for it, (x, y) in enumerate(batches(data, steps, B, T, seed=7)):
        for gr in opt.param_groups:
            gr["lr"] = lr * min(1.0, (it + 1) / 20) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * it / steps)))
        loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(loss.item())
    return losses


@torch.no_grad()
def evaluate(model: nn.Module, data: torch.Tensor, B: int, T: int) -> float:
    return sum(model(x, y).item() for x, y in batches(data, 8, B, T, seed=99)) / 8


if __name__ == "__main__":
    t0 = time.time()
    torch.manual_seed(0)
    rel = lambda a, b: ((a - b).norm() / b.norm()).item()  # noqa: E731

    # 1. The three GEMMs against the formulas, drawing the same stochastic-rounding stream.
    g = torch.Generator().manual_seed(3)
    inp = torch.randn(256, 64, generator=g, requires_grad=True)
    w_test = (torch.randn(128, 64, generator=g) * 0.05).requires_grad_()
    dout = torch.randn(256, 128, generator=g)
    out = NVFP4LinearFn.apply(inp, w_test, Recipe(), torch.Generator().manual_seed(5))
    out.backward(dout)
    sr = torch.Generator().manual_seed(5)  # the same stream: dgrad draws first, then wgrad
    wq = quantize_nvfp4(w_test.detach(), block=(16, 16))
    assert torch.allclose(out, quantize_nvfp4(inp.detach()) @ wq.T, atol=1e-5), "fprop"
    assert torch.allclose(inp.grad, quantize_nvfp4(dout, "stochastic", sr) @ wq, atol=1e-5), "dgrad"
    dw = quantize_nvfp4(rht(dout.T, RHT), "stochastic", sr) @ quantize_nvfp4(rht(inp.detach().T, RHT)).T
    assert torch.allclose(w_test.grad, dw, atol=1e-4), "wgrad"
    ex, ew = rel(inp.grad, dout @ w_test.detach()), rel(w_test.grad, dout.T @ inp.detach())
    assert ex < 0.3 and ew < 0.3
    print(f"one layer vs FP32: dX {ex:.3f}, dW {ew:.3f} relative error")

    # 2. Train the FP32 baseline and the NVFP4 model from the same init on the same batches.
    cfg = Config()
    data = make_corpus(cfg.vocab, 60_000)
    train_data, val_data = data[:50_000], data[50_000:]
    STEPS, B, T = 200, 8, 64
    base, fp4 = TinyLM(cfg), TinyLM(cfg, Recipe())
    assert torch.equal(base.blocks[0].fc.weight, fp4.blocks[0].fc.weight), "same init"
    t1 = time.time()
    lb = train(base, train_data, STEPS, B, T)
    t2 = time.time()
    lf = train(fp4, train_data, STEPS, B, T)
    t3 = time.time()
    vb, vf = evaluate(base, val_data, B, T), evaluate(fp4, val_data, B, T)
    print(f"{STEPS} steps: FP32 {t2 - t1:.1f} s, NVFP4 {t3 - t2:.1f} s; first loss {lb[0]:.3f} / {lf[0]:.3f}")
    print(f"validation loss: FP32 {vb:.4f}, NVFP4 {vf:.4f}, gap {vf - vb:+.4f} nats")
    assert vb < 1.6 and vf < 1.6, "both learn the stream (ln 64 = 4.16 at the start)"
    assert abs(vf - vb) < 0.05, "NVFP4 within 0.05 nats of FP32"

    # 3. Ablation, measured on the trained model: is dgrad an unbiased gradient of the forward pass?
    # E[dX] over the SR draws should be dY @ W_fwd, with W_fwd the weight the forward multiplied by.
    layer = fp4.blocks[0].fc2
    Wl = layer.weight.detach()
    cap = {}
    h1 = layer.register_forward_hook(lambda m, i, o: cap.update(x=i[0].detach().reshape(-1, i[0].shape[-1])))
    h2 = layer.register_full_backward_hook(lambda m, gi, go: cap.update(dy=go[0].detach().reshape(-1, Wl.shape[0])))
    xb, yb = next(batches(val_data, 1, B, T, seed=5))
    fp4(xb, yb).backward()
    h1.remove()
    h2.remove()

    def dgrad_bias(recipe: Recipe, K: int) -> float:
        gen = torch.Generator().manual_seed(11)
        w_fwd = quantize_nvfp4(Wl, block=(16, 16) if recipe.weights_2d else (1, 16))
        acc = torch.zeros_like(cap["x"])
        for _ in range(K):
            xr = cap["x"].clone().requires_grad_()
            NVFP4LinearFn.apply(xr, Wl, recipe, gen).backward(cap["dy"])
            acc += xr.grad
        return rel(acc / K, cap["dy"] @ w_fwd)

    bias = {}
    ablations = {
        "paper: SR + 2-D W": Recipe(),
        "no SR": Recipe(stochastic_grads=False),
        "1 x 16 W": Recipe(weights_2d=False),
    }
    for name, r in ablations.items():
        bias[name] = [dgrad_bias(r, K) for K in (4, 64)]
        print(f"dgrad bias, mean of 4 / 64 draws, {name:18s} {bias[name][0]:.4f} / {bias[name][1]:.4f}")
    paper, no_sr, one_d = bias["paper: SR + 2-D W"], bias["no SR"], bias["1 x 16 W"]
    assert paper[1] < paper[0] / 2, "with SR the error averages away"
    assert no_sr[1] > 0.95 * no_sr[0] and one_d[1] > 0.8 * one_d[0], "without it, or with 1 x 16 weights, it stays"
    assert paper[1] < no_sr[1] / 2 and paper[1] < one_d[1] / 2
    print(f"total {time.time() - t0:.1f} s")
    print("PASS")
`,
    },
  },
  debrief: `A linear layer is three GEMMs with three reduction dimensions: fprop sums over \`in\`, dgrad over
\`out\`, wgrad over tokens. Block scaling only works along the reduction dimension (the tensor cores
apply one scale per 16 products of a dot product), so every operand is quantized again for every GEMM
it enters, and that is where the recipe makes its choices. The weight enters two GEMMs along two
different axes, so 16 × 16 tiles make both copies the same matrix and the backward differentiates the
forward; the ablation shows what breaks without it: averaged over 64 draws, dgrad still misses
\`dY · W_fwd\` by 8 %. Gradients are stochastically rounded in both backward GEMMs, so their errors
average out across steps instead of accumulating; without SR the dgrad error is a constant 5.9 %
however many steps you average. The rotation goes only on wgrad, because there both operands are
activations or gradients quantized fresh each step and can both be rotated along the token
dimension; rotating a weight would break the 2-D consistency. At this scale the loss gap is 0.003 nats,
and turning off SR, the rotation or the 2-D tiles moves the validation loss by under 0.005 nats
(measured 1.281, 1.276 and 1.279 against 1.277): too little to assert on, so the self-test measures the
gradient bias directly. The paper's case for every technique is its 12B run: in ablations branched
from it at 3.43T tokens, removing any one of them raises the loss. Production adds what the toy leaves out: real FP4 storage (two codes
per byte and a swizzled E4M3 scale layout), GEMMs that read NVFP4 operands on Blackwell tensor cores
and write BF16 or FP32, an extra pass over each tensor for its global amax, amax reduction across
ranks for gathered tensors, BF16 rather than FP32 for the high-precision parts, and the option to switch
the last stretch of training back to higher precision to close the remaining gap.`,
};
