import type {Step} from '@/lib/types';

/** Matches `pattern` inside the body of top-level `def name` (up to the next top-level statement). */
const inDef = (name: string, pattern: string): RegExp =>
  new RegExp(String.raw`def ${name}\b(?:(?!\n(?:def |class |@|if __name__))[\s\S])*?` + pattern);

export const nvfp4PtqStep: Step = {
  id: 'nvfp4-ptq',
  title: 'PTQ of a small LM: NVFP4 against MXFP4 and INT4',
  concept: 'pytorch',
  file: 'nvfp4_ptq',
  focus: ['calib-batch', 'calib-hooks', 'q-qkv', 'q-proj', 'q-fc1', 'q-fc2', 'keep-embed', 'keep-head', 'compare'],
  task: `## Task

Quantize a trained model after the fact (post-training quantization, PTQ). Calibrate it on a few batches,
swap its block linears for 4-bit ones, and measure what each 4-bit format costs.

The file gives \`TinyLM\` (vocabulary 64, context 64, width 128, 2 pre-norm blocks, 4 heads, an MLP of 512),
\`block_linears(model)\` (the names of the 8 \`nn.Linear\` inside the blocks), \`_swap\`, \`perplexity\`,
\`layer_output_error\` and a corpus drawn from an order-2 Markov chain. It also gives
\`mxfp4_dequantize\`, \`int4_dequantize\` and \`QDQLinear(linear, fmt)\`, a baseline W4A4 layer. That layer
stores its weight quantized and quantizes, then dequantizes, its input on every forward. Write:

- \`mxfp4_quantize(x) -> (codes, scales)\`: MXFP4 per OCP MX v1.0, along K, for \`x\` of shape \`(rows, K)\`.
  Blocks of 32 share one scale \`X = 2^(floor(log2 amax) − 2)\`, where 2 is the largest E2M1 exponent
  (6 = 1.5 · 2²), the exponent clamped to E8M0's \`[−127, 127]\`. Each element is \`e2m1_round(x / X)\`
  (values past 6 saturate). The codes are packed like NVFP4's, \`(rows, K/2)\` uint8, and the scales are
  stored as \`torch.float8_e8m0fnu\`, \`(rows, K/32)\`.
- \`int4_quantize(x) -> (codes, scales)\`: symmetric INT4 per group of 32. The scale is \`amax / 7\` stored as
  \`float16\`; the codes are \`round(x / scale)\` clamped to \`[−8, 7]\` and stored as \`code + 8\`, packed. An
  all-zero group gets zero codes. At 4 + 16/32 = 4.5 bits per weight it costs the same as NVFP4.
- \`collect_act_amax(model, calib, names) -> {name: amax}\`: a forward pre-hook on each named Linear keeps
  the largest \`|input|\` it sees during one float forward over \`calib\`. Remove the hooks after.
- \`quantize_model(model, fmt, act_amax=None)\`, in place. Each of \`block_linears(model)\` becomes
  \`NVFP4Linear.from_linear(linear, act_amax[name])\` for \`"nvfp4"\`, or \`QDQLinear(linear, fmt)\` for
  \`"mxfp4"\` and \`"int4"\`. The embeddings, the final LayerNorm and the head stay fp32.
- Why the ends stay fp32: the embedding is a table lookup, so NVFP4 would save its memory but speed up no
  GEMM. The head's error lands on the logits with nothing after it to absorb it; ModelOpt's default
  configurations disable \`*lm_head*\` for the same reason.
- \`weight_bytes(model) -> int\`: the bytes of the block linears as stored, \`numel() * element_size()\`. That
  is fp32 weights, or codes plus scales (plus NVFP4's 4-byte global scale per layer).

:::widget nvfp4-block {"outlier": true}

The self-test trains the model for 400 AdamW steps (about 8 s on a laptop CPU) and checks MXFP4's scale
rule and INT4's half-step bound on one tensor. It calibrates on 32 sequences and quantizes three copies.
Then it prints, per format, the bits per weight, the KiB of block weights, the mean relative output error
of the 8 layers (fed the float model's own held-out inputs) and the held-out perplexity. One run:

| format | bits/weight | KiB | layer output error | perplexity |
|---|---|---|---|---|
| fp32 | 32 | 1,536 | | 8.405 |
| NVFP4 | 4.501 | 216.0 | 0.1067 | 8.957 |
| MXFP4 | 4.25 | 204.0 | 0.1384 | 9.565 |
| INT4, g = 32 | 4.5 | 216.0 | 0.1132 | 9.219 |

It asserts only the orderings that held on every one of eight seeds tried:
- output error NVFP4 < INT4 < MXFP4;
- perplexity fp32 < NVFP4 < INT4 < MXFP4;
- quantizing the head as well costs perplexity (9.044 against 8.957);
- the calibrated activation scale is within 0.15 perplexity of the dynamic one (8.957 against 8.987).

It also checks the exact byte counts: 9/16 of a byte per weight plus 32 bytes of global scales for NVFP4,
and 17/32 of a byte for MXFP4. Then it prints \`PASS\`.

> At about 4.5 bits, the format decides the error: NVFP4's E4M3 scale lands each block's largest value
> on 6 to within a few percent. MXFP4's power of two leaves it anywhere from 4 to 8, clipping the top or
> leaving the code for 6 unused, and uniform INT4 levels fit bell-shaped data worse than E2M1's.`,
  hints: [
    'Per block of 32, `torch.floor(torch.log2(amax)) - 2` is the shared exponent. Clamp `amax` away from 0 first (an all-zero block) and the exponent to `[−127, 127]`. `torch.exp2` turns it into the scale, which `.to(torch.float8_e8m0fnu)` stores exactly; the elements reuse `e2m1_round`, `e2m1_encode` and `pack_fp4`.',
    'The hook is `register_forward_pre_hook(fn)` with `fn(module, args)`: `args[0]` is the input. Build one closure per name (a function that returns the hook), or the loop variable is shared by all of them.',
    'Iterate over `block_linears(model)`, fetch each with `model.get_submodule(name)`, build the replacement and `_swap(model, name, new)`. The head is not in that list, so it stays an `nn.Linear`.',
  ],
  checks: [
    {
      id: 'mx-exponent',
      title: 'MXFP4 scale is a power of two from floor(log2 amax)',
      detail:
        'OCP MX v1.0 sets the shared exponent to `floor(log2(amax)) − emax_elem`, with `emax_elem = 2` for E2M1. The scale cannot be fractional, which is what NVFP4 changes.',
      match: {python: {all: [inDef('mxfp4_quantize', String.raw`(?:floor\(|\.floor\(\)|frexp\()`)]}},
    },
    {
      id: 'mx-e8m0',
      title: 'MXFP4 scales stored as E8M0',
      detail: 'One byte per 32 values, `torch.float8_e8m0fnu`: an exponent with no sign and no mantissa.',
      match: {python: {all: [inDef('mxfp4_quantize', String.raw`float8_e8m0fnu`)]}},
    },
    {
      id: 'int4-symmetric',
      title: 'INT4 codes clamped to the signed range −8..7',
      detail:
        '`round(x / scale)` with `scale = amax / 7` in fp16, clamped to `[−8, 7]`: evenly spaced levels per group of 32. With `amax / 7` only −7 to 7 are reached, so the grid is symmetric.',
      match: {python: {all: [inDef('int4_quantize', String.raw`(?:-8\s*,\s*(?:max\s*=\s*)?7|min\s*=\s*-8)`)]}},
    },
    {
      id: 'calib-hooks',
      title: 'Calibration observes inputs with hooks',
      detail:
        '`collect_act_amax` registers a forward hook (pre-hook) on each named Linear and records the largest `|input|` during one float forward over the calibration batch.',
      match: {python: {all: [inDef('collect_act_amax', String.raw`register_forward(?:_pre)?_hook\(`)]}},
    },
    {
      id: 'blocks-only',
      title: 'Only the block linears are swapped',
      detail:
        '`quantize_model` walks `block_linears(model)` (or `model.blocks`): the embeddings and the head are never replaced.',
      match: {python: {all: [inDef('quantize_model', String.raw`(?:block_linears\(|\.blocks\b)`)]}},
    },
    {
      id: 'nvfp4-calibrated',
      title: 'NVFP4 layers get their calibrated amax',
      detail:
        '`NVFP4Linear.from_linear(linear, act_amax[name])`: each layer’s activation global scale is fixed from what calibration saw.',
      match: {python: {all: [inDef('quantize_model', String.raw`from_linear\([^)\n]*amax`)]}},
    },
    {
      id: 'bytes',
      title: 'Memory counted from the stored tensors',
      detail:
        '`numel() * element_size()` of each weight, or of codes and scales: 4.5, 4.25 and 4.5 bits per weight are measured, not assumed.',
      match: {python: {all: [inDef('weight_bytes', String.raw`element_size\(\)`)]}},
    },
    {
      id: 'no-library',
      title: 'No quantization library',
      detail: 'No ModelOpt, Transformer Engine, torchao or `microxcaling`: the formats are the exercise.',
      match: {python: {none: [/modelopt|transformer_engine|torchao|microxcaling|mx_formats/]}},
    },
  ],
  code: {
    python: {
      starter: `"""NVFP4 for inference, part 2: post-training quantization of a small LM, against MXFP4 and INT4."""

import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from nvfp4_gemm import FP4_LUT, NVFP4Linear, e2m1_encode, e2m1_round, pack_fp4, unpack_fp4

VOCAB, CTX, D, N_LAYER, N_HEAD = 64, 64, 128, 2, 4
MX_BLOCK, INT4_GROUP = 32, 32


# ---- the two baselines ----------------------------------------------------------------------------


def mxfp4_quantize(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """OCP MX v1.0: blocks of 32 along K, one E8M0 power-of-two scale each.

    x (rows, K) -> (codes (rows, K/2) uint8, scales (rows, K/32) as E8M0, one byte each).
    """
    # TODO: per block of 32, the shared exponent floor(log2(amax)) - 2 (2 is E2M1's largest exponent), clamped
    # to E8M0's range; elements e2m1_round(x / 2^e), packed; the scales stored as E8M0.
    raise NotImplementedError("TODO: MXFP4 per the OCP spec")


def mxfp4_dequantize(codes: torch.Tensor, scales: torch.Tensor) -> torch.Tensor:
    q = FP4_LUT[unpack_fp4(codes).long()]
    rows = q.shape[0]
    return (q.view(rows, -1, MX_BLOCK) * scales.float()[..., None]).view(rows, -1)


def int4_quantize(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Symmetric INT4 per group of 32 along K, one fp16 scale amax / 7 each: codes -8..7 stored as 0..15.

    x (rows, K) -> (codes (rows, K/2) uint8, scales (rows, K/32) float16).
    """
    # TODO: per group of 32, scale = amax / 7 rounded to fp16; codes round(x / scale) clamped to the signed
    # 4-bit range, offset by 8 and packed. An all-zero group gets zero codes.
    raise NotImplementedError("TODO: symmetric INT4 per group")


def int4_dequantize(codes: torch.Tensor, scales: torch.Tensor) -> torch.Tensor:
    q = unpack_fp4(codes).float() - 8
    rows = q.shape[0]
    return (q.view(rows, -1, INT4_GROUP) * scales.float()[..., None]).view(rows, -1)


FORMATS = {"mxfp4": (mxfp4_quantize, mxfp4_dequantize), "int4": (int4_quantize, int4_dequantize)}
FORMATS_ALL = ["nvfp4", *FORMATS]


class QDQLinear(nn.Module):
    """A baseline W4A4 layer: weights stored quantized, inputs quantized and dequantized per forward."""

    def __init__(self, linear: nn.Linear, fmt: str):
        super().__init__()
        self.fmt, self.in_features, self.out_features = fmt, linear.in_features, linear.out_features
        codes, scales = FORMATS[fmt][0](linear.weight.detach())
        self.register_buffer("w_codes", codes)
        self.register_buffer("w_scales", scales)
        self.register_buffer("bias", None if linear.bias is None else linear.bias.detach().float().clone())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        quantize, dequantize = FORMATS[self.fmt]
        x2 = x.reshape(-1, self.in_features)
        xq = dequantize(*quantize(x2))
        y = F.linear(xq, dequantize(self.w_codes, self.w_scales), self.bias)
        return y.view(*x.shape[:-1], self.out_features)


# ---- the model --------------------------------------------------------------------------------------


class Attention(nn.Module):
    def __init__(self):
        super().__init__()
        self.qkv = nn.Linear(D, 3 * D)
        self.proj = nn.Linear(D, D)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.qkv(x).view(B, T, 3, N_HEAD, C // N_HEAD).permute(2, 0, 3, 1, 4)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.proj(y.transpose(1, 2).reshape(B, T, C))


class MLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(D, 4 * D)
        self.fc2 = nn.Linear(4 * D, D)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(F.gelu(self.fc1(x)))


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.ln1, self.attn, self.ln2, self.mlp = nn.LayerNorm(D), Attention(), nn.LayerNorm(D), MLP()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))


class TinyLM(nn.Module):
    def __init__(self):
        super().__init__()
        self.wte, self.wpe = nn.Embedding(VOCAB, D), nn.Embedding(CTX, D)
        self.blocks = nn.ModuleList(Block() for _ in range(N_LAYER))
        self.ln_f, self.head = nn.LayerNorm(D), nn.Linear(D, VOCAB, bias=False)

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        x = self.wte(idx) + self.wpe(torch.arange(idx.shape[1]))
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln_f(x))


def _swap(model: nn.Module, name: str, new: nn.Module) -> None:
    parent, _, child = name.rpartition(".")
    setattr(model.get_submodule(parent), child, new)


def block_linears(model: TinyLM) -> list[str]:
    """The Linear layers inside the blocks; the embeddings and the head are not among them."""
    return [f"blocks.{name}" for name, m in model.blocks.named_modules() if isinstance(m, nn.Linear)]


# ---- calibrate, swap, measure ---------------------------------------------------------------------


@torch.no_grad()
def collect_act_amax(model: TinyLM, calib: torch.Tensor, names: list[str]) -> dict[str, torch.Tensor]:
    """One float forward over the calibration batch; the largest |input| each named Linear sees."""
    # TODO: a forward pre-hook on each named Linear keeps the running max of |input|; one forward of the
    # float model over calib fills them; remove the hooks.
    raise NotImplementedError("TODO: calibration")


@torch.no_grad()
def quantize_model(model: TinyLM, fmt: str, act_amax: dict[str, torch.Tensor] | None = None) -> TinyLM:
    """In place: every block Linear becomes NVFP4Linear (fmt "nvfp4", calibrated) or a QDQLinear baseline."""
    # TODO: replace each block Linear (block_linears) by NVFP4Linear.from_linear with its calibrated amax, or by
    # QDQLinear(linear, fmt) for the baselines. Leave the embeddings and the head alone.
    raise NotImplementedError("TODO: swap the block linears")


def weight_bytes(model: TinyLM) -> int:
    """Bytes of the block linears' weights as stored: fp32 matrices, or packed codes plus their scales."""
    # TODO: numel() * element_size() of each fp32 weight, or of the stored codes, scales (and NVFP4's global).
    raise NotImplementedError("TODO: count the stored bytes")


@torch.no_grad()
def layer_output_error(fp: TinyLM, quant: TinyLM, data: torch.Tensor) -> float:
    """Mean over block linears of ||y_q - y|| / ||y||, each layer fed the float model's own inputs."""
    names = block_linears(fp)
    inputs = {}
    handles = [
        fp.get_submodule(n).register_forward_pre_hook(lambda m, a, n=n: inputs.__setitem__(n, a[0])) for n in names
    ]
    fp(data)
    for h in handles:
        h.remove()
    errs = []
    for n in names:
        y = fp.get_submodule(n)(inputs[n])
        yq = quant.get_submodule(n)(inputs[n])
        errs.append(((yq - y).norm() / y.norm()).item())
    return sum(errs) / len(errs)


@torch.no_grad()
def perplexity(model: TinyLM, data: torch.Tensor) -> float:
    model.eval()
    logits = model(data[:, :-1])
    return math.exp(F.cross_entropy(logits.reshape(-1, VOCAB), data[:, 1:].reshape(-1)).item())


def make_corpus(n_seq: int, gen: torch.Generator, table: torch.Tensor) -> torch.Tensor:
    """Sequences from a fixed order-2 Markov chain: each pair of tokens allows a few next tokens."""
    seqs = torch.zeros(n_seq, CTX + 1, dtype=torch.long)
    seqs[:, :2] = torch.randint(VOCAB, (n_seq, 2), generator=gen)
    for t in range(2, CTX + 1):
        probs = table[seqs[:, t - 2], seqs[:, t - 1]]
        seqs[:, t] = torch.multinomial(probs, 1, generator=gen)[:, 0]
    return seqs


if __name__ == "__main__":
    torch.manual_seed(0)
    gen = torch.Generator().manual_seed(0)
    table = torch.softmax(4 * torch.randn(VOCAB, VOCAB, VOCAB, generator=gen), dim=-1)
    train, calib, held_out = (make_corpus(n, gen, table) for n in (4096, 32, 128))

    model = TinyLM()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=0.0)
    for it in range(400):
        batch = train[torch.randint(len(train), (32,), generator=gen)]
        loss = F.cross_entropy(model(batch[:, :-1]).reshape(-1, VOCAB), batch[:, 1:].reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    model.eval()

    # The baselines on one tensor: storage dtypes, the OCP scale rule, the INT4 half-step bound.
    x = torch.randn(8, 64) * 3
    codes, scales = mxfp4_quantize(x)
    assert codes.shape == (8, 32) and codes.dtype == torch.uint8
    assert scales.shape == (8, 2) and scales.dtype == torch.float8_e8m0fnu
    block_amax = x.view(8, 2, 32).abs().amax(-1)
    assert torch.equal(scales.float(), torch.exp2(torch.floor(torch.log2(block_amax)) - 2)), "X = 2^(floor(log2 amax) - 2)"
    codes, scales = int4_quantize(x)
    assert codes.shape == (8, 32) and scales.shape == (8, 2) and scales.dtype == torch.float16
    step = scales.float().repeat_interleave(INT4_GROUP, dim=1)
    assert ((int4_dequantize(codes, scales) - x).abs() <= step / 2 + 1e-6).all()

    # Calibrate the float model once, then swap the block linears; embeddings and head stay fp32.
    amax = collect_act_amax(model, calib[:, :-1], block_linears(model))
    assert len(amax) == 4 * N_LAYER and all(v > 0 for v in amax.values())
    quant = {fmt: quantize_model(copy.deepcopy(model), fmt, amax if fmt == "nvfp4" else None) for fmt in FORMATS_ALL}
    nv = quant["nvfp4"]
    layers = [m for m in nv.modules() if isinstance(m, NVFP4Linear)]
    assert len(layers) == 4 * N_LAYER and all(m.act_amax > 0 for m in layers)
    assert type(nv.head) is nn.Linear and type(nv.wte) is nn.Embedding, "head and embeddings stay in fp32"
    dynamic = quantize_model(copy.deepcopy(model), "nvfp4")
    head_too = copy.deepcopy(nv)
    head_too.head = NVFP4Linear.from_linear(model.head)

    data = held_out[:, :-1]
    ppl = {"fp32": perplexity(model, held_out)} | {fmt: perplexity(m, held_out) for fmt, m in quant.items()}
    err = {fmt: layer_output_error(model, m, data) for fmt, m in quant.items()}
    size = {"fp32": weight_bytes(model)} | {fmt: weight_bytes(m) for fmt, m in quant.items()}
    n_weights = size["fp32"] // 4
    print(f"{'format':<8}{'bits/weight':>12}{'KiB':>8}{'layer out err':>15}{'perplexity':>12}")
    for fmt in ["fp32", *FORMATS_ALL]:
        e = f"{err[fmt]:.4f}" if fmt in err else "-"
        print(f"{fmt:<8}{8 * size[fmt] / n_weights:>12.3f}{size[fmt] / 1024:>8.1f}{e:>15}{ppl[fmt]:>12.3f}")
    print(f"(bf16 would be {2 * n_weights / 1024:.0f} KiB; uniform guess perplexity {VOCAB})")
    ppl_dyn, ppl_head = perplexity(dynamic, held_out), perplexity(head_too, held_out)
    print(f"nvfp4 dynamic activation scale {ppl_dyn:.3f}; nvfp4 with the head quantized too {ppl_head:.3f}")

    assert ppl["fp32"] < 0.5 * VOCAB, "the model learned the chain"
    assert err["nvfp4"] < err["int4"] < err["mxfp4"], err
    assert ppl["fp32"] < ppl["nvfp4"] < ppl["int4"] < ppl["mxfp4"], ppl
    assert ppl_head > ppl["nvfp4"], "quantizing the head costs perplexity"
    assert abs(ppl_dyn - ppl["nvfp4"]) < 0.15, "a calibrated global scale costs nothing in range"
    assert size["nvfp4"] == n_weights * 9 // 16 + 4 * 4 * N_LAYER  # 4.5 bits + one fp32 global per layer
    assert size["mxfp4"] == n_weights * 17 // 32 and size["int4"] == n_weights * 9 // 16
    print("PASS")
`,
      solution: `"""NVFP4 for inference, part 2: post-training quantization of a small LM, against MXFP4 and INT4."""

import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from nvfp4_gemm import FP4_LUT, NVFP4Linear, e2m1_encode, e2m1_round, pack_fp4, unpack_fp4

VOCAB, CTX, D, N_LAYER, N_HEAD = 64, 64, 128, 2, 4
MX_BLOCK, INT4_GROUP = 32, 32


# ---- the two baselines ----------------------------------------------------------------------------


def mxfp4_quantize(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """OCP MX v1.0: blocks of 32 along K, one E8M0 power-of-two scale each.

    x (rows, K) -> (codes (rows, K/2) uint8, scales (rows, K/32) as E8M0, one byte each).
    """
    rows, K = x.shape
    xb = x.float().reshape(rows, K // MX_BLOCK, MX_BLOCK)
    amax = xb.abs().amax(-1)
    # shared exponent = floor(log2(amax)) - emax_elem, with emax_elem = 2 for E2M1 (largest value 6 = 1.5 * 2^2)
    e = (torch.floor(torch.log2(amax.clamp(min=2.0**-127))) - 2).clamp(-127, 127)
    scale = torch.exp2(e)
    q = e2m1_round(xb / scale[..., None])  # values past 6 saturate
    return pack_fp4(e2m1_encode(q).view(rows, K)), scale.to(torch.float8_e8m0fnu)


def mxfp4_dequantize(codes: torch.Tensor, scales: torch.Tensor) -> torch.Tensor:
    q = FP4_LUT[unpack_fp4(codes).long()]
    rows = q.shape[0]
    return (q.view(rows, -1, MX_BLOCK) * scales.float()[..., None]).view(rows, -1)


def int4_quantize(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Symmetric INT4 per group of 32 along K, one fp16 scale amax / 7 each: codes -8..7 stored as 0..15.

    x (rows, K) -> (codes (rows, K/2) uint8, scales (rows, K/32) float16).
    """
    rows, K = x.shape
    xb = x.float().reshape(rows, K // INT4_GROUP, INT4_GROUP)
    scale = (xb.abs().amax(-1) / 7).half()
    s = scale.float()[..., None]
    q = torch.where(s > 0, torch.round(xb / torch.where(s > 0, s, 1.0)), 0.0).clamp(-8, 7)
    return pack_fp4((q + 8).to(torch.uint8).view(rows, K)), scale


def int4_dequantize(codes: torch.Tensor, scales: torch.Tensor) -> torch.Tensor:
    q = unpack_fp4(codes).float() - 8
    rows = q.shape[0]
    return (q.view(rows, -1, INT4_GROUP) * scales.float()[..., None]).view(rows, -1)


FORMATS = {"mxfp4": (mxfp4_quantize, mxfp4_dequantize), "int4": (int4_quantize, int4_dequantize)}
FORMATS_ALL = ["nvfp4", *FORMATS]


class QDQLinear(nn.Module):
    """A baseline W4A4 layer: weights stored quantized, inputs quantized and dequantized per forward."""

    def __init__(self, linear: nn.Linear, fmt: str):
        super().__init__()
        self.fmt, self.in_features, self.out_features = fmt, linear.in_features, linear.out_features
        codes, scales = FORMATS[fmt][0](linear.weight.detach())
        self.register_buffer("w_codes", codes)
        self.register_buffer("w_scales", scales)
        self.register_buffer("bias", None if linear.bias is None else linear.bias.detach().float().clone())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        quantize, dequantize = FORMATS[self.fmt]
        x2 = x.reshape(-1, self.in_features)
        xq = dequantize(*quantize(x2))
        y = F.linear(xq, dequantize(self.w_codes, self.w_scales), self.bias)
        return y.view(*x.shape[:-1], self.out_features)


# ---- the model --------------------------------------------------------------------------------------


class Attention(nn.Module):
    def __init__(self):
        super().__init__()
        self.qkv = nn.Linear(D, 3 * D)
        self.proj = nn.Linear(D, D)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q, k, v = self.qkv(x).view(B, T, 3, N_HEAD, C // N_HEAD).permute(2, 0, 3, 1, 4)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.proj(y.transpose(1, 2).reshape(B, T, C))


class MLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(D, 4 * D)
        self.fc2 = nn.Linear(4 * D, D)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(F.gelu(self.fc1(x)))


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.ln1, self.attn, self.ln2, self.mlp = nn.LayerNorm(D), Attention(), nn.LayerNorm(D), MLP()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))


class TinyLM(nn.Module):
    def __init__(self):
        super().__init__()
        self.wte, self.wpe = nn.Embedding(VOCAB, D), nn.Embedding(CTX, D)
        self.blocks = nn.ModuleList(Block() for _ in range(N_LAYER))
        self.ln_f, self.head = nn.LayerNorm(D), nn.Linear(D, VOCAB, bias=False)

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        x = self.wte(idx) + self.wpe(torch.arange(idx.shape[1]))
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln_f(x))


def _swap(model: nn.Module, name: str, new: nn.Module) -> None:
    parent, _, child = name.rpartition(".")
    setattr(model.get_submodule(parent), child, new)


def block_linears(model: TinyLM) -> list[str]:
    """The Linear layers inside the blocks; the embeddings and the head are not among them."""
    return [f"blocks.{name}" for name, m in model.blocks.named_modules() if isinstance(m, nn.Linear)]


# ---- calibrate, swap, measure ---------------------------------------------------------------------


@torch.no_grad()
def collect_act_amax(model: TinyLM, calib: torch.Tensor, names: list[str]) -> dict[str, torch.Tensor]:
    """One float forward over the calibration batch; the largest |input| each named Linear sees."""
    amax = {name: torch.zeros(()) for name in names}

    def hook(name):
        def fn(module, args):
            amax[name] = torch.maximum(amax[name], args[0].detach().abs().amax())

        return fn

    handles = [model.get_submodule(name).register_forward_pre_hook(hook(name)) for name in names]
    model(calib)
    for h in handles:
        h.remove()
    return amax


@torch.no_grad()
def quantize_model(model: TinyLM, fmt: str, act_amax: dict[str, torch.Tensor] | None = None) -> TinyLM:
    """In place: every block Linear becomes NVFP4Linear (fmt "nvfp4", calibrated) or a QDQLinear baseline."""
    for name in block_linears(model):
        linear = model.get_submodule(name)
        if fmt == "nvfp4":
            new = NVFP4Linear.from_linear(linear, act_amax[name] if act_amax is not None else None)
        else:
            new = QDQLinear(linear, fmt)
        _swap(model, name, new)
    return model


def weight_bytes(model: TinyLM) -> int:
    """Bytes of the block linears' weights as stored: fp32 matrices, or packed codes plus their scales."""
    total = 0
    for m in model.blocks.modules():
        if isinstance(m, nn.Linear):
            total += m.weight.numel() * m.weight.element_size()
        elif isinstance(m, NVFP4Linear):
            total += sum(t.numel() * t.element_size() for t in (m.w_codes, m.w_scales, m.w_global))
        elif isinstance(m, QDQLinear):
            total += sum(t.numel() * t.element_size() for t in (m.w_codes, m.w_scales))
    return total


@torch.no_grad()
def layer_output_error(fp: TinyLM, quant: TinyLM, data: torch.Tensor) -> float:
    """Mean over block linears of ||y_q - y|| / ||y||, each layer fed the float model's own inputs."""
    names = block_linears(fp)
    inputs = {}
    handles = [
        fp.get_submodule(n).register_forward_pre_hook(lambda m, a, n=n: inputs.__setitem__(n, a[0])) for n in names
    ]
    fp(data)
    for h in handles:
        h.remove()
    errs = []
    for n in names:
        y = fp.get_submodule(n)(inputs[n])
        yq = quant.get_submodule(n)(inputs[n])
        errs.append(((yq - y).norm() / y.norm()).item())
    return sum(errs) / len(errs)


@torch.no_grad()
def perplexity(model: TinyLM, data: torch.Tensor) -> float:
    model.eval()
    logits = model(data[:, :-1])
    return math.exp(F.cross_entropy(logits.reshape(-1, VOCAB), data[:, 1:].reshape(-1)).item())


def make_corpus(n_seq: int, gen: torch.Generator, table: torch.Tensor) -> torch.Tensor:
    """Sequences from a fixed order-2 Markov chain: each pair of tokens allows a few next tokens."""
    seqs = torch.zeros(n_seq, CTX + 1, dtype=torch.long)
    seqs[:, :2] = torch.randint(VOCAB, (n_seq, 2), generator=gen)
    for t in range(2, CTX + 1):
        probs = table[seqs[:, t - 2], seqs[:, t - 1]]
        seqs[:, t] = torch.multinomial(probs, 1, generator=gen)[:, 0]
    return seqs


if __name__ == "__main__":
    torch.manual_seed(0)
    gen = torch.Generator().manual_seed(0)
    table = torch.softmax(4 * torch.randn(VOCAB, VOCAB, VOCAB, generator=gen), dim=-1)
    train, calib, held_out = (make_corpus(n, gen, table) for n in (4096, 32, 128))

    model = TinyLM()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=0.0)
    for it in range(400):
        batch = train[torch.randint(len(train), (32,), generator=gen)]
        loss = F.cross_entropy(model(batch[:, :-1]).reshape(-1, VOCAB), batch[:, 1:].reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    model.eval()

    # The baselines on one tensor: storage dtypes, the OCP scale rule, the INT4 half-step bound.
    x = torch.randn(8, 64) * 3
    codes, scales = mxfp4_quantize(x)
    assert codes.shape == (8, 32) and codes.dtype == torch.uint8
    assert scales.shape == (8, 2) and scales.dtype == torch.float8_e8m0fnu
    block_amax = x.view(8, 2, 32).abs().amax(-1)
    assert torch.equal(scales.float(), torch.exp2(torch.floor(torch.log2(block_amax)) - 2)), "X = 2^(floor(log2 amax) - 2)"
    codes, scales = int4_quantize(x)
    assert codes.shape == (8, 32) and scales.shape == (8, 2) and scales.dtype == torch.float16
    step = scales.float().repeat_interleave(INT4_GROUP, dim=1)
    assert ((int4_dequantize(codes, scales) - x).abs() <= step / 2 + 1e-6).all()

    # Calibrate the float model once, then swap the block linears; embeddings and head stay fp32.
    amax = collect_act_amax(model, calib[:, :-1], block_linears(model))
    assert len(amax) == 4 * N_LAYER and all(v > 0 for v in amax.values())
    quant = {fmt: quantize_model(copy.deepcopy(model), fmt, amax if fmt == "nvfp4" else None) for fmt in FORMATS_ALL}
    nv = quant["nvfp4"]
    layers = [m for m in nv.modules() if isinstance(m, NVFP4Linear)]
    assert len(layers) == 4 * N_LAYER and all(m.act_amax > 0 for m in layers)
    assert type(nv.head) is nn.Linear and type(nv.wte) is nn.Embedding, "head and embeddings stay in fp32"
    dynamic = quantize_model(copy.deepcopy(model), "nvfp4")
    head_too = copy.deepcopy(nv)
    head_too.head = NVFP4Linear.from_linear(model.head)

    data = held_out[:, :-1]
    ppl = {"fp32": perplexity(model, held_out)} | {fmt: perplexity(m, held_out) for fmt, m in quant.items()}
    err = {fmt: layer_output_error(model, m, data) for fmt, m in quant.items()}
    size = {"fp32": weight_bytes(model)} | {fmt: weight_bytes(m) for fmt, m in quant.items()}
    n_weights = size["fp32"] // 4
    print(f"{'format':<8}{'bits/weight':>12}{'KiB':>8}{'layer out err':>15}{'perplexity':>12}")
    for fmt in ["fp32", *FORMATS_ALL]:
        e = f"{err[fmt]:.4f}" if fmt in err else "-"
        print(f"{fmt:<8}{8 * size[fmt] / n_weights:>12.3f}{size[fmt] / 1024:>8.1f}{e:>15}{ppl[fmt]:>12.3f}")
    print(f"(bf16 would be {2 * n_weights / 1024:.0f} KiB; uniform guess perplexity {VOCAB})")
    ppl_dyn, ppl_head = perplexity(dynamic, held_out), perplexity(head_too, held_out)
    print(f"nvfp4 dynamic activation scale {ppl_dyn:.3f}; nvfp4 with the head quantized too {ppl_head:.3f}")

    assert ppl["fp32"] < 0.5 * VOCAB, "the model learned the chain"
    assert err["nvfp4"] < err["int4"] < err["mxfp4"], err
    assert ppl["fp32"] < ppl["nvfp4"] < ppl["int4"] < ppl["mxfp4"], ppl
    assert ppl_head > ppl["nvfp4"], "quantizing the head costs perplexity"
    assert abs(ppl_dyn - ppl["nvfp4"]) < 0.15, "a calibrated global scale costs nothing in range"
    assert size["nvfp4"] == n_weights * 9 // 16 + 4 * 4 * N_LAYER  # 4.5 bits + one fp32 global per layer
    assert size["mxfp4"] == n_weights * 17 // 32 and size["int4"] == n_weights * 9 // 16
    print("PASS")
`,
    },
  },
  debrief: `The pipeline is ModelOpt's PTQ in miniature. Calibration runs the float model with an observer on every quantized input. Then every targeted linear is replaced by a module that holds packed weights and a fixed activation scale, and the excluded modules stay as they were. ModelOpt's NVFP4 preset ("algorithm: max") calibrates exactly this way, with max calibration, and its default exclusions include \`*lm_head*\` and the MoE routers. **Why NVFP4 wins at equal bits**: an E4M3 scale has 3 mantissa bits, so each block's largest value maps to about 6 instead of anywhere in [4, 8). Blocks of 16 also adapt twice as often as MXFP4's 32. MXFP4 saves a quarter bit per weight but loses most here. Its rule \`floor(log2 amax) − 2\` sends values between 6 and 8 times the scale to the saturation value, and leaves the code for 6 unused when amax is between 4 and 5 times the scale. Rounding the scale up instead removes the clipping but recovers little (perplexity 9.565 → 9.449 on the same run), so the power-of-two steps and the 32-value blocks are the main cost. **Why INT4 lands between**: with a per-group fp16 scale it has a fine scale too, but its 15 levels (−7 to 7) are evenly spaced. A block of near-Gaussian values has most of its mass near 0, and E2M1 puts half its levels (0 to 1.5 of 6) in the lowest quarter of the range. The orderings are robust here (every asserted one held on eight seeds), but the gaps are model dependent: GELU outputs, attention outputs and LayerNorm outputs have different shapes, and large models have outlier channels that this one lacks. **What production adds**: real calibration data (hundreds of samples of the target domain); SmoothQuant, AWQ or rotations before quantizing; NVFP4 KV caches; a per-layer search over formats under a bits budget (ModelOpt's \`auto_quantize\`); and checkpoints exported with the scales in the layout TensorRT-LLM and vLLM kernels read. The memory figure is the one that ships: 216 KiB here against 768 KiB in bf16, 3.56× less, and NVIDIA's blog quotes about 3.5× against FP16 for whole models.`,
};
