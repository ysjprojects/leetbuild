/**
 * Catalog of the interactive infographics a step's task may embed with `:::widget name {json}`.
 * Names must match `WIDGET_COMPONENTS` in components/LeetBuild/widgets/index.tsx; the verify
 * script checks both directions.
 */
export interface WidgetSpec {
  /** One-line description shown in authoring checks. */
  about: string;
  /** Parameter names with their meaning and default. */
  params: Record<string, string>;
}

export const WIDGETS: Record<string, WidgetSpec> = {
  'http-lifecycle': {
    about:
      'Playback of one HTTPS request: TCP handshake, TLS handshake (ClientHello, certificate, key exchange), the request line and headers, routing, the handler, the response, and keep-alive reuse.',
    params: {tls: 'show the TLS handshake steps (default true)'},
  },
  'status-codes': {
    about:
      'Which HTTP status to return when: a hoverable map of the codes a service actually uses (200/201/202/204, 400/401/403/404/409/422/429, 500/502/503/504).',
    params: {},
  },
  idempotency: {
    about:
      'Interactive: send the same request twice with the same Idempotency-Key, then with a new key, and watch the key store and the responses (201 created, replayed 201, 409 in-flight).',
    params: {},
  },
  'grpc-streams': {
    about:
      'The four gRPC call types (unary, server streaming, client streaming, bidirectional) as animated message flows over one HTTP/2 stream.',
    params: {mode: "'unary' | 'server' | 'client' | 'bidi' (default 'unary')"},
  },
  'deadline-retry': {
    about:
      'Timeline of retries with exponential backoff and jitter under a caller deadline: sliders for base delay and deadline; shows which attempts fit and which status codes are worth retrying.',
    params: {
      base: 'base delay in ms (default 100)',
      deadline: 'caller deadline in ms (default 2000)',
      attempts: 'max attempts (default 5)',
    },
  },
  'kafka-partitions': {
    about:
      'Interactive: type a message key, see it hashed to a partition and appended at the next offset; explains why per-key ordering holds and cross-partition ordering does not.',
    params: {partitions: 'number of partitions (default 4)'},
  },
  'consumer-groups': {
    about:
      'Slider for the number of consumers in a group against a fixed partition count: partition assignment, idle consumers past the partition count, and committed offsets per partition.',
    params: {partitions: 'number of partitions (default 4)'},
  },
  'delivery-semantics': {
    about:
      'At-most-once, at-least-once and effectively-once side by side: where the commit happens relative to processing, and what a crash between the two does.',
    params: {},
  },
  'cache-aside': {
    about:
      'Playback of the cache-aside pattern: miss → origin → SET with TTL → hits until expiry; a toggle shows a stampede (many concurrent misses) and how a lock or single-flight collapses it.',
    params: {stampede: 'start in the stampede scenario (default false)'},
  },
  'token-bucket': {
    about:
      'Animated token bucket: tokens refill at `rate` per second up to `burst`; click to send requests and watch 200 vs 429.',
    params: {rate: 'tokens per second (default 5)', burst: 'bucket capacity (default 10)'},
  },
  outbox: {
    about:
      'Dual write vs transactional outbox: the database transaction writes the order and the outbox row together; a relay publishes to Kafka and marks rows sent; toggle a crash between the two writes to see the difference.',
    params: {},
  },
  'order-book': {
    about:
      'Interactive limit order book with price-time priority: add bids and asks, watch resting orders queue by price then time, and see fills when the book crosses.',
    params: {},
  },
  'percent-rollout': {
    about:
      'Interactive: a grid of users coloured by variant; sliders for the shares, a seed, and a hash-vs-coin-toss toggle show that a stateless hash keeps every assignment when a share grows while a coin toss reshuffles everyone on every evaluation.',
    params: {users: 'number of users in the grid (default 200)'},
  },
  // ---- deep learning ----
  'softmax-stability': {
    about:
      'Interactive: logits as sliders (or a preset with values near 1e4): the naive softmax overflows to inf and NaN while the max-subtracted one stays finite; temperature and label-smoothing sliders show the target distribution and the cross-entropy it produces.',
    params: {preset: "'small' or 'huge' logits to start from (default 'small')"},
  },
  sampling: {
    about:
      'Interactive: a next-token distribution over a toy vocabulary; temperature, top-k and top-p sliders show which tokens survive and their renormalised probabilities; sampling repeatedly fills in the empirical frequencies.',
    params: {},
  },
  'attention-heatmap': {
    about:
      'Interactive: the attention weights of a short sentence as a T×T heatmap; toggle the causal mask and the 1/√d scaling, switch heads, and hover a query row to read where it attends.',
    params: {causal: 'start with the causal mask on (default true)'},
  },
  'online-softmax': {
    about:
      'Step-through: a row of attention scores processed tile by tile with a running max m, a running sum l and the rescale exp(m_old − m_new) of what is already accumulated; the final result equals the full softmax.',
    params: {tile: 'tile width in scores (default 4)'},
  },
  'kv-cache': {
    about:
      'Step-through: autoregressive decoding with and without a KV cache; the cache gains one key and one value row per token while the uncached path recomputes every row, with running counts of work and memory.',
    params: {},
  },
  'paged-kv': {
    about:
      'Step-through: three requests sharing an 8-token system prompt grow token by token; their logical KV blocks map through block tables to physical blocks of a 96-slot pool (FIFO free list, finished sequences return their blocks). Bars compare the paged waste (the tail of each last block) with contiguous preallocation of max_len 32 per sequence; block-size tabs (2, 4, 8) and a shared-prefix toggle that maps the prefix blocks of every sequence to the same physical blocks with ref counts.',
    params: {
      blockSize: 'slots per block, 2, 4 or 8 (default 4)',
      shared: 'start with the shared-prefix toggle on (default false)',
    },
  },
  'rope-rotation': {
    about:
      'Interactive: rotary position embeddings as 2-D vectors per pair of dimensions, each turning at its own frequency base^(−2i/d) as a position slider moves; a plot shows the rotated q·k depends only on the distance between positions.',
    params: {},
  },
  'model-size': {
    about:
      'Interactive calculator: layers, width, heads, vocabulary and context give the parameters by component (embeddings, attention, MLP, norms), weight memory per precision and KV-cache memory per sequence.',
    params: {preset: "'gpt2', 'gpt2-medium', 'gpt2-xl' or 'llama-3-8b' (default 'gpt2')"},
  },
  'optimizer-paths': {
    about:
      'Interactive: SGD, momentum, Nesterov, Adam and AdamW descending an ill-conditioned 2-D loss surface; separate SGD and Adam learning-rate sliders, β and weight-decay sliders, and playback of the steps.',
    params: {},
  },
  'lr-schedule': {
    about:
      'Interactive: the learning rate over training, linear warmup then cosine decay to a floor; sliders for warmup, total steps, peak and floor, and a step marker that reads the rate anywhere.',
    params: {warmup: 'warmup steps (default 100)', total: 'total steps (default 1000)'},
  },
  'grad-clip': {
    about:
      'Interactive: per-parameter gradients as vectors; clipping by the global norm scales all of them by one factor and keeps the direction, clipping each tensor or each value bends it; a max-norm slider.',
    params: {},
  },
  'norm-compare': {
    about:
      'Interactive: one vector of activations through LayerNorm and RMSNorm side by side; an offset and a scale slider show that RMSNorm does not remove the mean, with the statistics read out.',
    params: {},
  },
  'variance-cancellation': {
    about:
      'Interactive: the variance of values around a large offset computed in float32 two ways; E[x²] − E[x]² loses all its digits by an offset of a few thousand while Welford’s update keeps them until float32 can no longer store the deviations (offset near 2²⁴).',
    params: {},
  },
  'float-formats': {
    about:
      'Interactive: fp32, fp16, bf16 and fp8 bit layouts; a value slider across many orders of magnitude shows the stored value, its rounding and where it under- or overflows; a loss-scale slider moves a gradient histogram into fp16’s range.',
    params: {},
  },
  'bpe-merges': {
    about:
      'Step-through: byte-pair encoding on a small corpus, one merge at a time; the most frequent adjacent pair, the new token, the corpus re-tokenised and the vocabulary growing.',
    params: {},
  },
  'diffusion-noise': {
    about:
      'Interactive: the forward diffusion process on a 2-D point cloud; a timestep slider noises the points, and the linear and cosine schedules’ ᾱ_t and signal-to-noise ratio are plotted side by side.',
    params: {schedule: "'linear' or 'cosine' (default 'linear')"},
  },
  'lora-rank': {
    about:
      'Interactive: LoRA’s update ΔW = B·A drawn to the layer’s shape; rank and layer-size sliders show the trainable parameters against the frozen weight, and why B starts at zero.',
    params: {},
  },
  'moe-routing': {
    about:
      'Interactive: tokens routed to experts by a top-k gate; router probabilities, the chosen experts, a capacity-factor slider that drops the overflow, and the load-balancing loss as the routing skews.',
    params: {
      experts: 'number of experts, 2–8 (default 4)',
      k: 'experts per token, 1–4 and at most `experts` (default 2)',
    },
  },
  'dpo-loss': {
    about:
      'Interactive: the DPO loss −log σ(β·h) and IPO’s squared loss (h − 1/(2β))² against the policy’s log-ratio margin h, beside the gradient weight σ(−β·h) each pair receives; sliders for β, h and the label smoothing ε of conservative DPO, which turns the weight negative past h = ln((1 − ε)/ε)/β.',
    params: {
      beta: 'starting β, snapped to 0.01–1 (default 0.1)',
      h: 'starting margin h, −30 to 30 (default 5)',
      smoothing: 'starting label smoothing ε, 0–0.4 (default 0)',
    },
  },
  'sequence-packing': {
    about:
      'Interactive: documents of varied length laid into rows of seq_len tokens, padded (one per row) against packed by first-fit decreasing, with the pad tokens and their share of the slots for both; the block-diagonal causal mask of a chosen row, with the causal pairs it blocks across segment boundaries; sliders for seq_len (32–64) and the row, and a resample button.',
    params: {
      docs: 'number of documents, 4–14 (default 10)',
      seqLen: 'starting row length, 32–64 in steps of 8 (default 32)',
    },
  },
  'int4-quant': {
    about:
      'Interactive: one group of weights on its quantization grid; the min and max set the scale and zero point, the 2^bits levels are drawn and each weight’s rounding error marked; sliders for bits (2–8) and group size (8–128), a toggle between round-to-nearest and GPTQ’s sequential error feedback on a small correlated example, with the weight error and the output error ‖(w − ŵ)X‖² of both, and a resample button.',
    params: {
      bits: 'starting bits per weight, 2–8 (default 4)',
      group: 'starting group size: 8, 16, 32, 64 or 128 (default 32)',
    },
  },
  'nvfp4-block': {
    about:
      'Interactive: 32 seeded Gaussian values quantized two ways on one shared value axis. NVFP4 above: two blocks of 16, each with its E4M3 scale e4m3(amax_block / 6 / s_global) under the FP32 s_global = amax / (6 · 448), its own scaled E2M1 grid ±{0, 0.5, 1, 1.5, 2, 3, 4, 6} · scale, each value’s round-to-nearest-even point and error. MXFP4 below: one block of 32 with the OCP E8M0 scale X = 2^floor(log2 amax) / 4, its grid, points and errors. Readout: s_global, both E4M3 scales, X, and the MSE of each format with their ratio. Toggle between plain Gaussian values and one 7.5 outlier in NVFP4 block 0, and a resample button.',
    params: {
      outlier: 'start with the outlier in block 0 (default false)',
      seed: 'starting seed, an integer ≥ 1 (default 4)',
    },
  },
  'stochastic-rounding': {
    about:
      'Interactive, two tabs. Rounding: 2,048 seeded gradient-like values (Gaussian times a log-normal spread) in canonical NVFP4 1 × 16 blocks (E4M3 block scales under the FP32 s_global = amax / (6 · 448)); per 0.25-wide bin of |x| / scale, the mean error of round-to-nearest-even and of the mean of K stochastic draws, over the RNE sawtooth and a count of values per bin; beside it the histogram of one draw’s error divided by the local grid gap for both. Readout: the share of values below half the smallest code, the share RNE stores as 0, the relative bias each rounding puts on those small values, and the RMS error of one draw of each. Sliders for the tail spread σ (0–2) and K (1, 4, 16, 64, 256). Hadamard: one 16-value block with an outlier at a chosen multiple of the other values’ rms, as stored and after x·H with the 16 × 16 Sylvester Hadamard and random signs, each with its NVFP4 values, its E2M1 levels, the values flushed to 0, the crest factor (max / rms) and the relative error. A resample button in both.',
    params: {
      mode: '"rounding" or "hadamard" (default "rounding")',
      tail: 'starting log-normal spread σ of the gradient values, 0–2 (default 1)',
      outlier: 'starting outlier in multiples of the rms, 1–30 (default 12)',
      seed: 'starting seed, an integer ≥ 1 (default 1)',
    },
  },
  'speculative-decoding': {
    about:
      'Interactive: sliders for the acceptance rate α (0–0.99), the draft length γ (1–10) and the draft cost ratio c (0–1) give the expected tokens per target call (1 − α^(γ+1))/(1 − α), the cost of a call γc + 1 and the speedup, with a bar per γ marking the best; a step-through of a seeded run under the i.i.d. model (draft i accepted iff u_i < α) shows each round’s accepts, the first rejection, the residual resample or the bonus token on a 40-token strip, with measured tokens per call against the formula, and a resample button.',
    params: {
      alpha: 'starting acceptance rate, 0–0.99 (default 0.8)',
      gamma: 'starting draft length, 1–10 (default 4)',
      cost: 'starting draft cost per forward relative to the target, 0–1 (default 0.1)',
    },
  },
  'grpo-advantages': {
    about:
      'Interactive: a group of G seeded completions of "3 + 1 =" from a simulated policy of skill p (right first token with probability p, one digit then EOS with probability p), with their rewards (1 for the right first token, + 0.5 for one digit then EOS) and two advantage bars each, (r − mean)/(std + 1e-4) with the unbiased group std and r − mean (Dr. GRPO), zero for a group whose rewards are all equal; beside it the clipped objective min(ρA, clip(ρ, 1 − ε, 1 + ε)A) against the ratio ρ for the group’s best and worst advantage, the trust region shaded and the zero-gradient parts dashed. Sliders for p and ε, and a resample button.',
    params: {
      G: 'completions per group, 2–12 (default 8)',
      p: 'starting skill: probability of a right answer and of a well-formed one, 0–1 (default 0.3)',
      clip: 'starting clip ε, 0.05–0.4 (default 0.2)',
    },
  },
  'gqa-heads': {
    about:
      'Interactive: the query heads drawn above the key/value heads they read, coloured by group, with MHA / GQA / MQA toggles and a slider over the divisors of `heads` for n_kv_heads; bars give the KV-cache bytes per token (2 · layers · n_kv_heads · headDim · 2 B in bf16) for MHA, the chosen grouping and MQA, and a context slider (512 to 131,072 tokens) gives the bytes per sequence. Llama 3 8B: 128 KiB per token, 1 GiB at 8,192 tokens.',
    params: {
      heads: 'query heads, 1–64 (default 32)',
      kvHeads: 'starting key/value heads, snapped down to a divisor of `heads` (default 8)',
      layers: 'layers, 1–200 (default 32)',
      headDim: 'dimensions per head, 1–1024 (default 128)',
      context: 'starting context length in tokens, rounded up to a power of two in 512–131,072 (default 8192)',
    },
  },
  'zero-memory': {
    about:
      'Interactive: per-GPU memory of mixed-precision Adam as the ZeRO paper counts it (2Ψ fp16 parameters + 2Ψ fp16 gradients + 12Ψ fp32 optimizer states, before activations) under DDP, ZeRO-1 (P_os), ZeRO-2 (P_os+g) and ZeRO-3 (P_os+g+p), one stacked bar per stage against an 80 GB device line; sliders for Ψ (1.5B to 405B) and the GPU count N (1 to 1,024), stage toggles, and the traffic per GPU per step relative to DDP (2Ψ for DDP, ZeRO-1 and ZeRO-2; 3Ψ for ZeRO-3, times (N − 1)/N on a ring).',
    params: {
      psi: 'model size in billions of parameters, snapped to 1.5, 7, 7.5, 13, 70, 175 or 405 (default 7.5)',
      gpus: 'data-parallel GPUs, snapped to a power of two from 1 to 1,024 (default 64)',
      stage: "'ddp', 'zero1', 'zero2' or 'zero3' (default 'zero3')",
    },
  },
  'tensor-parallel': {
    about:
      'Interactive: one Megatron sublayer (the MLP, or attention) at GPT-3 175B width (d = 12,288, 96 heads, bf16) split over 1 to 8 ranks; how A and B split into rank stripes by columns or by rows (W_qkv by head within q, k and v), where f and g sit, and a column → row / row → column toggle with the collectives each order needs forward and backward and the bytes one rank sends per token on a ring; non-divisible rank counts are flagged.',
    params: {
      layer: "'mlp' or 'attention' (default 'mlp')",
      ranks: 'tensor-parallel ranks p, 1–8 (default 2)',
    },
  },
  'cuda-grid': {
    about:
      'Interactive: a grid of thread blocks over an array; which thread handles which element, the grid-stride loop’s passes and the bounds check at the tail, with sliders for n, block size and grid size.',
    params: {n: 'elements, 1–96 (default 50)', block: 'threads per block, 1–32 (default 8)'},
  },
  coalescing: {
    about:
      'Interactive: one warp’s 32 addresses against 32-byte memory sectors; contiguous, strided, misaligned and float4 access patterns, the sectors each touches and the resulting efficiency.',
    params: {},
  },
  roofline: {
    about:
      'Interactive: the roofline, attainable FLOP/s against arithmetic intensity for a chosen GPU; vector add, GELU, softmax, naive and tiled matmul and tensor-core GEMM placed on it.',
    params: {},
  },
  'warp-reduce': {
    about:
      'Step-through: a warp’s 32 lanes summed with __shfl_down_sync at offsets 16, 8, 4, 2, 1, beside the shared-memory tree with its idle threads; the values move as you step.',
    params: {},
  },
  'bank-conflicts': {
    about:
      'Interactive: shared memory’s 32 banks and one warp’s access; a stride slider shows the conflict degree, and a padding toggle removes the conflicts.',
    params: {},
  },
  'scan-sweep': {
    about:
      'Step-through: Blelloch’s work-efficient exclusive scan on 16 values; the up-sweep builds partial sums in a tree, the root is cleared, the down-sweep hands them back down level by level.',
    params: {},
  },
  'tiled-matmul': {
    about:
      'Step-through: C = A·B with shared-memory tiles; pick an output tile and step through the K slabs, with the A and B tiles loaded per slab, their reuse and the global loads, naive against tiled.',
    params: {},
  },
  'stream-timeline': {
    about:
      'Interactive: a timeline of host-to-device copies, kernels and device-to-host copies per chunk, one stream against several; sliders for the chunk count, the copy-to-compute ratio and one or two copy engines, with the speedup read out.',
    params: {},
  },
};

export const WIDGET_NAMES = Object.keys(WIDGETS);
