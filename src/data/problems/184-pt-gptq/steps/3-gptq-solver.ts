import type {Step} from '@/lib/types';

export const gptqSolverStep: Step = {
  id: 'gptq-solver',
  title: 'The GPTQ solver: Cholesky of H⁻¹, error feedback, lazy batches',
  concept: 'pytorch',
  file: 'gptq_solver',
  focus: ['chol', 'group-params', 'quant-col', 'err', 'update', 'lazy', 'codes'],
  task: `## Task

Quantize a weight matrix the way the GPTQ paper does: one column at a time, left to right, each
column's rounding error pushed onto the columns not yet quantized so the layer's **output** stays close,
not each weight. Use \`prepare_hessian\` from step 2 and \`quant_params\` / \`quantize\` from step 1.

- \`gptq_quantize(W, H, bits=4, group_size=128, blocksize=128, percdamp=0.01) -> (codes, scales, zeros)\`,
  the same shapes and dtypes as \`quantize_rtn\`; \`blocksize % group_size == 0\`.
  - \`H, W = prepare_hessian(H, W, percdamp)\`.
  - \`U\` = the **upper** Cholesky factor of \`H⁻¹\`: \`torch.linalg.cholesky\` of \`H\`,
    \`torch.cholesky_inverse\`, then \`torch.linalg.cholesky(…, upper=True)\`. Row \`i\` of \`U\`, divided by
    \`U[i, i]\`, is the optimal move of columns \`i..\` per unit of column \`i\`'s error, once columns \`0..i−1\` are fixed.
  - For each block of \`blocksize\` columns \`[i1, i2)\`, a working copy \`W1\` and an error matrix \`Err1\`;
    for each column \`i\` of the block:
    - at a group's first column (\`col % group_size == 0\`), new \`scale, zero\` from \`quant_params\` of
      the group's columns **as they are now**, after every earlier column's updates;
    - \`q = quantize(w, scale, zero)\`, \`err = (w − scale · (q − zero)) / U[i, i]\`;
    - \`W1[:, i:] −= err · U[i, i:]\` (the rest of this block, now), and \`Err1[:, i] = err\`.
  - After the block, the **lazy batch update** \`W[:, i2:] −= Err1 @ U[i1:i2, i2:]\`: one matmul for every later column.
- No \`auto_gptq\`, \`gptqmodel\` or \`optimum\`, and no explicit inverse in the loop.

:::widget int4-quant {"bits": 4, "group": 32}

The self-test builds \`2,048\` correlated inputs of width 256 (32 latent factors plus noise, uneven feature
scales), collects \`H\` with step 2's hook, and quantizes a \`64 × 256\` layer. It asserts:

- the output error \`‖WXᵀ − ŴXᵀ‖²\` of GPTQ is under a third of round-to-nearest's (one run printed
  2,687 against 13,361, 4.97× lower), while GPTQ's own weight error \`‖W − Ŵ‖²\` is **larger** (0.174 against 0.093);
- \`blocksize\` 32 and 128 give the same codes (at least 99.9% equal): lazy batching only reorders the updates;
- a slow reference (explicit \`H⁻¹\` in float64, one column at a time, the OBS update and the inverse
  downdate \`H⁻¹ −= H⁻¹[:, c] H⁻¹[c, :] / H⁻¹[c, c]\`) lands on the same weights: 99% within 1e-4 and output
  errors within 1%.

Then it prints \`PASS\`.

> Round to nearest minimises each weight's error; GPTQ minimises the layer's. It accepts a worse weight
> whenever a later, correlated column can cancel the difference, and the Cholesky factor of \`H⁻¹\`
> says exactly how much each later column should move.`,
  hints: [
    '`torch.cholesky_inverse` takes the lower factor of `H` and returns `H⁻¹`; factor that again with `upper=True`. Work on a clone `W1` of the block and keep `w` as a `(rows, 1)` slice, so the in-block update is an outer product with a row of `U`.',
    'Take a group’s grid from `W1[:, i:i + group_size]`: earlier columns of this block have already moved these weights, and `W` does not hold those updates yet. That is also why `blocksize % group_size == 0`: a group never straddles two blocks.',
    'The within-block update `W1[:, i:] -= err @ Hinv1[i:i + 1, i:]` changes only this block. After the inner loop, `W[:, i2:] -= Err1 @ Hinv[i1:i2, i2:]` applies the same updates to every later column in one matmul, because each later column receives a sum of `err_k · U[k, j]` over the block’s `k`.',
  ],
  checks: [
    {
      id: 'cholesky',
      title: 'Upper Cholesky factor of H⁻¹',
      detail:
        '`H⁻¹` from `torch.cholesky_inverse` (or `torch.linalg.inv`), then `torch.linalg.cholesky(…, upper=True)`: its rows give every update the sequential algorithm needs, without updating an inverse after each column.',
      match: {
        python: {
          all: [/cholesky\([^\n]*upper\s*=\s*True/, /cholesky_inverse\(|linalg\.inv\(/],
          none: [/linalg\.pinv\(/],
        },
      },
    },
    {
      id: 'group-grid',
      title: 'A group’s grid comes from the updated weights',
      detail:
        'At each group’s first column (`col % group_size == 0`) `quant_params` is called on the group’s columns as they are after the earlier updates. A grid fixed up front from the original `W` misses weights that the updates pushed outside it.',
      match: {python: {order: [/%\s*group_size\s*==\s*0/, /quant_params\(/]}},
    },
    {
      id: 'scaled-error',
      title: 'The error is divided by U’s diagonal',
      detail:
        '`err = (w − ŵ) / U[i, i]`: the OBS step `δ = −(w − ŵ) / [H⁻¹]ᵢᵢ · H⁻¹[i, :]`, written with the Cholesky row so that `err · U[i, j]` is the update of column `j`.',
      match: {python: {all: [/\/\s*\w+\[\s*(\w+)\s*,\s*\1\s*\]/]}},
    },
    {
      id: 'block-update',
      title: 'The rest of the block absorbs each error at once',
      detail:
        '`W1[:, i:] -= err @ U[i, i:]` after every column: the next column of the block is quantized from its updated value, which is the whole point of the method.',
      match: {python: {all: [/\w+\[\s*:\s*,\s*(\w+)\s*(?:\+\s*1\s*)?:\s*\]\s*-=/]}},
    },
    {
      id: 'lazy-batch',
      title: 'Blocks of columns with one lazy update per block',
      detail:
        'The outer loop runs `range(0, cols, blocksize)`, and after each block `W[:, i2:] -= Err1 @ U[i1:i2, i2:]` updates every later column in one matmul. Updating them all after every column gives the same result with a memory-bound rank-1 update per column.',
      match: {
        python: {
          all: [
            /range\(\s*0\s*,\s*\w+\s*,\s*blocksize\s*\)/,
            /\[\s*:\s*,\s*\w+\s*:\s*\]\s*-=\s*\w+\s*@\s*\w+\[\s*\w+\s*:\s*\w+\s*,\s*\w+\s*:\s*\]/,
          ],
        },
      },
    },
    {
      id: 'by-hand',
      title: 'No quantization library',
      detail:
        'The solver is the exercise: `auto_gptq`, `gptqmodel`, `optimum` or `transformers`’ `GPTQConfig` would do it for you.',
      match: {python: {none: [/auto_gptq/, /gptqmodel/i, /optimum/, /GPTQConfig/]}},
    },
  ],
  code: {
    python: {
      starter: `"""GPTQ: quantize a weight matrix column by column, pushing each column's error onto the columns not yet quantized."""

import torch
import torch.nn as nn

from gptq_hessian import HessianCollector, prepare_hessian
from quant_int4 import dequantize, quant_params, quantize, quantize_rtn


def gptq_quantize(
    W: torch.Tensor, H: torch.Tensor, bits: int = 4, group_size: int = 128, blocksize: int = 128, percdamp: float = 0.01
):
    """W (out, in), H (in, in) -> codes (out, in) uint8, scales (out, in // g) fp16, zeros (out, in // g) uint8."""
    # TODO: prepare H (step 2); U = the upper Cholesky factor of H^-1. Then for each block of
    # \`blocksize\` columns: for each column, take a new group grid at a group's first column (from the
    # weights as already updated), quantize the column, divide its error by U's diagonal entry, and
    # subtract that error times U's row from the rest of the block. After the block, apply all of its
    # errors to every later column in one matmul.
    raise NotImplementedError("TODO: GPTQ, blockwise with lazy batch updates")


def output_error(W: torch.Tensor, W_hat: torch.Tensor, X: torch.Tensor) -> float:
    """||W X^T - W_hat X^T||^2 summed over every token and output."""
    return ((X.double() @ (W - W_hat).double().t()) ** 2).sum().item()


def gptq_reference(W: torch.Tensor, H: torch.Tensor, bits: int, group_size: int, percdamp: float = 0.01):
    """Slow and obvious: one column at a time, the explicit inverse Hessian of the columns left, in float64."""
    H, W = prepare_hessian(H, W, percdamp)
    W, Hinv = W.double(), torch.linalg.inv(H.double())
    W_hat = torch.zeros_like(W)
    for g0 in range(0, W.shape[1], group_size):
        scale, zero = quant_params(W[:, g0:g0 + group_size].float(), bits)
        scale, zero = scale.double(), zero.double()
        for c in range(g0, g0 + group_size):
            q = quantize(W[:, c:c + 1], scale, zero, bits)
            W_hat[:, c:c + 1] = scale * (q - zero)
            d = Hinv[c, c]
            err = (W[:, c:c + 1] - W_hat[:, c:c + 1]) / d
            W -= err @ Hinv[c:c + 1, :]  # the optimal update of every column not yet fixed (OBS)
            W[:, : c + 1] = W_hat[:, : c + 1]
            Hinv -= Hinv[:, c:c + 1] @ Hinv[c:c + 1, :] / d  # remove column c from the inverse
    return W_hat


if __name__ == "__main__":
    torch.manual_seed(0)
    d_in, d_out, n = 256, 64, 2048

    # Correlated inputs, as real activations are: 32 latent factors mixed into 256 features, uneven scales.
    Z = torch.randn(n, 32)
    X = Z @ torch.randn(32, d_in) + 2.0 * torch.randn(n, d_in)
    X *= torch.rand(d_in) * 2 + 0.25
    lin = nn.Linear(d_in, d_out, bias=False)
    collector = HessianCollector(lin)
    with torch.no_grad():
        for chunk in X.split(512):
            lin(chunk)
    collector.remove()
    W, H = lin.weight.detach().clone(), collector.H

    # GPTQ against round-to-nearest on the layer's own output.
    q, s, z = gptq_quantize(W, H, bits=4, group_size=128, blocksize=128)
    assert q.dtype == torch.uint8 and int(q.max()) <= 15 and s.shape == (d_out, 2)
    W_gptq = dequantize(q, s, z, 128)
    W_rtn = dequantize(*quantize_rtn(W, bits=4, group_size=128), 128)
    e_gptq, e_rtn = output_error(W, W_gptq, X), output_error(W, W_rtn, X)
    w_gptq, w_rtn = (W - W_gptq).pow(2).sum().item(), (W - W_rtn).pow(2).sum().item()
    print(f"||WX - W_hat X||^2  rtn {e_rtn:.1f}  gptq {e_gptq:.1f}  ({e_rtn / e_gptq:.2f}x lower)")
    print(f"||W - W_hat||^2     rtn {w_rtn:.3f}  gptq {w_gptq:.3f}")
    assert e_gptq < e_rtn / 3, "GPTQ should cut the output error at least 3x on correlated inputs"
    assert w_gptq > w_rtn, "it does so by moving weights further from their own values"

    # Lazy batching only reorders the updates: blocksize 32 and 128 give the same codes.
    q32, s32, z32 = gptq_quantize(W, H, bits=4, group_size=32, blocksize=32)
    q128, s128, z128 = gptq_quantize(W, H, bits=4, group_size=32, blocksize=128)
    agree = (q32 == q128).float().mean().item()
    assert agree > 0.999, agree

    # The slow column-by-column reference (explicit inverse, OBS updates, float64) lands on the same weights.
    W_ref = gptq_reference(W, H, bits=4, group_size=32)
    W_fast = dequantize(q32, s32, z32, 32)
    same = (W_ref.float() - W_fast).abs().lt(1e-4).float().mean().item()
    e_ref, e_fast = output_error(W, W_ref, X), output_error(W, W_fast, X)
    print(f"reference agreement {same:.4f}, output error {e_ref:.2f} vs {e_fast:.2f}")
    assert same > 0.99 and abs(e_ref - e_fast) / e_ref < 0.01
    print("PASS")
`,
      solution: `"""GPTQ: quantize a weight matrix column by column, pushing each column's error onto the columns not yet quantized."""

import torch
import torch.nn as nn

from gptq_hessian import HessianCollector, prepare_hessian
from quant_int4 import dequantize, quant_params, quantize, quantize_rtn


def gptq_quantize(
    W: torch.Tensor, H: torch.Tensor, bits: int = 4, group_size: int = 128, blocksize: int = 128, percdamp: float = 0.01
):
    """W (out, in), H (in, in) -> codes (out, in) uint8, scales (out, in // g) fp16, zeros (out, in // g) uint8."""
    rows, cols = W.shape
    assert cols % group_size == 0 and blocksize % group_size == 0
    H, W = prepare_hessian(H, W, percdamp)

    # Upper Cholesky factor of H^-1: row i holds what column i's error does to columns i.. once 0..i-1 are fixed.
    L = torch.linalg.cholesky(H)
    Hinv = torch.linalg.cholesky(torch.cholesky_inverse(L), upper=True)

    codes = torch.zeros(rows, cols, dtype=torch.uint8)
    scales = torch.zeros(rows, cols // group_size, dtype=torch.float16)
    zeros = torch.zeros(rows, cols // group_size, dtype=torch.uint8)

    for i1 in range(0, cols, blocksize):
        i2 = min(i1 + blocksize, cols)
        W1 = W[:, i1:i2].clone()
        Err1 = torch.zeros_like(W1)
        Hinv1 = Hinv[i1:i2, i1:i2]
        for i in range(i2 - i1):
            col = i1 + i
            if col % group_size == 0:
                # The group's grid comes from the weights as they are now, after earlier columns' updates.
                scale, zero = quant_params(W1[:, i:i + group_size], bits)
                scales[:, col // group_size] = scale[:, 0].half()
                zeros[:, col // group_size] = zero[:, 0].to(torch.uint8)
            w = W1[:, i:i + 1]
            q = quantize(w, scale, zero, bits)
            codes[:, col] = q[:, 0].to(torch.uint8)
            err = (w - scale * (q - zero)) / Hinv1[i, i]
            W1[:, i:] -= err @ Hinv1[i:i + 1, i:]  # the rest of this block absorbs the error now
            Err1[:, i] = err[:, 0]
        W[:, i2:] -= Err1 @ Hinv[i1:i2, i2:]  # lazy batch update: every later column at once

    return codes, scales, zeros


def output_error(W: torch.Tensor, W_hat: torch.Tensor, X: torch.Tensor) -> float:
    """||W X^T - W_hat X^T||^2 summed over every token and output."""
    return ((X.double() @ (W - W_hat).double().t()) ** 2).sum().item()


def gptq_reference(W: torch.Tensor, H: torch.Tensor, bits: int, group_size: int, percdamp: float = 0.01):
    """Slow and obvious: one column at a time, the explicit inverse Hessian of the columns left, in float64."""
    H, W = prepare_hessian(H, W, percdamp)
    W, Hinv = W.double(), torch.linalg.inv(H.double())
    W_hat = torch.zeros_like(W)
    for g0 in range(0, W.shape[1], group_size):
        scale, zero = quant_params(W[:, g0:g0 + group_size].float(), bits)
        scale, zero = scale.double(), zero.double()
        for c in range(g0, g0 + group_size):
            q = quantize(W[:, c:c + 1], scale, zero, bits)
            W_hat[:, c:c + 1] = scale * (q - zero)
            d = Hinv[c, c]
            err = (W[:, c:c + 1] - W_hat[:, c:c + 1]) / d
            W -= err @ Hinv[c:c + 1, :]  # the optimal update of every column not yet fixed (OBS)
            W[:, : c + 1] = W_hat[:, : c + 1]
            Hinv -= Hinv[:, c:c + 1] @ Hinv[c:c + 1, :] / d  # remove column c from the inverse
    return W_hat


if __name__ == "__main__":
    torch.manual_seed(0)
    d_in, d_out, n = 256, 64, 2048

    # Correlated inputs, as real activations are: 32 latent factors mixed into 256 features, uneven scales.
    Z = torch.randn(n, 32)
    X = Z @ torch.randn(32, d_in) + 2.0 * torch.randn(n, d_in)
    X *= torch.rand(d_in) * 2 + 0.25
    lin = nn.Linear(d_in, d_out, bias=False)
    collector = HessianCollector(lin)
    with torch.no_grad():
        for chunk in X.split(512):
            lin(chunk)
    collector.remove()
    W, H = lin.weight.detach().clone(), collector.H

    # GPTQ against round-to-nearest on the layer's own output.
    q, s, z = gptq_quantize(W, H, bits=4, group_size=128, blocksize=128)
    assert q.dtype == torch.uint8 and int(q.max()) <= 15 and s.shape == (d_out, 2)
    W_gptq = dequantize(q, s, z, 128)
    W_rtn = dequantize(*quantize_rtn(W, bits=4, group_size=128), 128)
    e_gptq, e_rtn = output_error(W, W_gptq, X), output_error(W, W_rtn, X)
    w_gptq, w_rtn = (W - W_gptq).pow(2).sum().item(), (W - W_rtn).pow(2).sum().item()
    print(f"||WX - W_hat X||^2  rtn {e_rtn:.1f}  gptq {e_gptq:.1f}  ({e_rtn / e_gptq:.2f}x lower)")
    print(f"||W - W_hat||^2     rtn {w_rtn:.3f}  gptq {w_gptq:.3f}")
    assert e_gptq < e_rtn / 3, "GPTQ should cut the output error at least 3x on correlated inputs"
    assert w_gptq > w_rtn, "it does so by moving weights further from their own values"

    # Lazy batching only reorders the updates: blocksize 32 and 128 give the same codes.
    q32, s32, z32 = gptq_quantize(W, H, bits=4, group_size=32, blocksize=32)
    q128, s128, z128 = gptq_quantize(W, H, bits=4, group_size=32, blocksize=128)
    agree = (q32 == q128).float().mean().item()
    assert agree > 0.999, agree

    # The slow column-by-column reference (explicit inverse, OBS updates, float64) lands on the same weights.
    W_ref = gptq_reference(W, H, bits=4, group_size=32)
    W_fast = dequantize(q32, s32, z32, 32)
    same = (W_ref.float() - W_fast).abs().lt(1e-4).float().mean().item()
    e_ref, e_fast = output_error(W, W_ref, X), output_error(W, W_fast, X)
    print(f"reference agreement {same:.4f}, output error {e_ref:.2f} vs {e_fast:.2f}")
    assert same > 0.99 and abs(e_ref - e_fast) / e_ref < 0.01
    print("PASS")
`,
    },
  },
  debrief: `This is Algorithm 1 of the GPTQ paper and \`fasterquant\` in the authors' \`gptq.py\`, with one difference in the group path (below). Three ideas make Optimal Brain Quantization fast enough for a 175B model. **Same order for every row**: OBQ quantized each row's weights greedily in its own order, which needs a separate inverse Hessian per row; GPTQ quantizes every row left to right, so one \`H⁻¹\` serves all rows and the cost drops from \`O(d_row · d_col³)\` to \`O(max(d_row · d_col², d_col³))\`. **Cholesky instead of downdates**: removing column \`c\` from the inverse (\`H⁻¹ −= H⁻¹[:, c] H⁻¹[c, :] / H⁻¹[c, c]\`, the reference in the self-test) accumulates float error over thousands of columns and, with large models, produced indefinite matrices. Row \`i\` of the upper Cholesky factor of \`H⁻¹\`, from the diagonal on, is the row those downdates would leave, divided by the square root of its diagonal entry: computed once and stably, with the division by \`U[i, i]\` in \`err\` restoring the scale. **Lazy batches**: the update of the columns after the block only needs the block's errors, so it waits and becomes one \`(rows × 128) @ (128 × rest)\` matmul, turning a memory-bound loop into compute-bound work. **Groups**: the paper takes each group's grid from "the most current updated weights", which is what reading \`W1\` does. The reference reads \`W[:, col:col + groupsize]\`, and inside a block \`W\` lacks the block's own earlier updates: the two agree when every group starts a block (\`group_size = blocksize = 128\`, the usual setting) and differ for smaller groups (on the self-test's layer with \`group_size = 32\` and \`blocksize = 128\`, one run gave an output error of 2,463 for the reference's choice against 2,381). What the reference adds: \`--act-order\` quantizes columns in order of decreasing \`diag(H)\` (the most sensitive first, while the most freedom remains, then permutes back), \`--static-groups\` fixes every group's grid before the loop so act-order still loads groups contiguously, and \`--sym\` for symmetric grids.`,
};
