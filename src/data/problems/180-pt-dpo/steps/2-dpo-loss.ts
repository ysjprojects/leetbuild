import type {Step} from '@/lib/types';

export const dpoLossStep: Step = {
  id: 'dpo-loss',
  title: 'The DPO loss, cDPO and IPO, implicit rewards',
  concept: 'pytorch',
  file: 'dpo_loss',
  focus: ['margin', 'loss'],
  task: `## Task

Four log-probabilities per pair, from step 1 (\`from dpo_logprobs import TinyLM, concatenated_forward\`
is used by the self-test only), become the loss. Write
\`dpo_loss(policy_chosen_logps, policy_rejected_logps, reference_chosen_logps, reference_rejected_logps,
beta=0.1, label_smoothing=0.0, loss_type="sigmoid") -> dict\`:

- All four inputs are \`(B,)\` summed log-probabilities. The policy's carry a gradient; the reference's
  do not.
- The margin \`h = (policy_chosen - policy_rejected) - (reference_chosen - reference_rejected)\`: how much
  more the policy prefers the chosen response than the reference did.
- \`loss_type == "sigmoid"\` (DPO): \`-F.logsigmoid(beta * h)\`. With \`label_smoothing = ε\` (conservative
  DPO, preferences assumed flipped with probability ε):
  \`-(1 - ε) · logsigmoid(β·h) - ε · logsigmoid(-β·h)\`. Use \`F.logsigmoid\`, never
  \`torch.log(torch.sigmoid(…))\`, which returns \`-inf\` once \`β·h\` drops below about \`-88.7\` in float32.
- \`loss_type == "ipo"\`: \`(h - 1 / (2 * beta)) ** 2\`, a squared distance to a fixed target margin.
- Any other \`loss_type\`: \`raise ValueError\`.
- Return \`{"losses": (B,), "chosen_rewards": (B,), "rejected_rewards": (B,), "reward_accuracy": scalar,
  "reward_margin": scalar}\`. Only \`"losses"\` carries a gradient.
- The implicit rewards are \`beta * (policy_logps - reference_logps).detach()\`, per side.
- The accuracy is the mean of \`chosen_rewards > rejected_rewards\` as float; the margin is the mean of
  \`chosen_rewards - rejected_rewards\`.

The self-test checks \`ln 2\` at \`h = 0\`, the sigmoid, smoothed and IPO losses against closed forms on
64 random pairs in float64 (\`1e-9\`), finiteness at \`h = ±5000\`, the gradient
\`d loss / d policy_chosen = -β·σ(-β·h)\` (and \`+β·σ(-β·h)\` for rejected) to \`1e-12\`, IPO's linear
gradient \`2(h - 1/(2β))\`, that the rewards are detached, and that a real backward reaches the
policy's parameters and none of the reference's. It prints \`PASS\`.

:::widget dpo-loss {"beta": 0.1, "h": 5}

> DPO is logistic regression on the margin \`h\`: each pair is pushed with weight \`σ(-β·h)\`, hard while
> the policy still prefers the wrong answer and less and less once it prefers the right one.`,
  hints: [
    'Compute the two log-ratios first, `pi_logratios = policy_chosen_logps - policy_rejected_logps` and `ref_logratios = reference_chosen_logps - reference_rejected_logps`; `h` is their difference.',
    'Label smoothing is a mixture of the loss for the pair as labelled and the loss for the pair flipped: `-F.logsigmoid(beta * h) * (1 - label_smoothing) - F.logsigmoid(-beta * h) * label_smoothing`.',
    'Detach inside the reward expressions, `beta * (policy_chosen_logps - reference_chosen_logps).detach()`, so logging a reward can never put it in the graph; the accuracy is `(chosen_rewards > rejected_rewards).float().mean()`.',
  ],
  checks: [
    {
      id: 'margin',
      title: 'The margin h from four log-probabilities',
      detail:
        '`h = (policy_chosen_logps - policy_rejected_logps) - (reference_chosen_logps - reference_rejected_logps)`, or the same terms grouped per side. The reference turns a raw preference into a change in preference.',
      match: {
        python: {
          all: [
            /policy_chosen_logps\s*-\s*(?:policy_rejected_logps|reference_chosen_logps)/,
            /reference_chosen_logps\s*-\s*reference_rejected_logps|policy_rejected_logps\s*-\s*reference_rejected_logps/,
          ],
        },
      },
    },
    {
      id: 'logsigmoid',
      title: '−log σ(β·h) through logsigmoid',
      detail:
        '`F.logsigmoid(beta * h)`: stable for any margin. `torch.log(torch.sigmoid(x))` underflows to `log(0) = -inf` for very negative `x`, and `trl` is not used.',
      match: {
        python: {
          all: [/logsigmoid\(\s*beta\s*\*/],
          none: [/torch\.log\(\s*(?:torch\.|F\.)?sigmoid/, /sigmoid\([^\n]*\)\.log\(\)/, /from trl\b|import trl\b/],
        },
      },
    },
    {
      id: 'label-smoothing',
      title: 'Conservative DPO: label smoothing on the flipped pair',
      detail:
        '`(1 - label_smoothing)` on `logsigmoid(beta * h)` and `label_smoothing` on `logsigmoid(-beta * h)`: with noisy labels the loss has a finite minimum at `β·h = ln((1 − ε)/ε)` instead of pushing `h` forever.',
      match: {python: {all: [/1\s*-\s*label_smoothing/, /logsigmoid\(\s*-\s*beta\s*\*/]}},
    },
    {
      id: 'ipo',
      title: 'IPO: squared distance to 1/(2β)',
      detail:
        '`loss_type == "ipo"` gives `(h - 1 / (2 * beta)) ** 2`: the margin is regressed to a target instead of pushed through a sigmoid, so the gradient vanishes at the target rather than never.',
      match: {
        python: {all: [/1\s*\/\s*\(\s*2\s*\*\s*beta\s*\)|0\.5\s*\/\s*beta/, /loss_type\s*==\s*["']ipo["']/]},
      },
    },
    {
      id: 'rewards',
      title: 'Implicit rewards β·(log π − log ref), detached',
      detail:
        '`beta * (policy_chosen_logps - reference_chosen_logps).detach()` and the same for rejected: the reward the policy implicitly assigns, logged for monitoring and kept out of the graph.',
      match: {
        python: {
          all: [
            /beta\s*\*\s*\(\s*policy_chosen_logps\s*-\s*reference_chosen_logps\s*\)/,
            /beta\s*\*\s*\(\s*policy_rejected_logps\s*-\s*reference_rejected_logps\s*\)/,
            /\.detach\(\)/,
          ],
        },
      },
    },
    {
      id: 'metrics',
      title: 'Reward accuracy and margin',
      detail:
        '`(chosen_rewards > rejected_rewards).float().mean()` and `(chosen_rewards - rejected_rewards).mean()`: the two numbers every DPO run logs.',
      match: {python: {all: [/chosen_rewards\s*>\s*rejected_rewards/, /chosen_rewards\s*-\s*rejected_rewards/]}},
    },
    {
      id: 'loss-type',
      title: 'An unknown loss_type is an error',
      detail:
        '`raise ValueError` for anything but `"sigmoid"` and `"ipo"`: a typo must not silently train with the default.',
      match: {python: {all: [/raise ValueError/]}},
    },
  ],
  code: {
    python: {
      starter: `"""DPO, part 2: the loss on four log-probabilities, its conservative (label-smoothed) and IPO variants, and the implicit rewards."""

import torch
import torch.nn.functional as F


def dpo_loss(
    policy_chosen_logps: torch.Tensor,
    policy_rejected_logps: torch.Tensor,
    reference_chosen_logps: torch.Tensor,
    reference_rejected_logps: torch.Tensor,
    beta: float = 0.1,
    label_smoothing: float = 0.0,
    loss_type: str = "sigmoid",
) -> dict[str, torch.Tensor]:
    """Per-pair DPO losses and the implicit rewards, from (B,) summed log-probabilities.

    Returns {"losses": (B,), "chosen_rewards": (B,), "rejected_rewards": (B,),
    "reward_accuracy": scalar, "reward_margin": scalar}; only "losses" carries a gradient.
    """
    raise NotImplementedError("TODO: the margin h, the sigmoid (label-smoothed) and IPO losses, detached rewards, accuracy, margin")


if __name__ == "__main__":
    import math

    from dpo_logprobs import TinyLM, concatenated_forward

    torch.manual_seed(0)

    def sig(x: float) -> float:
        return 1.0 / (1.0 + math.exp(-x))

    # Policy equal to the reference: h = 0, every loss is ln 2 and every reward is 0.
    same = torch.tensor([-4.0, -7.5, -2.0])
    out = dpo_loss(same, same - 1.0, same, same - 1.0)
    assert torch.allclose(out["losses"], torch.full((3,), math.log(2.0)), atol=1e-6)
    assert out["reward_margin"].item() == 0.0 and out["reward_accuracy"].item() == 0.0

    # Closed forms on random log-probabilities, against h computed here.
    pc, pr, rc, rr = (-10 * torch.rand(64, dtype=torch.float64) for _ in range(4))
    h = (pc - pr) - (rc - rr)
    for beta in (0.1, 0.5):
        for eps in (0.0, 0.2):
            got = dpo_loss(pc, pr, rc, rr, beta=beta, label_smoothing=eps)["losses"]
            want = torch.tensor(
                [-(1 - eps) * math.log(sig(beta * v)) - eps * math.log(sig(-beta * v)) for v in h.tolist()],
                dtype=torch.float64,
            )
            assert torch.allclose(got, want, atol=1e-9), (beta, eps)
        got = dpo_loss(pc, pr, rc, rr, beta=beta, loss_type="ipo")["losses"]
        want = torch.tensor([(v - 1 / (2 * beta)) ** 2 for v in h.tolist()], dtype=torch.float64)
        assert torch.allclose(got, want, atol=1e-9), beta

    # Rewards, accuracy and margin.
    out = dpo_loss(pc, pr, rc, rr, beta=0.1)
    assert torch.allclose(out["chosen_rewards"], 0.1 * (pc - rc)) and torch.allclose(out["rejected_rewards"], 0.1 * (pr - rr))
    want_acc = sum(1 for a, b in zip((pc - rc).tolist(), (pr - rr).tolist()) if a > b) / 64
    assert abs(out["reward_accuracy"].item() - want_acc) < 1e-12
    assert abs(out["reward_margin"].item() - 0.1 * h.mean().item()) < 1e-12

    # No overflow far out in either direction.
    far = dpo_loss(torch.tensor([0.0, -5000.0]), torch.tensor([-5000.0, 0.0]), torch.zeros(2), torch.zeros(2), beta=1.0)
    assert torch.isfinite(far["losses"]).all() and far["losses"][0].item() < 1e-6
    assert abs(far["losses"][1].item() - 5000.0) < 1e-3

    # The gradient: d loss / d pi_chosen = -beta * sig(-beta * h), d loss / d pi_rejected = +beta * sig(-beta * h).
    beta = 0.3
    pc_g, pr_g = pc.clone().requires_grad_(True), pr.clone().requires_grad_(True)
    out = dpo_loss(pc_g, pr_g, rc, rr, beta=beta)
    out["losses"].sum().backward()
    weight = torch.tensor([sig(-beta * v) for v in h.tolist()], dtype=torch.float64)
    assert torch.allclose(pc_g.grad, -beta * weight, atol=1e-12)
    assert torch.allclose(pr_g.grad, beta * weight, atol=1e-12)
    assert not out["chosen_rewards"].requires_grad and not out["rejected_rewards"].requires_grad

    # IPO's gradient is linear in h: 2 (h - 1 / (2 beta)), so it never vanishes before the target margin.
    pc_g = pc.clone().requires_grad_(True)
    dpo_loss(pc_g, pr, rc, rr, beta=beta, loss_type="ipo")["losses"].sum().backward()
    assert torch.allclose(pc_g.grad, 2 * (h - 1 / (2 * beta)), atol=1e-9)

    try:
        dpo_loss(pc, pr, rc, rr, loss_type="hinge2")
        raise AssertionError("an unknown loss_type must raise")
    except ValueError:
        pass

    # End to end on real log-probabilities: the gradient reaches the policy and only the policy.
    policy, reference = TinyLM(), TinyLM()
    batch = {"prompt": [[1, 5, 7], [1, 9]], "chosen": [[3, 3, 2], [8, 10]], "rejected": [[6], [12, 2, 4]]}
    with torch.no_grad():
        ref_c, ref_r = concatenated_forward(reference, batch)
    pol_c, pol_r = concatenated_forward(policy, batch)
    dpo_loss(pol_c, pol_r, ref_c, ref_r)["losses"].mean().backward()
    assert all(p.grad is not None for p in policy.parameters())
    assert all(p.grad is None for p in reference.parameters())
    print(f"loss at h = 0: {math.log(2.0):.6f}; gradient matches -beta * sigmoid(-beta * h)")
    print("PASS")
`,
      solution: `"""DPO, part 2: the loss on four log-probabilities, its conservative (label-smoothed) and IPO variants, and the implicit rewards."""

import torch
import torch.nn.functional as F


def dpo_loss(
    policy_chosen_logps: torch.Tensor,
    policy_rejected_logps: torch.Tensor,
    reference_chosen_logps: torch.Tensor,
    reference_rejected_logps: torch.Tensor,
    beta: float = 0.1,
    label_smoothing: float = 0.0,
    loss_type: str = "sigmoid",
) -> dict[str, torch.Tensor]:
    """Per-pair DPO losses and the implicit rewards, from (B,) summed log-probabilities.

    Returns {"losses": (B,), "chosen_rewards": (B,), "rejected_rewards": (B,),
    "reward_accuracy": scalar, "reward_margin": scalar}; only "losses" carries a gradient.
    """
    pi_logratios = policy_chosen_logps - policy_rejected_logps
    ref_logratios = reference_chosen_logps - reference_rejected_logps
    h = pi_logratios - ref_logratios
    if loss_type == "sigmoid":
        losses = -F.logsigmoid(beta * h) * (1 - label_smoothing) - F.logsigmoid(-beta * h) * label_smoothing
    elif loss_type == "ipo":
        losses = (h - 1 / (2 * beta)) ** 2
    else:
        raise ValueError(f"unknown loss_type {loss_type!r}: use 'sigmoid' or 'ipo'")
    chosen_rewards = beta * (policy_chosen_logps - reference_chosen_logps).detach()
    rejected_rewards = beta * (policy_rejected_logps - reference_rejected_logps).detach()
    return {
        "losses": losses,
        "chosen_rewards": chosen_rewards,
        "rejected_rewards": rejected_rewards,
        "reward_accuracy": (chosen_rewards > rejected_rewards).float().mean(),
        "reward_margin": (chosen_rewards - rejected_rewards).mean(),
    }


if __name__ == "__main__":
    import math

    from dpo_logprobs import TinyLM, concatenated_forward

    torch.manual_seed(0)

    def sig(x: float) -> float:
        return 1.0 / (1.0 + math.exp(-x))

    # Policy equal to the reference: h = 0, every loss is ln 2 and every reward is 0.
    same = torch.tensor([-4.0, -7.5, -2.0])
    out = dpo_loss(same, same - 1.0, same, same - 1.0)
    assert torch.allclose(out["losses"], torch.full((3,), math.log(2.0)), atol=1e-6)
    assert out["reward_margin"].item() == 0.0 and out["reward_accuracy"].item() == 0.0

    # Closed forms on random log-probabilities, against h computed here.
    pc, pr, rc, rr = (-10 * torch.rand(64, dtype=torch.float64) for _ in range(4))
    h = (pc - pr) - (rc - rr)
    for beta in (0.1, 0.5):
        for eps in (0.0, 0.2):
            got = dpo_loss(pc, pr, rc, rr, beta=beta, label_smoothing=eps)["losses"]
            want = torch.tensor(
                [-(1 - eps) * math.log(sig(beta * v)) - eps * math.log(sig(-beta * v)) for v in h.tolist()],
                dtype=torch.float64,
            )
            assert torch.allclose(got, want, atol=1e-9), (beta, eps)
        got = dpo_loss(pc, pr, rc, rr, beta=beta, loss_type="ipo")["losses"]
        want = torch.tensor([(v - 1 / (2 * beta)) ** 2 for v in h.tolist()], dtype=torch.float64)
        assert torch.allclose(got, want, atol=1e-9), beta

    # Rewards, accuracy and margin.
    out = dpo_loss(pc, pr, rc, rr, beta=0.1)
    assert torch.allclose(out["chosen_rewards"], 0.1 * (pc - rc)) and torch.allclose(out["rejected_rewards"], 0.1 * (pr - rr))
    want_acc = sum(1 for a, b in zip((pc - rc).tolist(), (pr - rr).tolist()) if a > b) / 64
    assert abs(out["reward_accuracy"].item() - want_acc) < 1e-12
    assert abs(out["reward_margin"].item() - 0.1 * h.mean().item()) < 1e-12

    # No overflow far out in either direction.
    far = dpo_loss(torch.tensor([0.0, -5000.0]), torch.tensor([-5000.0, 0.0]), torch.zeros(2), torch.zeros(2), beta=1.0)
    assert torch.isfinite(far["losses"]).all() and far["losses"][0].item() < 1e-6
    assert abs(far["losses"][1].item() - 5000.0) < 1e-3

    # The gradient: d loss / d pi_chosen = -beta * sig(-beta * h), d loss / d pi_rejected = +beta * sig(-beta * h).
    beta = 0.3
    pc_g, pr_g = pc.clone().requires_grad_(True), pr.clone().requires_grad_(True)
    out = dpo_loss(pc_g, pr_g, rc, rr, beta=beta)
    out["losses"].sum().backward()
    weight = torch.tensor([sig(-beta * v) for v in h.tolist()], dtype=torch.float64)
    assert torch.allclose(pc_g.grad, -beta * weight, atol=1e-12)
    assert torch.allclose(pr_g.grad, beta * weight, atol=1e-12)
    assert not out["chosen_rewards"].requires_grad and not out["rejected_rewards"].requires_grad

    # IPO's gradient is linear in h: 2 (h - 1 / (2 beta)), so it never vanishes before the target margin.
    pc_g = pc.clone().requires_grad_(True)
    dpo_loss(pc_g, pr, rc, rr, beta=beta, loss_type="ipo")["losses"].sum().backward()
    assert torch.allclose(pc_g.grad, 2 * (h - 1 / (2 * beta)), atol=1e-9)

    try:
        dpo_loss(pc, pr, rc, rr, loss_type="hinge2")
        raise AssertionError("an unknown loss_type must raise")
    except ValueError:
        pass

    # End to end on real log-probabilities: the gradient reaches the policy and only the policy.
    policy, reference = TinyLM(), TinyLM()
    batch = {"prompt": [[1, 5, 7], [1, 9]], "chosen": [[3, 3, 2], [8, 10]], "rejected": [[6], [12, 2, 4]]}
    with torch.no_grad():
        ref_c, ref_r = concatenated_forward(reference, batch)
    pol_c, pol_r = concatenated_forward(policy, batch)
    dpo_loss(pol_c, pol_r, ref_c, ref_r)["losses"].mean().backward()
    assert all(p.grad is not None for p in policy.parameters())
    assert all(p.grad is None for p in reference.parameters())
    print(f"loss at h = 0: {math.log(2.0):.6f}; gradient matches -beta * sigmoid(-beta * h)")
    print("PASS")
`,
    },
  },
  debrief: `This is \`preference_loss\` from the DPO authors' trainer, line for line, and the \`"sigmoid"\` and \`"ipo"\` branches of TRL's \`DPOTrainer\` loss. **Why it works**: the RLHF objective, maximise reward minus \`β·KL(π ‖ π_ref)\`, has a closed-form optimum \`π*(y | x) ∝ π_ref(y | x) · exp(r(x, y) / β)\`. Turned around, any policy defines a reward \`r = β · log(π / π_ref)\` up to a term that depends only on the prompt, and that term cancels in a Bradley–Terry comparison of two responses to the same prompt. So the reward model's logistic loss on preference pairs can be written directly in terms of the policy: \`−log σ(β·h)\`. The "implicit rewards" are exactly that \`β · log(π / π_ref)\`, which is why they are worth logging. **The gradient** is \`−β·σ(−β·h)\` times \`∇ log π(y_w) − ∇ log π(y_l)\`: a pair the policy already ranks well (large \`h\`) gets a small weight, a mis-ranked one a weight near \`β\`. **β** sets how far the policy may drift: it is the KL coefficient of the objective DPO solves. **cDPO** assumes a fraction ε of labels are flipped; the loss then bottoms out at a finite margin. **IPO** argues that with deterministic preferences DPO's optimum sends \`h\` to infinity and the KL anchor stops working, and replaces the sigmoid by a squared loss with a finite target \`1/(2β)\`. Production adds: the reference log-probs precomputed once, length-averaged log-probs for IPO (as TRL computes it), more loss types (hinge, robust, EXO and others in TRL), an SFT term on the chosen response (RPO), and sync of the rewards across ranks before logging.`,
};
