import type {Step} from '@/lib/types';

export const hessianStep: Step = {
  id: 'hessian',
  title: 'The layer Hessian: hooks, running average, damping',
  concept: 'pytorch',
  file: 'gptq_hessian',
  focus: ['calib', 'hessian', 'damp'],
  task: `## Task

GPTQ minimises one layer's output error \`‖WX − ŴX‖²\` over a few thousand calibration tokens. That
loss is a quadratic form in the weight error, and its matrix is the Hessian \`H = (2/n) Σ x xᵀ\`: build it
from the layer's real inputs and make it safe to factor (\`from quant_int4 import dequantize, quantize_rtn\`).

- \`HessianCollector(layer)\` for an \`nn.Linear\`:
  - \`H\`: a \`(in_features, in_features)\` **float32** zero matrix; \`nsamples = 0\`.
  - A hook from \`layer.register_forward_pre_hook\`, so it sees the input before the matmul. Every token is
    one sample: \`args[0]\` of shape \`(..., in_features)\` is flattened to \`(n, in_features)\` and cast to float32.
  - A **running average**: \`H *= nsamples / (nsamples + n)\`, \`nsamples += n\`, then add
    \`(√(2 / nsamples) · x)ᵀ (√(2 / nsamples) · x)\`. After any sequence of batches,
    \`H = (2 / N) XᵀX\` over all \`N\` tokens seen, with no sum that grows with \`N\`.
  - \`remove()\` detaches the hook.
- \`prepare_hessian(H, W, percdamp=0.01) -> (H, W)\`: on **copies**, float32.
  - **Dead columns**: where \`diag(H) == 0\` the input was always 0. Set that \`H[j, j] = 1\` and zero
    \`W[:, j]\`: the weight cannot change the output, and the row of zeros would make \`H\` singular.
  - **Damping**: \`λ = percdamp · mean(diag H)\` added to the diagonal. It bounds the condition number,
    so the Cholesky factorisation of the next step succeeds in float32.

The self-test feeds three batches of shapes \`(4, 10, 64)\`, \`(3, 25, 64)\` and \`(17, 64)\` with input 5 always 0,
and checks \`H\` against \`(2/n) XᵀX\` on the concatenated inputs in float64 (rtol 1e-5), that the hook is
gone after \`remove()\`, the identity \`‖(W − Ŵ)Xᵀ‖² = (n/2) · tr(ΔW H ΔWᵀ)\` for the step-1 RTN error,
that the raw \`H\` has no Cholesky factor and the prepared one does, and that the inputs were not
modified. Then it prints \`PASS\`.

> \`H\` is the layer's loss surface: every quantization decision in the next step is scored by
> \`tr(ΔW H ΔWᵀ)\`, so an error along a direction the inputs never take costs nothing, and one along
> their main direction costs the most.`,
  hints: [
    'In the hook, `x = args[0].detach().reshape(-1, in_features).float()`; `n = x.shape[0]` counts tokens, not sequences.',
    'Scale before you add: `self.H *= self.nsamples / (self.nsamples + n)`, `self.nsamples += n`, `x = math.sqrt(2 / self.nsamples) * x`, `self.H += x.t() @ x`. Check it by hand for two batches of one token each.',
    'With a boolean mask `dead = torch.diag(H) == 0`, `H[dead, dead] = 1` sets only diagonal entries (the two masks pair up index by index) and `W[:, dead] = 0` zeroes the columns. Then `H += damp * torch.eye(d)`.',
  ],
  checks: [
    {
      id: 'pre-hook',
      title: 'A forward pre-hook that can be removed',
      detail:
        '`layer.register_forward_pre_hook(…)` sees the layer’s input before the matmul, during an ordinary forward of the whole model; its handle’s `.remove()` restores the layer. No copy of the model is needed to calibrate it.',
      match: {python: {all: [/register_forward_pre_hook\(/, /\.remove\(\)/]}},
    },
    {
      id: 'tokens',
      title: 'Every token is one sample',
      detail:
        'The input `(batch, seq, in_features)` is flattened to `(batch · seq, in_features)` with `reshape(-1, …)` or `flatten(0, -2)`: each position is one `x` of the sum, which is how the layer sees it.',
      match: {python: {all: [/(?:reshape|view)\(\s*-1\s*,|flatten\(\s*0\s*,\s*-2\s*\)/]}},
    },
    {
      id: 'float32',
      title: 'Accumulated in float32',
      detail:
        '`H` starts as a float32 zero matrix and each batch is cast with `.float()` before the outer product: in bf16 or fp16 the sum of thousands of outer products loses most of its digits.',
      match: {
        python: {
          all: [/(?:zeros|empty)\([^\n]*(?:torch\.float32|torch\.float\b)/, /\.float\(\)|\.to\(\s*torch\.float32\s*\)/],
        },
      },
    },
    {
      id: 'running-average',
      title: 'H stays (2/n) Σ x xᵀ after every batch',
      detail:
        'The running `H` is rescaled by `nsamples / (nsamples + n)` before the new batch, scaled by `2 / nsamples`, is added: the result equals the average over all tokens however the batches were split.',
      match: {
        python: {
          all: [/self\.nsamples\s*\/\s*\(\s*self\.nsamples\s*\+/, /self\.nsamples\s*\+=/, /2\s*\/\s*self\.nsamples/],
        },
      },
    },
    {
      id: 'dead-columns',
      title: 'Dead inputs: diagonal set to 1, weight column zeroed',
      detail:
        'Where `diag(H) == 0` the input never fired. `H[j, j] = 1` makes the matrix invertible and `W[:, j] = 0` records that the weight is irrelevant, as the GPTQ reference does.',
      match: {
        python: {
          all: [/diag(?:onal)?\([^\n]*\)\s*==\s*0/, /W\[\s*:\s*,\s*\w+\s*\]\s*=\s*0/],
        },
      },
    },
    {
      id: 'damping',
      title: 'Damping relative to the mean diagonal',
      detail:
        '`λ = percdamp · mean(diag H)` on the diagonal: relative, so it means the same for any input scale. 1% is the GPTQ default; it bounds the condition number without moving the solution much.',
      match: {python: {all: [/percdamp\s*\*[^\n]*(?:mean|diag)/]}},
    },
  ],
  code: {
    python: {
      starter: `"""The layer Hessian GPTQ works from: H = (2/n) * sum of x x^T over calibration tokens, then made invertible."""

import math

import torch
import torch.nn as nn

from quant_int4 import dequantize, quantize_rtn


class HessianCollector:
    """Accumulates H = (2/n) X^T X of a Linear's inputs from a forward pre-hook, as a running average in float32."""

    def __init__(self, layer: nn.Linear):
        self.layer = layer
        # TODO: H, a float32 (in_features, in_features) zero matrix; nsamples = 0; register _hook as a
        # forward pre-hook on the layer and keep its handle.
        raise NotImplementedError("TODO: H, the sample count and the hook")

    def _hook(self, module: nn.Module, args: tuple) -> None:
        # TODO: every token of args[0] is one sample. Rescale the running H to the new count, then add
        # the batch's outer products so that H stays (2 / n) times the sum over all n samples seen.
        raise NotImplementedError("TODO: fold this batch into the running average")

    def remove(self) -> None:
        raise NotImplementedError("TODO: detach the hook")


def prepare_hessian(H: torch.Tensor, W: torch.Tensor, percdamp: float = 0.01) -> tuple[torch.Tensor, torch.Tensor]:
    """Copies of H and W with dead inputs removed and H damped so its Cholesky factor exists.

    A column whose input was always 0 has H[j, j] == 0: its weight cannot affect the output, so it is
    zeroed and H[j, j] set to 1. Then lambda = percdamp * mean(diag H) is added to the diagonal.
    """
    raise NotImplementedError("TODO: dead columns, then damping, on copies")


if __name__ == "__main__":
    torch.manual_seed(0)
    d_in, d_out = 64, 32
    lin = nn.Linear(d_in, d_out)
    collector = HessianCollector(lin)

    # Batches of different shapes, one input feature always zero (a dead column).
    batches = [torch.randn(4, 10, d_in), torch.randn(3, 25, d_in), torch.randn(17, d_in)]
    for b in batches:
        b[..., 5] = 0.0
    with torch.no_grad():
        for b in batches:
            lin(b)
    collector.remove()

    # Against the formula on the concatenated inputs.
    X = torch.cat([b.reshape(b.numel() // d_in, d_in) for b in batches])
    n = X.shape[0]
    H_ref = (2 / n) * X.double().t() @ X.double()
    assert collector.nsamples == n == 4 * 10 + 3 * 25 + 17
    assert collector.H.dtype == torch.float32
    assert torch.allclose(collector.H.double(), H_ref, rtol=1e-5, atol=1e-5)

    # The hook is gone: another forward leaves H alone.
    before = collector.H.clone()
    with torch.no_grad():
        lin(torch.randn(8, d_in))
    assert torch.equal(collector.H, before)

    # H is the layer's loss surface: ||(W - W_hat) X^T||^2 = (n / 2) * tr(dW H dW^T).
    W = lin.weight.detach()
    q, s, z = quantize_rtn(W, bits=4, group_size=32)
    dW = (W - dequantize(q, s, z, 32)).double()
    out_err = ((X.double() @ dW.t()) ** 2).sum()
    quad = (n / 2) * torch.trace(dW @ collector.H.double() @ dW.t())
    assert torch.allclose(out_err, quad, rtol=1e-4), (out_err.item(), quad.item())

    # The raw H is singular (the dead column); the prepared one has a Cholesky factor.
    assert torch.linalg.cholesky_ex(collector.H).info.item() > 0
    H, W2 = prepare_hessian(collector.H, W, percdamp=0.01)
    assert collector.H[5, 5] == 0 and W[:, 5].abs().sum() > 0, "inputs are not modified"
    damp = 0.01 * (torch.diag(collector.H).sum() + 1) / d_in
    assert torch.isclose(H[5, 5], 1 + damp) and torch.all(W2[:, 5] == 0)
    off = ~torch.eye(d_in, dtype=torch.bool)
    assert torch.equal(H[off], collector.H[off])
    assert torch.allclose(torch.diag(H)[:5], torch.diag(collector.H)[:5] + damp)
    L = torch.linalg.cholesky(H)
    assert torch.allclose(L @ L.t(), H, atol=1e-4)
    print(f"H {tuple(H.shape)} from {n} tokens, damping {damp.item():.4f}, cond(H) {torch.linalg.cond(H).item():.1f}")
    print("PASS")
`,
      solution: `"""The layer Hessian GPTQ works from: H = (2/n) * sum of x x^T over calibration tokens, then made invertible."""

import math

import torch
import torch.nn as nn

from quant_int4 import dequantize, quantize_rtn


class HessianCollector:
    """Accumulates H = (2/n) X^T X of a Linear's inputs from a forward pre-hook, as a running average in float32."""

    def __init__(self, layer: nn.Linear):
        self.layer = layer
        self.H = torch.zeros(layer.in_features, layer.in_features, dtype=torch.float32)
        self.nsamples = 0
        self.handle = layer.register_forward_pre_hook(self._hook)

    def _hook(self, module: nn.Module, args: tuple) -> None:
        x = args[0].detach().reshape(-1, self.layer.in_features).float()  # every token is one sample
        n = x.shape[0]
        self.H *= self.nsamples / (self.nsamples + n)
        self.nsamples += n
        x = math.sqrt(2 / self.nsamples) * x
        self.H += x.t() @ x

    def remove(self) -> None:
        self.handle.remove()


def prepare_hessian(H: torch.Tensor, W: torch.Tensor, percdamp: float = 0.01) -> tuple[torch.Tensor, torch.Tensor]:
    """Copies of H and W with dead inputs removed and H damped so its Cholesky factor exists.

    A column whose input was always 0 has H[j, j] == 0: its weight cannot affect the output, so it is
    zeroed and H[j, j] set to 1. Then lambda = percdamp * mean(diag H) is added to the diagonal.
    """
    H = H.clone().float()
    W = W.clone().float()
    dead = torch.diag(H) == 0
    H[dead, dead] = 1
    W[:, dead] = 0
    damp = percdamp * torch.mean(torch.diag(H))
    H += damp * torch.eye(H.shape[0], dtype=H.dtype)
    return H, W


if __name__ == "__main__":
    torch.manual_seed(0)
    d_in, d_out = 64, 32
    lin = nn.Linear(d_in, d_out)
    collector = HessianCollector(lin)

    # Batches of different shapes, one input feature always zero (a dead column).
    batches = [torch.randn(4, 10, d_in), torch.randn(3, 25, d_in), torch.randn(17, d_in)]
    for b in batches:
        b[..., 5] = 0.0
    with torch.no_grad():
        for b in batches:
            lin(b)
    collector.remove()

    # Against the formula on the concatenated inputs.
    X = torch.cat([b.reshape(b.numel() // d_in, d_in) for b in batches])
    n = X.shape[0]
    H_ref = (2 / n) * X.double().t() @ X.double()
    assert collector.nsamples == n == 4 * 10 + 3 * 25 + 17
    assert collector.H.dtype == torch.float32
    assert torch.allclose(collector.H.double(), H_ref, rtol=1e-5, atol=1e-5)

    # The hook is gone: another forward leaves H alone.
    before = collector.H.clone()
    with torch.no_grad():
        lin(torch.randn(8, d_in))
    assert torch.equal(collector.H, before)

    # H is the layer's loss surface: ||(W - W_hat) X^T||^2 = (n / 2) * tr(dW H dW^T).
    W = lin.weight.detach()
    q, s, z = quantize_rtn(W, bits=4, group_size=32)
    dW = (W - dequantize(q, s, z, 32)).double()
    out_err = ((X.double() @ dW.t()) ** 2).sum()
    quad = (n / 2) * torch.trace(dW @ collector.H.double() @ dW.t())
    assert torch.allclose(out_err, quad, rtol=1e-4), (out_err.item(), quad.item())

    # The raw H is singular (the dead column); the prepared one has a Cholesky factor.
    assert torch.linalg.cholesky_ex(collector.H).info.item() > 0
    H, W2 = prepare_hessian(collector.H, W, percdamp=0.01)
    assert collector.H[5, 5] == 0 and W[:, 5].abs().sum() > 0, "inputs are not modified"
    damp = 0.01 * (torch.diag(collector.H).sum() + 1) / d_in
    assert torch.isclose(H[5, 5], 1 + damp) and torch.all(W2[:, 5] == 0)
    off = ~torch.eye(d_in, dtype=torch.bool)
    assert torch.equal(H[off], collector.H[off])
    assert torch.allclose(torch.diag(H)[:5], torch.diag(collector.H)[:5] + damp)
    L = torch.linalg.cholesky(H)
    assert torch.allclose(L @ L.t(), H, atol=1e-4)
    print(f"H {tuple(H.shape)} from {n} tokens, damping {damp.item():.4f}, cond(H) {torch.linalg.cond(H).item():.1f}")
    print("PASS")
`,
    },
  },
  debrief: `This is \`GPTQ.add_batch\` from the reference implementation, with one deliberate difference: it counts tokens where the reference counts sequences (\`inp.shape[0]\` before flattening), which scales \`H\` by the sequence length. GPTQ does not care about a constant factor (the update \`err / U[i, i]\` and \`err · U[i, i:]\` cancel it, and the damping is relative), so both are right; counting tokens makes \`H\` the textbook \`(2/n) XᵀX\`. **Why the Hessian is enough**: the layer's loss \`‖(W − Ŵ)X‖²\` is exactly quadratic in the weights, so its second derivative is the whole story, and it is the same \`d × d\` matrix for every output row. That is what makes GPTQ cheap: one \`H\` per layer, shared by 4,096 rows of a 7B model's projection. **The running average** keeps \`H\` at the scale of one token whatever the calibration size, so float32 stays accurate across 128 sequences × 2,048 tokens. **Dead columns** happen in real models: some input features of \`fc2\` are always 0 after a ReLU, and padded positions contribute nothing. **Damping** at 1% is the reference default (\`--percdamp .01\`); AutoGPTQ exposes the same knob as \`damp_percent\`. Production code adds device placement (one decoder layer on the GPU at a time, its inputs cached) and calibrates on 128 random sequences of 2,048 tokens from C4 or WikiText.`,
};
