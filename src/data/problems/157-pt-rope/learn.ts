/**
 * The learning guide for the RoPE drill: RoFormer's rotation of query/key pairs, the frequency ladder,
 * why the score depends only on relative position, gathering by explicit positions for the KV cache,
 * the half-split versus interleaved layouts and float32 angles, and the frequency rescaling (position
 * interpolation, NTK-aware, YaRN) that production adds for long context. Rendered at `/pt-rope/learn`.
 */
export const learn = `# The mechanism at a glance

Rotary position embeddings come from Su et al., [RoFormer](https://arxiv.org/abs/2104.09864) (2021), and
have been the default position scheme of open LLMs since GPT-NeoX and Llama: Mistral, Qwen, Gemma, DeepSeek
and Phi all use them. Instead of adding a position vector to the token embedding once, every attention layer
rotates its queries and keys (pairs of dimensions, each pair by an angle proportional to the token's
position) just before \`q @ k.T\`. Values are never rotated.

The drill implements three pieces in \`rope.py\`:

- \`precompute_rope_cache(head_dim, max_seq_len, base=10000.0) -> (cos, sin)\`, float32, each
  \`[max_seq_len, head_dim // 2]\`.
- \`apply_rope(x, cos, sin, positions=None)\` on \`x\` of shape \`[batch, heads, seq, head_dim]\`, half-split
  pairs \`(i, i + head_dim // 2)\`, \`positions\` defaulting to \`torch.arange(seq)\`.
- \`RoPE(nn.Module)\` holding \`cos\` and \`sin\` as \`register_buffer(..., persistent=False)\`, with
  \`forward(x, positions=None)\` calling \`apply_rope(x, self.cos, self.sin, positions)\`.

One call of \`apply_rope\` on a query or key, with the cos/sin rows opened up on the right:

:::architecture
{
  "input": "from the q or k projection",
  "output": "into q_rot · k_rotᵀ",
  "items": [
    {"id": "x", "label": "Query or key heads", "kind": "io", "sub": "x · [B, H, L, D]", "shape": "[B, H, L, D]", "detail": "Any float dtype; values are never passed through RoPE."},
    {"id": "halves", "label": "Split into halves", "sub": "x1, x2 = x.chunk(2, dim=-1)", "shape": "[B, H, L, D/2] each", "detail": "Half-split layout: dimension \`i\` pairs with \`i + D/2\`, so each half is one slice of the last dimension, with no reshape into pairs."},
    {"id": "rotate", "label": "Rotate every pair", "kind": "attention", "sub": "x1·c − x2·s,  x2·c + x1·s", "shape": "[B, H, L, D/2] each", "side": {"label": "cos, sin rows", "sub": "[1, 1, L, D/2]"}, "detail": "The 2×2 rotation \`[[c, −s], [s, c]]\` applied to all pairs at once; the length of each pair is unchanged."},
    {"id": "concat", "label": "Concatenate halves", "sub": "cat(dim=-1) · x’s shape and dtype", "shape": "[B, H, L, D]"}
  ],
  "notes": [
    {"at": "halves", "text": "Dimension i pairs with **i + D/2**", "side": "left"},
    {"at": "rotate", "text": "**4** multiplies and **2** adds per pair", "side": "left"}
  ],
  "insets": [
    {"for": "rotate", "title": "Where c and s come from", "items": [
      {"id": "inv-freq", "label": "Inverse frequencies", "sub": "θᵢ = base^(−2i/D) · [D/2]", "detail": "\`base ** (-torch.arange(0, D, 2) / D)\`: 1 for the first pair, just above \`1 / base\` for the last."},
      {"id": "angles", "label": "Angle table", "sub": "outer(arange(max_len), θ)"},
      {"id": "cache", "label": "cos / sin buffers", "kind": "embed", "sub": "[max_len, D/2] float32", "detail": "Registered with \`persistent=False\`: they follow \`.to(device)\` but stay out of \`state_dict\`."},
      {"id": "gather", "label": "Gather rows by position", "sub": "cos[positions].to(x.dtype)", "detail": "Explicit positions, so a decode step passes \`arange(offset, offset + L)\` and rotates its token at its true offset against the KV cache."}
    ], "note": "Built **once**, gathered by **positions**"}
  ]
}
:::

# Rotating pairs at a ladder of frequencies

A head of \`head_dim = d\` is read as \`d / 2\` two-dimensional points. Point \`i\` of the token at position
\`m\` is rotated by the angle \`m · theta_i\`:

\`\`\`text
theta_i  = base^(−2i / d)                    i = 0 .. d/2 − 1      inv_freq, [d/2]
angle    = m · theta_i                       outer(arange(max_seq_len), inv_freq)
(x1, x2) = (x[..., :d/2], x[..., d/2:])      half-split: dim i pairs with i + d/2
out      = (x1 · cos − x2 · sin,  x2 · cos + x1 · sin)
\`\`\`

The last line is the 2×2 rotation matrix \`[[cos, −sin], [sin, cos]]\` applied to every pair at once: turning
the point \`(a, b)\` by angle \`α\` gives \`(a cos α − b sin α, b cos α + a sin α)\`. With complex numbers,
\`e^{jα} = cos α + j sin α\` and multiplying by it turns a point by \`α\`, so pair \`i\` is \`z_i = x1_i + j·x2_i\`
and the rotation is \`z_i · e^{j m theta_i}\`. That is the independent reference the self-test uses
(\`torch.polar\` and \`torch.complex\` in float64).

A worked example with \`d = 4\`, \`base = 10000\` and one token at position \`m = 2\`:

\`\`\`text
theta    = 10000^(−0/4), 10000^(−2/4)          = [1, 0.01]
angle    = 2 · theta                           = [2, 0.02]
cos, sin                                       = [−0.4161, 0.9998], [0.9093, 0.0200]
x        = [1, 2, 0, 1]   →  x1 = [1, 2], x2 = [0, 1]   pairs (x0, x2) = (1, 0), (x1, x3) = (2, 1)
x1·c − x2·s = [1·(−0.4161) − 0·0.9093, 2·0.9998 − 1·0.0200] = [−0.4161, 1.9796]
x2·c + x1·s = [0·(−0.4161) + 1·0.9093, 1·0.9998 + 2·0.0200] = [ 0.9093, 1.0398]
out      = [−0.4161, 1.9796, 0.9093, 1.0398]
\`\`\`

Pair 0 turned by 2 radians (about 115°) and pair 1 by only 0.02; each pair keeps its length
(\`0.4161² + 0.9093² = 1\`, \`1.9796² + 1.0398² = 5 = 2² + 1²\`). Note which dimensions pair up: \`x[0]\` with
\`x[2]\`, not \`x[0]\` with \`x[1]\`.

The frequencies fall geometrically, so the pairs form a clock with \`d / 2\` hands. For \`d = 128\` and
\`base = 10000\`:

| pair i | theta_i (rad / token) | wavelength 2π / theta_i | what it resolves |
|---|---|---|---|
| 0 | 1 | ≈ 6.3 tokens | adjacent-token order; wraps constantly |
| 16 | 0.1 | ≈ 63 tokens | phrase-scale distance |
| 32 | 0.01 | ≈ 630 tokens | paragraph-scale distance |
| 63 | ≈ 1.2e-4 | ≈ 54,000 tokens | barely turns in a 4K context |

- Every position gets a distinct combination of angles, the way a number has distinct digits in a mixed radix.
- Rotation preserves length: \`|out| = |x|\` per pair, so RoPE changes direction, never magnitude; the
  self-test checks the norms.
- Position 0 has angle 0: \`cos = 1\`, \`sin = 0\`, the identity.
- \`head_dim\` must be even; the solution asserts it.

The cache is \`2 × max_seq_len × d/2\` floats. Computing it once costs nothing at runtime; a forward pass is
then one gather, four multiplies and two adds per pair, nothing transcendental.

:::quiz
Q: Which pairs of a 128-dimensional head carry information about tokens thousands of positions apart?
- [ ] The first pairs, because they turn fastest and so change most between distant tokens
- [x] The last pairs, whose wavelengths are tens of thousands of tokens, so the angle is still unambiguous at that distance
- [ ] All pairs equally, since every angle is proportional to the position
> Pair 0 turns one radian per token and wraps about 160 times over a thousand tokens, so its angle cannot
> tell 1000 from 1044 (44 radians is seven turns, to within 0.02). Only slow pairs, whose wavelength exceeds
> the distance, map distance to angle one-to-one, which is also why context extension mostly rescales them.
:::

# Why the score sees only the distance

Rotations compose, and a rotation's transpose is its inverse. For one pair, with \`R(a)\` the rotation by \`a\`:

\`\`\`text
(R(m θ) q) · (R(n θ) k) = qᵀ R(m θ)ᵀ R(n θ) k = qᵀ R((n − m) θ) k
complex form:  Re[ q e^{j m θ} · conj(k e^{j n θ}) ] = Re[ q · conj(k) · e^{j (m − n) θ} ]
\`\`\`

The score between a query at \`m\` and a key at \`n\` is a function of the content and of \`m − n\`; the
absolute positions cancel. That is the property the self-test checks numerically: rotate one \`q\` and one
\`k\` to all 64 positions, form \`scores[m, n]\`, and shifting both indices by 1, 7 or 40 must leave the matrix
unchanged to \`1e-4\`, while the scores still vary with the distance.

Move the position slider in the widget: every pair turns at its own frequency, and the plot shows the
rotated \`q · k\` depending only on the distance between the two positions.

:::widget rope-rotation

| scheme | where position enters | relative? | parameters | longer than trained |
|---|---|---|---|---|
| learned absolute (GPT-2) | added to the input once | no, learned at best | \`max_len × d_model\` | no row exists |
| sinusoidal absolute (Transformer) | added to the input once | only approximately, through the mix | none | degrades |
| relative bias (T5, ALiBi) | a bias added to each score | yes | per bucket / per head slope | bias extrapolates |
| RoPE | q and k rotated in every layer | exactly, in the dot product | none | angles unseen; rescale |

- Nothing is added to the residual stream, so position never competes with content for dimensions.
- It works with any attention kernel: the scores are an ordinary \`q_rot @ k_rotᵀ\`, so FlashAttention and
  \`scaled_dot_product_attention\` need no change.
- RoFormer also shows an upper bound on the score that decays with \`|m − n|\` for the default base: a mild
  built-in preference for nearby tokens.

:::quiz
Q: Why is RoPE applied to q and k but not to v?
- [ ] v is too large to rotate cheaply
- [x] Position only needs to reach the scores, and only q·k produces them; rotating v would mix positions into the content being averaged
- [ ] Rotating v would break the softmax normalisation
> The relative-position property is a property of the dot product of two rotated vectors. The values are
> weighted and summed by the scores; rotating them would stamp each value with its absolute angle and the
> output would no longer be position-free content.
:::

# Positions, offsets and the KV cache

During generation the model prefills a prompt of \`L\` tokens, caches their keys **already rotated** at
positions \`0..L−1\`, then decodes one token at a time. The new token's query and key must be rotated at
its true position \`L\`, \`L + 1\`, …, not at 0. That is why \`apply_rope\` gathers \`cos[positions]\` rather
than slicing \`cos[:seq]\`, and why its default (\`torch.arange(seq)\`) is only right for a full sequence.

Decoding the 45th token after a 44-token prompt, without and with its offset:

| | \`positions=None\` (the bug) | \`positions = torch.arange(44, 45)\` |
|---|---|---|
| cached keys | rotated at 0..43 | rotated at 0..43 |
| new q and k rotated at | 0, the identity | 44, by \`cos[44]\`, \`sin[44]\` |
| key appended at slot 44 | rotated at 0 | rotated at 44 |
| distance a score sees, query vs key n | \`0 − n = −n\` | \`44 − n\` |
| result | the newest token attends as if it came first: degraded text | the same scores as a full forward pass |

- The rotation is elementwise per position, so a token rotated alone at offset 44 is bit-for-bit its slot in
  a sequence rotated at \`37..44\`; the self-test asserts \`torch.equal\`, not \`allclose\`.
- Keys are cached post-rotation: they never need re-rotating, whatever comes later.
- Explicit positions also serve batched serving (each sequence at its own offset), packed sequences that
  restart at 0, and speculative decoding's draft tokens.
- Every implementation carries the offset somehow: Meta's reference slices
  \`freqs_cis[start_pos : start_pos + seqlen]\`, Hugging Face passes \`position_ids\`, vLLM passes \`positions\`,
  and FlashAttention's \`flash_attn_with_kvcache\` rotates the new keys at \`cache_seqlens\` as it appends them.
- Positions may repeat or come out of order; the gather does not care, and the float64 \`gradcheck\` in the
  self-test uses \`[3, 0, 11, 11, 60]\` to prove the backward is still a rotation.
- \`max_seq_len\` bounds the table: a position past it is an index error, not a silent wrap.

:::quiz
Q: A decode step forgets the offset and rotates the new token with the default positions. What goes wrong?
- [ ] Nothing: the relative-position property makes absolute positions irrelevant
- [x] The new query is rotated at 0, so its scores against cached keys at n encode the distance −n instead of L − n
- [ ] The shapes no longer match the KV cache and the step raises
> The property is relative only when both sides are rotated at their true positions. The cached keys were
> rotated at 0..L−1; a query rotated at 0 is consistent with them only for a token that really is at 0.
> The shapes are fine, which is why this bug ships and shows up as degraded text.
:::

# Layouts, dtypes and the buffer

Which dimensions form a pair is a convention, and a checkpoint is trained with one:

| layout | pair i is | used by | how it is written |
|---|---|---|---|
| half-split | \`(i, i + d/2)\` | GPT-NeoX, Hugging Face Llama/Mistral/Qwen | \`chunk(2)\`, \`cat\` (contiguous halves) |
| interleaved | \`(2i, 2i + 1)\` | the RoFormer paper, Meta's Llama reference, GPT-J | \`view(..., d/2, 2)\` or \`view_as_complex\` |

The two are the same rotation in a permuted basis. Applying the wrong one to a checkpoint's \`q\` and \`k\`
projections silently scrambles attention; Hugging Face's Llama conversion script permutes the \`Wq\` and
\`Wk\` rows so Meta's interleaved weights run under the half-split code.

Precision matters for the angles, not the rotation:

- bfloat16 keeps 8 significant bits, so integers above 256 are not all exact: near 3000 its spacing is 16.
  Computed in bf16, \`m · theta\` at position 3000 uses 3008, and pair 0's angle is off by 8 radians.
- Once the angles are right, \`cos\` and \`sin\` are bounded: rounding the float32 table to bf16 costs at most
  0.002, the same rounding the bf16 rotation adds anyway.
- So the drill computes the cache in float32 and casts only the gathered rows with \`.to(x.dtype)\`; a bf16 \`x\`
  comes back bf16.
- \`register_buffer\` makes \`cos\` and \`sin\` follow \`model.to(device)\`, and \`model.to(torch.bfloat16)\` casts
  them too (harmless, by the point above). \`persistent=False\` keeps them out of \`state_dict\`: they are a
  function of \`(head_dim, max_seq_len, base)\`, and at 128K context and \`head_dim = 128\` they would add
  64 MiB of cos and sin to every checkpoint. See the PyTorch docs for
  [Module.register_buffer](https://docs.pytorch.org/docs/stable/generated/torch.nn.Module.html#torch.nn.Module.register_buffer).

:::details What Hugging Face does differently
Llama's \`LlamaRotaryEmbedding\` stores only \`inv_freq\` (and an \`original_inv_freq\` copy) as non-persistent
buffers and computes \`cos\` and \`sin\` on each forward from \`position_ids\`, in float32, then casts them to
\`x\`'s dtype. There is no table bounded by \`max_seq_len\`, and the dynamic scaling variants can swap
\`inv_freq\` at runtime. The cost is the trap above: \`inv_freq\` is itself a floating-point buffer, so a plain
\`model.to(torch.bfloat16)\` rounds the frequencies (up to \`2^-8\` relative error), which at position 3000
already moves pair 1's angle by 3.7 radians.
:::

:::quiz
Q: In a bfloat16 model, which part of RoPE has to be computed in float32?
- [ ] The rotation \`x1·c − x2·s\`, because bf16 products change the pair's length
- [x] The angles \`m · theta\` (and \`theta\` itself), because they grow with \`m\` and bf16 rounds large values coarsely
- [ ] The \`cos\` and \`sin\` values, because bf16 cannot hold numbers between −1 and 1 accurately
> At position 3000, bf16 rounds \`m · theta\` in pair 0 to a multiple of 16, an error of 8 radians. Once the
> angles are right, \`cos\` and \`sin\` are bounded and rounding them to bf16 costs at most 0.002, the same as
> the bf16 rotation itself, so the drill casts the gathered rows to \`x.dtype\`.
:::

# Long context: rescaling the frequencies

A model trained at 4K or 8K tokens has never seen the slow pairs' angles beyond that range; feed it 32K
positions and those pairs produce rotations it has no meaning for. Every context-extension method keeps
\`apply_rope\` unchanged and rescales \`inv_freq\` (or the positions), usually followed by a short fine-tune:

| method | change | effect |
|---|---|---|
| position interpolation (Chen et al., 2023) | \`m → m · L_train / L_new\` | every pair slowed; nearby tokens crowd together |
| larger base (Llama 3 5e5, Code Llama 1e6) | \`base\` raised in pre-training (Llama 3) or long-context fine-tuning (Code Llama) | every pair but the first slowed, the slowest the most |
| NTK-aware scaling | \`base → base · s^(d / (d − 2))\` | fast pairs almost untouched, slow pairs interpolated |
| [YaRN](https://arxiv.org/abs/2309.00071) (Peng et al., 2023) | per-pair ramp by wavelength, plus a logit temperature | short wavelengths kept, long ones interpolated |
| Llama 3.1 scaling | factor 8 on wavelengths above 8192, none below 2048, smooth between | 8K → 128K |

\`\`\`text
YaRN, per pair i with wavelength λ_i = 2π / theta_i and trained length L:
  λ_i < L / β       → keep theta_i                (high frequency: local order)
  λ_i > L / α       → theta_i / s                 (low frequency: interpolate)
  between           → linear blend of the two
  attention logits  × (0.1 · ln s + 1)²            (sharpen the softmax back)
\`\`\`

- The fast pairs encode local order and wrap many times even in short contexts, so they already extrapolate;
  slowing them would blur adjacent tokens.
- The slow pairs are the ones pushed past their trained range, so they are the ones interpolated.
- Serving stacks also fuse the rotation: vLLM rotates q and k in place with one kernel, TensorRT-LLM and
  FlashAttention apply it in the kernel that writes the KV cache, and \`torch.compile\` fuses the gather and the
  elementwise ops into one kernel.

:::quiz
Q: Why does NTK-aware scaling beat plain position interpolation without fine-tuning?
- [ ] It changes the attention kernel to handle longer sequences
- [ ] It slows every pair by the same factor, which keeps the frequency ratios intact
- [x] Raising the base stretches the slow pairs a lot and the fast pairs hardly at all, so local order stays sharp
> Position interpolation divides every angle by s, so adjacent tokens differ by 1/s of the trained angle in
> the fast pairs and the model loses fine-grained order. Changing the base spreads the scaling across the
> ladder: little at the fast end, close to s at the slow end.
:::

# What to take away

- RoPE rotates each \`(i, i + d/2)\` pair of q and k by \`m · base^(−2i/d)\`; values are left alone.
- The dot product of rotated vectors depends only on \`m − n\`: relative position, no parameters, any attention kernel.
- Gather the cache by explicit \`positions\`; a decode step passes its offset, or the KV cache scores are wrong.
- Compute angles in float32 once, keep them as a non-persistent buffer, cast the gathered rows to \`x.dtype\`.
- Long context is a rescaling of \`inv_freq\` (position interpolation, NTK-aware, YaRN), not a new mechanism.

Primary reference: Su et al., [RoFormer: Enhanced Transformer with Rotary Position Embedding](https://arxiv.org/abs/2104.09864); a worked explanation is EleutherAI's [Rotary Embeddings: A Relative Revolution](https://blog.eleuther.ai/rotary-embeddings/).
`;
