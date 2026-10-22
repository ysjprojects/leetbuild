import type {Step} from '@/lib/types';

export const quantizeModelStep: Step = {
  id: 'quantize-model',
  title: 'The whole model: sequential calibration, swap, perplexity',
  concept: 'pytorch',
  file: 'gptq_model',
  focus: ['calib-ids', 'embed-cache', 'collect', 'solve', 'swap', 'propagate', 'ppl'],
  task: `## Task

Quantize every linear layer of a small transformer LM with GPTQ, in the order the data flows, so that
each layer is calibrated on the inputs it will really see: the outputs of the layers already quantized.
Then measure what 4 bits cost.

The file provides \`TinyLM\` (vocabulary 64, context 64, width 128, 2 pre-norm blocks with 4 heads, an MLP
of 512; \`model.embed(idx)\` returns the first block's input), \`SEQUENTIAL = [["attn.qkv"], ["attn.proj"],
["mlp.fc1"], ["mlp.fc2"]]\`, \`_swap(block, name, module)\`, \`perplexity(model, data)\` and a corpus drawn
from a fixed order-2 Markov chain. Write:

- \`quantize_model_gptq(model, calib, bits=4, group_size=128, blocksize=128)\`, in place, under \`torch.no_grad()\`:
  - \`inps = model.embed(calib)\` **once**: the first block's inputs for all calibration sequences.
  - For each block, for each group of \`SEQUENTIAL\` in order: a \`HessianCollector\` on each linear of the
    group, one \`block(inps)\` to fill them, remove the hooks, \`gptq_quantize(layer.weight, H, …)\`, and
    \`_swap\` in \`QuantLinear.from_quantized(…)\`. Later groups of the block now see quantized outputs.
  - Then \`inps = block(inps)\` with the **quantized** block: the next block calibrates on what this one
    really produces, its quantization error included.
  - The embeddings, the final LayerNorm and the head stay float32.
- \`quantize_model_rtn(model, bits=4, group_size=128)\`: the baseline, \`quantize_rtn\` on the same layers,
  no data.
- \`linear_weight_bytes(model)\`: bytes of the blocks' linear weights, \`numel · element_size\` of an
  \`nn.Linear\` weight or of a \`QuantLinear\`'s three buffers (the head excluded).

The self-test trains the model for 400 AdamW steps (about 10 s on a laptop CPU), quantizes deep copies
with GPTQ (64 calibration sequences, 4,096 tokens) and with RTN, and checks that every block linear is a
\`QuantLinear\`, that held-out perplexity is ordered **fp32 ≤ GPTQ < RTN** (one run printed 8.142, 8.285
and 8.445 against 64 for a uniform guess: GPTQ loses less than half of what RTN loses), and that the
block weights shrink from 1,536 KiB to 201 KiB, exactly \`32 / 4.1875 = 7.64×\`. Then it prints \`PASS\`.

> Quantizing layer by layer on the quantized model's own activations lets each layer correct the drift
> of the ones below it, at the cost of one forward pass of one block per group.`,
  hints: [
    'Collect, then quantize, then swap: the hooks must be removed before you replace the module, and the block forward that fills them runs with every earlier group already a `QuantLinear`.',
    '`block.get_submodule("attn.qkv")` returns the layer; `_swap(block, "attn.qkv", new)` sets it on its parent. `gptq_quantize` returns exactly what `QuantLinear.from_quantized` takes.',
    'The last line inside the block loop is `inps = block(inps)`, after every group is swapped: it costs one more forward of one block, and it is what makes the method sequential across blocks.',
  ],
  checks: [
    {
      id: 'cached-inputs',
      title: 'The first block’s inputs are computed once',
      detail:
        '`model.embed(calib)` runs once and the result is passed from block to block: the reference does the same by catching the inputs of layer 0 and never running the full model again.',
      match: {python: {all: [/model\.embed\(/]}},
    },
    {
      id: 'collect-solve-swap',
      title: 'Collect H, run GPTQ, swap in a QuantLinear, in that order',
      detail:
        'A `HessianCollector` per layer, then `gptq_quantize` on its `H`, then `QuantLinear.from_quantized` in the layer’s place.',
      match: {
        python: {
          order: [/HessianCollector\(/, /gptq_quantize\(/, /QuantLinear(?:\.from_quantized)?\(/],
        },
      },
    },
    {
      id: 'propagate',
      title: 'The next block calibrates on the quantized block’s output',
      detail:
        'After a block’s layers are swapped, its inputs are run through it again (`inps = block(inps)`): the next block’s Hessians are built from what the quantized model produces.',
      match: {python: {order: [/gptq_quantize\(/, /(\w+)\s*=\s*\w+\(\s*\1\s*[,)]/]}},
    },
    {
      id: 'rtn-baseline',
      title: 'Round-to-nearest baseline on the same layers',
      detail:
        '`quantize_rtn` from step 1 on the same linears with the same group size: the only difference between the two models is the error feedback.',
      match: {python: {all: [/quantize_rtn\(/]}},
    },
    {
      id: 'bytes',
      title: 'Weight memory counted from the stored tensors',
      detail:
        '`numel() * element_size()` of each fp32 weight or of `qweight`, `scales` and `zeros`: the reduction is measured, not assumed.',
      match: {python: {all: [/element_size\(\)/]}},
    },
    {
      id: 'no-library',
      title: 'No quantization library',
      detail: 'No `auto_gptq`, `gptqmodel`, `optimum` or `transformers`: the pipeline is the exercise.',
      match: {python: {none: [/auto_gptq/, /gptqmodel/i, /optimum/, /from transformers|import transformers/]}},
    },
  ],
  code: {
    python: {
      starter: `"""GPTQ on a small transformer LM, layer by layer: calibration activations flow through what is already quantized."""

import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from gptq_hessian import HessianCollector
from gptq_solver import gptq_quantize
from quant_int4 import QuantLinear, quantize_rtn

VOCAB, CTX, D, N_LAYER, N_HEAD = 64, 64, 128, 2, 4


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

    def embed(self, idx: torch.Tensor) -> torch.Tensor:
        return self.wte(idx) + self.wpe(torch.arange(idx.shape[1]))

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        x = self.embed(idx)
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln_f(x))


# The order a block's linears are quantized in: each group sees inputs from the groups before it, quantized.
SEQUENTIAL = [["attn.qkv"], ["attn.proj"], ["mlp.fc1"], ["mlp.fc2"]]


def _swap(block: nn.Module, name: str, new: nn.Module) -> None:
    parent, _, child = name.rpartition(".")
    setattr(block.get_submodule(parent), child, new)


@torch.no_grad()
def quantize_model_gptq(
    model: TinyLM, calib: torch.Tensor, bits: int = 4, group_size: int = 128, blocksize: int = 128
) -> TinyLM:
    """In place: every Linear inside the blocks becomes a QuantLinear; the embeddings and the head stay fp32."""
    # TODO: run the calibration ids through the embeddings once and keep the result as the first block's
    # inputs. For each block, for each group of SEQUENTIAL in order: hook a HessianCollector on each of
    # its linears, run the block on the cached inputs, quantize each with gptq_quantize and swap in a
    # QuantLinear. Then run the now quantized block to get the next block's inputs.
    raise NotImplementedError("TODO: sequential GPTQ over the blocks")


@torch.no_grad()
def quantize_model_rtn(model: TinyLM, bits: int = 4, group_size: int = 128) -> TinyLM:
    """The baseline: the same layers rounded to nearest, no calibration data."""
    raise NotImplementedError("TODO: round every block linear to nearest and swap in a QuantLinear")


def linear_weight_bytes(model: nn.Module) -> int:
    """Bytes of the blocks' linear weights: fp32 matrices, or packed codes plus scales and zeros."""
    raise NotImplementedError("TODO: sum the stored bytes of each weight, packed or not")


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
    train, calib, held_out = (make_corpus(n, gen, table) for n in (4096, 64, 256))

    model = TinyLM()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=0.0)
    for it in range(400):
        batch = train[torch.randint(len(train), (32,), generator=gen)]
        loss = F.cross_entropy(model(batch[:, :-1]).reshape(-1, VOCAB), batch[:, 1:].reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

    ppl_fp = perplexity(model, held_out)
    gptq = quantize_model_gptq(copy.deepcopy(model), calib[:, :-1])
    rtn = quantize_model_rtn(copy.deepcopy(model))
    ppl_gptq, ppl_rtn = perplexity(gptq, held_out), perplexity(rtn, held_out)
    print(f"held-out perplexity: fp32 {ppl_fp:.3f}  gptq {ppl_gptq:.3f}  rtn {ppl_rtn:.3f}  (uniform {VOCAB})")

    n_quant = sum(isinstance(m, QuantLinear) for m in gptq.modules())
    assert n_quant == 4 * N_LAYER and not any(isinstance(m, nn.Linear) for m in gptq.blocks.modules())
    assert ppl_fp < 0.5 * VOCAB, "the model learned the chain"
    assert ppl_fp <= ppl_gptq < ppl_rtn, (ppl_fp, ppl_gptq, ppl_rtn)
    print(f"perplexity lost to 4 bits: gptq {ppl_gptq - ppl_fp:.3f}, rtn {ppl_rtn - ppl_fp:.3f}")

    fp_bytes, q_bytes = linear_weight_bytes(model), linear_weight_bytes(gptq)
    print(f"block linears: {fp_bytes / 1024:.0f} KiB fp32 -> {q_bytes / 1024:.0f} KiB int4 ({fp_bytes / q_bytes:.2f}x)")
    assert abs(fp_bytes / q_bytes - 32 / (4 + 24 / 128)) < 1e-6
    print("PASS")
`,
      solution: `"""GPTQ on a small transformer LM, layer by layer: calibration activations flow through what is already quantized."""

import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from gptq_hessian import HessianCollector
from gptq_solver import gptq_quantize
from quant_int4 import QuantLinear, quantize_rtn

VOCAB, CTX, D, N_LAYER, N_HEAD = 64, 64, 128, 2, 4


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

    def embed(self, idx: torch.Tensor) -> torch.Tensor:
        return self.wte(idx) + self.wpe(torch.arange(idx.shape[1]))

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        x = self.embed(idx)
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln_f(x))


# The order a block's linears are quantized in: each group sees inputs from the groups before it, quantized.
SEQUENTIAL = [["attn.qkv"], ["attn.proj"], ["mlp.fc1"], ["mlp.fc2"]]


def _swap(block: nn.Module, name: str, new: nn.Module) -> None:
    parent, _, child = name.rpartition(".")
    setattr(block.get_submodule(parent), child, new)


@torch.no_grad()
def quantize_model_gptq(
    model: TinyLM, calib: torch.Tensor, bits: int = 4, group_size: int = 128, blocksize: int = 128
) -> TinyLM:
    """In place: every Linear inside the blocks becomes a QuantLinear; the embeddings and the head stay fp32."""
    model.eval()
    inps = model.embed(calib)  # the first block's inputs, computed once
    for block in model.blocks:
        for names in SEQUENTIAL:
            layers = {name: block.get_submodule(name) for name in names}
            collectors = {name: HessianCollector(layer) for name, layer in layers.items()}
            block(inps)  # earlier groups of this block are already QuantLinear
            for name, layer in layers.items():
                collectors[name].remove()
                codes, scales, zeros = gptq_quantize(layer.weight, collectors[name].H, bits, group_size, blocksize)
                _swap(block, name, QuantLinear.from_quantized(layer, codes, scales, zeros, group_size))
        inps = block(inps)  # the next block calibrates on what the quantized block produces
    return model


@torch.no_grad()
def quantize_model_rtn(model: TinyLM, bits: int = 4, group_size: int = 128) -> TinyLM:
    """The baseline: the same layers rounded to nearest, no calibration data."""
    for block in model.blocks:
        for names in SEQUENTIAL:
            for name in names:
                layer = block.get_submodule(name)
                codes, scales, zeros = quantize_rtn(layer.weight, bits, group_size)
                _swap(block, name, QuantLinear.from_quantized(layer, codes, scales, zeros, group_size))
    return model


def linear_weight_bytes(model: nn.Module) -> int:
    """Bytes of the blocks' linear weights: fp32 matrices, or packed codes plus scales and zeros."""
    total = 0
    for m in model.modules():
        if isinstance(m, QuantLinear):
            total += sum(b.numel() * b.element_size() for b in (m.qweight, m.scales, m.zeros))
        elif isinstance(m, nn.Linear) and m is not getattr(model, "head", None):
            total += m.weight.numel() * m.weight.element_size()
    return total


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
    train, calib, held_out = (make_corpus(n, gen, table) for n in (4096, 64, 256))

    model = TinyLM()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=0.0)
    for it in range(400):
        batch = train[torch.randint(len(train), (32,), generator=gen)]
        loss = F.cross_entropy(model(batch[:, :-1]).reshape(-1, VOCAB), batch[:, 1:].reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

    ppl_fp = perplexity(model, held_out)
    gptq = quantize_model_gptq(copy.deepcopy(model), calib[:, :-1])
    rtn = quantize_model_rtn(copy.deepcopy(model))
    ppl_gptq, ppl_rtn = perplexity(gptq, held_out), perplexity(rtn, held_out)
    print(f"held-out perplexity: fp32 {ppl_fp:.3f}  gptq {ppl_gptq:.3f}  rtn {ppl_rtn:.3f}  (uniform {VOCAB})")

    n_quant = sum(isinstance(m, QuantLinear) for m in gptq.modules())
    assert n_quant == 4 * N_LAYER and not any(isinstance(m, nn.Linear) for m in gptq.blocks.modules())
    assert ppl_fp < 0.5 * VOCAB, "the model learned the chain"
    assert ppl_fp <= ppl_gptq < ppl_rtn, (ppl_fp, ppl_gptq, ppl_rtn)
    print(f"perplexity lost to 4 bits: gptq {ppl_gptq - ppl_fp:.3f}, rtn {ppl_rtn - ppl_fp:.3f}")

    fp_bytes, q_bytes = linear_weight_bytes(model), linear_weight_bytes(gptq)
    print(f"block linears: {fp_bytes / 1024:.0f} KiB fp32 -> {q_bytes / 1024:.0f} KiB int4 ({fp_bytes / q_bytes:.2f}x)")
    assert abs(fp_bytes / q_bytes - 32 / (4 + 24 / 128)) < 1e-6
    print("PASS")
`,
    },
  },
  debrief: `The loop is the reference's \`llama_sequential\` with \`--true-sequential\`: catch the inputs of the first decoder layer with a stand-in module that records them and raises, then walk the layers, quantize the sublayers in the order \`[q, k, v] → o → [gate, up] → down\`, and run each finished layer once more to produce the next one's inputs. Only one layer is ever on the GPU, which is how GPTQ quantizes a 175B model on a single 80 GB A100 in about four GPU hours. **Why sequential**: a layer quantized on the float model's activations is optimised for inputs it will never see; on the quantized model's activations its Hessian includes the earlier layers' errors. The paper reports noticeable gains from this at negligible cost; on this two-block model the float-activation variant lands within 0.02 perplexity, because there is little depth for errors to accumulate. **What stays in float**: the embeddings and the head (often the largest single matrix of a small model), the norms and the biases. The numbers here are small because the model is: 7.64× less block-weight memory than fp32 is 3.82× less than fp16, the figure that matters on a GPU, and GPTQ removes about half of RTN's perplexity loss on this tiny model; on large models the gap is much wider, since RTN at 3 bits collapses and GPTQ does not. Production adds act-order, symmetric or asymmetric grids per checkpoint, packed \`qzeros\`, the fused int4 kernels that make inference faster rather than only smaller, and an evaluation on WikiText-2 perplexity and zero-shot tasks.`,
};
