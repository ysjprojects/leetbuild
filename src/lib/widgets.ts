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
