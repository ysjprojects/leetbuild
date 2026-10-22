import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Media and pricing calls before a partial publish',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'media', 'pricing'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the media and pricing
services are healthy the product publishes, so the demo passes. Every failure path publishes
something worse than nothing. Review it, fix it, and prove the fix.

Implement the validation the publish path runs before the pointer moves.

- **Every call carries a 5-second deadline.** A rendition or pricing check without one lets one
  stuck dependency hold the publish open indefinitely.
- **All renditions are required.** Validate every rendition in \`RENDITIONS\` and **hold the whole
  version back** when one is missing or not \`ready\` — publish nothing rather than a page with a
  hole where the main image should be.
- **A rejected pricing table is terminal.** A \`REJECTED\` answer is raised to the caller (a
  \`PricingRejected\`/\`ErrPricingRejected\`) instead of being retried in a loop; retrying the same
  rejection just hammers the pricing service until the draft itself changes.
- **Validation re-runs only when the draft changes.** Fingerprint the draft
  (\`draftFingerprint\`/\`validatedFingerprint\`) so a publish that already passed for this draft
  does not call the dependencies again, and a new draft is validated before it can move the pointer.
- **A held-back publish leaves the pointer on the previous version.** The validation runs **before**
  the swap, so a failure means the storefront keeps serving what it already had.

**Failure mode the checks target.** The draft publishes the moment the **first** rendition succeeds
and marks the rest best-effort, so a product goes live missing its main image; it retries a rejected
pricing table forever, so a bad draft becomes a hot loop against pricing; and because validation is
best-effort, the pointer moves even when the version is incomplete.`,
  sequence: {
    participants: ['Catalog API', 'Media service', 'Pricing service', 'Redis pointer'],
    messages: [
      {from: 'Catalog API', to: 'Media service', label: 'ValidateRenditions · deadline 5 s', kind: 'sync'},
      {from: 'Media service', to: 'Catalog API', label: 'ready · or NOT_FOUND rendition', kind: 'reply'},
      {from: 'Catalog API', to: 'Pricing service', label: 'ValidatePricing · deadline 5 s', kind: 'sync'},
      {from: 'Pricing service', to: 'Catalog API', label: 'accepted · or REJECTED (terminal)', kind: 'reply'},
      {from: 'Catalog API', to: 'Redis pointer', label: 'swap only after both validations pass', kind: 'sync'},
      {from: 'Redis pointer', to: 'Catalog API', label: 'previous version still live on failure', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every validation call carries a 5-second deadline',
      detail:
        'The media and pricing calls are made with a 5-second deadline (`DEADLINE_S`/`DEADLINE_MS`, `deadlineSeconds`, a call timeout, `withDeadlineAfter`, `set_deadline`). Without it one stuck dependency holds the publish open.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineSeconds\s*=\s*5/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineSeconds\s*=\s*5/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineSeconds\s*=\s*5/, /set_deadline\(/]},
      },
    },
    {
      id: 'renditions-required',
      title: 'A missing rendition holds the whole version back',
      detail:
        'Every rendition in `RENDITIONS` is checked and validated, and a missing or not-ready one raises a held-back publish (`PublishHeld`) instead of being skipped. The draft publishes as soon as the first rendition succeeds and calls the rest best-effort.',
      match: {
        python: {all: [/RENDITIONS/, /def validate_renditions/, /raise PublishHeld/], none: [/best_effort/]},
        typescript: {all: [/RENDITIONS/, /validateRenditions\(/, /PublishHeld/], none: [/bestEffort/]},
        go: {all: [/renditions/, /validateRenditions\(/, /ErrPublishHeld/], none: [/bestEffort/]},
        scala: {all: [/Renditions/, /validateRenditions\(/, /PublishHeld/], none: [/bestEffort/]},
        cpp: {all: [/kRenditions/, /validateRenditions\(/, /PublishHeld/], none: [/bestEffort/]},
      },
    },
    {
      id: 'pricing-terminal',
      title: 'A rejected pricing table is terminal until the draft changes',
      detail:
        '`validate_pricing`/`validatePricing` raises a rejection (`PricingRejected`) to the caller; there is no retry loop around the pricing call. Retrying the same rejection hammers pricing and still fails.',
      match: {
        python: {all: [/validate_pricing\(/, /PricingRejected/], none: [/while\s+True/]},
        typescript: {
          all: [/validatePricing\(/, /PricingRejected/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/validatePricing\(/, /ErrPricingRejected/], none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/]},
        scala: {all: [/validatePricing\(/, /PricingRejected/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/validatePricing\(/, /PricingRejected/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'hold-back',
      title: 'Validates before the pointer swap',
      detail:
        'Validation runs before the published pointer is swapped, so a failure holds the version back and the storefront keeps the previous one. The draft validates best-effort and swaps anyway.',
      match: {
        python: {order: [/validate_renditions\(/, /swap_published\(/]},
        typescript: {order: [/validateRenditions\(/, /swapPublished\(/]},
        go: {order: [/validateRenditions\(/, /SwapPublished\(/]},
        scala: {order: [/validateRenditions\(/, /swapPublished\(/]},
        cpp: {order: [/validateRenditions\(/, /swapPublished\(/]},
      },
    },
    {
      id: 'draft-fingerprint',
      title: 'Revalidates only when the draft changes',
      detail:
        'The validated draft is fingerprinted (`draft_fingerprint`/`draftFingerprint`, remembered in `validated_fingerprint`), so the terminal pricing rejection is invalidated by a new draft and not by a retry of the same one.',
      match: {
        python: {all: [/def draft_fingerprint/, /validated_fingerprint/]},
        typescript: {all: [/draftFingerprint\(/, /validatedFingerprint/]},
        go: {all: [/draftFingerprint\(/, /validatedFingerprint/]},
        scala: {all: [/draftFingerprint\(/, /validatedFingerprint/]},
        cpp: {all: [/draftFingerprint\(/, /validatedFingerprint/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import media_pb2
import media_pb2_grpc
import pricing_pb2
import pricing_pb2_grpc
from catalog_store import swap_published

media = media_pb2_grpc.MediaStub(grpc.insecure_channel("media:9000"))
pricing = pricing_pb2_grpc.PricingStub(grpc.insecure_channel("pricing:9000"))


def publish(product_id: str, draft: dict) -> dict:
    # TODO: this draft publishes as soon as the first rendition lands, treats the rest as
    # best-effort, and retries a rejected pricing table until it passes. Review all three.
    for rendition in draft["renditions"].values():
        try:
            media.Validate(
                media_pb2.RenditionRequest(product_id=product_id, rendition=rendition["name"]),
                timeout=8.0,
            )
            break
        except grpc.RpcError:
            continue
    while True:
        try:
            pricing.Validate(
                pricing_pb2.PricingRequest(product_id=product_id, price_cents=draft["price_cents"])
            )
            break
        except grpc.RpcError:
            continue
    return swap_published(product_id, draft["version"])
`,
      solution: `import grpc

import media_pb2
import media_pb2_grpc
import pricing_pb2
import pricing_pb2_grpc
from catalog_store import swap_published

DEADLINE_S = 5
RENDITIONS = ("original", "thumb", "card")

media = media_pb2_grpc.MediaStub(grpc.insecure_channel("media:9000"))
pricing = pricing_pb2_grpc.PricingStub(grpc.insecure_channel("pricing:9000"))


class PublishHeld(Exception):
    """A validation failed: the whole version is held back and the pointer does not move."""


class PricingRejected(Exception):
    """The pricing table rejected this draft: terminal until the draft itself changes."""


validated_fingerprint: str | None = None


def draft_fingerprint(draft: dict) -> str:
    return f"{draft['version']}:{draft['price_cents']}:{draft['tax_class']}:{len(draft['renditions'])}"


def validate_renditions(product_id: str, renditions: dict) -> None:
    for name in RENDITIONS:
        rendition = renditions.get(name)
        if rendition is None or rendition.get("status") != "ready":
            raise PublishHeld(f"rendition {name} is not ready")
    for name in RENDITIONS:
        media.Validate(
            media_pb2.RenditionRequest(product_id=product_id, rendition=name),
            timeout=DEADLINE_S,
        )


def validate_pricing(product_id: str, draft: dict) -> None:
    try:
        pricing.Validate(
            pricing_pb2.PricingRequest(product_id=product_id, price_cents=draft["price_cents"]),
            timeout=DEADLINE_S,
        )
    except grpc.RpcError as exc:
        # Terminal until the draft changes: retrying the same rejection hammers pricing.
        raise PricingRejected(str(exc)) from exc


def publish(product_id: str, draft: dict) -> dict:
    global validated_fingerprint
    fingerprint = draft_fingerprint(draft)
    if validated_fingerprint != fingerprint:
        validate_renditions(product_id, draft["renditions"])
        validate_pricing(product_id, draft)
        validated_fingerprint = fingerprint
    # The pointer only moves after both validations passed: a held-back publish changes nothing.
    return swap_published(product_id, draft["version"])
`,
    },
    typescript: {
      starter: `/** Publish validation: a model-generated draft that publishes on the first rendition. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {swapPublished} from './catalog-store';

interface DraftView {
  version: number;
  price_cents: number;
  renditions: Record<string, {name: string; status: string}>;
}

const {media, pricing} = grpc.loadPackageDefinition(protoLoader.loadSync('catalog.proto')) as unknown as {
  media: {Media: new (target: string, credentials: grpc.ChannelCredentials) => {Validate: Function}};
  pricing: {Pricing: new (target: string, credentials: grpc.ChannelCredentials) => {Validate: Function}};
};

export async function publish(productId: string, draft: DraftView): Promise<number> {
  // TODO: this draft publishes as soon as the first rendition lands, treats the rest as
  // best-effort, and retries a rejected pricing table until it passes. Review all three.
  for (const rendition of Object.values(draft.renditions)) {
    try {
      await call(media, {product_id: productId, rendition: rendition.name}, {deadline: Date.now() + 8000});
      break;
    } catch {
      continue;
    }
  }
  for (;;) {
    try {
      await call(pricing, {product_id: productId, price_cents: draft.price_cents}, {});
      break;
    } catch {
      continue;
    }
  }
  return swapPublished(productId, draft.version);
}

function call(client: {Validate: Function}, request: Record<string, unknown>, options: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.Validate(request, options, (error: grpc.ServiceError | null, reply: unknown) => {
      if (error) reject(error);
      else resolve(reply);
    });
  });
}
`,
      solution: `/** Publish validation: every rendition and the pricing table, under one 5 s deadline. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {swapPublished} from './catalog-store';

const DEADLINE_MS = 5000;
const RENDITIONS = ['original', 'thumb', 'card'] as const;

export class PublishHeld extends Error {}
export class PricingRejected extends Error {}

interface DraftView {
  version: number;
  price_cents: number;
  tax_class: string;
  renditions: Record<string, {name: string; status: string}>;
}

interface Validator {
  Validate(request: Record<string, unknown>, options: object, callback: (error: grpc.ServiceError | null) => void): void;
}

const {media, pricing} = grpc.loadPackageDefinition(protoLoader.loadSync('catalog.proto')) as unknown as {
  media: {Media: new (target: string, credentials: grpc.ChannelCredentials) => Validator};
  pricing: {Pricing: new (target: string, credentials: grpc.ChannelCredentials) => Validator};
};

let validatedFingerprint: string | null = null;

function draftFingerprint(draft: DraftView): string {
  return \`\${draft.version}:\${draft.price_cents}:\${draft.tax_class}:\${Object.keys(draft.renditions).length}\`;
}

function call(client: Validator, request: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    client.Validate(request, {deadline: Date.now() + DEADLINE_MS}, (error: grpc.ServiceError | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function validateRenditions(productId: string, renditions: DraftView['renditions']): Promise<void> {
  for (const name of RENDITIONS) {
    const rendition = renditions[name];
    if (rendition === undefined || rendition.status !== 'ready') throw new PublishHeld(\`rendition \${name} is not ready\`);
  }
  for (const name of RENDITIONS) {
    await call(media, {product_id: productId, rendition: name});
  }
}

async function validatePricing(productId: string, draft: DraftView): Promise<void> {
  try {
    await call(pricing, {product_id: productId, price_cents: draft.price_cents});
  } catch (error) {
    // Terminal until the draft changes: retrying the same rejection hammers pricing.
    throw new PricingRejected((error as Error).message);
  }
}

export async function publish(productId: string, draft: DraftView): Promise<number> {
  const fingerprint = draftFingerprint(draft);
  if (validatedFingerprint !== fingerprint) {
    await validateRenditions(productId, draft.renditions);
    await validatePricing(productId, draft);
    validatedFingerprint = fingerprint;
  }
  // The pointer only moves after both validations passed: a held-back publish changes nothing.
  return swapPublished(productId, draft.version);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	pb "catalog/mediapb"
	pricepb "catalog/pricingpb"
)

type Rendition struct {
	Name   string
	Status string
}

type DraftView struct {
	Version    int
	PriceCents int64
	TaxClass   string
	Renditions map[string]Rendition
}

func publish(
	ctx context.Context,
	media pb.MediaClient,
	pricing pricepb.PricingClient,
	productID string,
	draft DraftView,
) (int, error) {
	// TODO: this draft publishes as soon as the first rendition lands, treats the rest as
	// best-effort, and retries a rejected pricing table until it passes. Review all three.
	for _, rendition := range draft.Renditions {
		callCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		_, err := media.Validate(callCtx, &pb.RenditionRequest{ProductId: productID, Rendition: rendition.Name})
		cancel()
		if err == nil {
			break
		}
	}
	for attempt := 0; ; attempt++ {
		_, err := pricing.Validate(ctx, &pricepb.PricingRequest{ProductId: productID, PriceCents: draft.PriceCents})
		if err == nil {
			break
		}
	}
	return SwapPublished(ctx, productID, draft.Version)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	pb "catalog/mediapb"
	pricepb "catalog/pricingpb"
)

const deadlineSeconds = 5

var renditions = []string{"original", "thumb", "card"}

var (
	ErrPublishHeld     = errors.New("publish held back")
	ErrPricingRejected = errors.New("pricing rejected this draft")
)

type Rendition struct {
	Name   string
	Status string
}

type DraftView struct {
	Version    int
	PriceCents int64
	TaxClass   string
	Renditions map[string]Rendition
}

var validatedFingerprint string

func draftFingerprint(draft DraftView) string {
	return fmt.Sprintf("%d:%d:%s:%d", draft.Version, draft.PriceCents, draft.TaxClass, len(draft.Renditions))
}

func validateRenditions(ctx context.Context, media pb.MediaClient, productID string, draft DraftView) error {
	for _, name := range renditions {
		rendition, ok := draft.Renditions[name]
		if !ok || rendition.Status != "ready" {
			return fmt.Errorf("%w: rendition %s is not ready", ErrPublishHeld, name)
		}
	}
	for _, name := range renditions {
		callCtx, cancel := context.WithTimeout(ctx, deadlineSeconds*time.Second)
		_, err := media.Validate(callCtx, &pb.RenditionRequest{ProductId: productID, Rendition: name})
		cancel()
		if err != nil {
			return fmt.Errorf("%w: %v", ErrPublishHeld, err)
		}
	}
	return nil
}

func validatePricing(ctx context.Context, pricing pricepb.PricingClient, productID string, draft DraftView) error {
	callCtx, cancel := context.WithTimeout(ctx, deadlineSeconds*time.Second)
	defer cancel()
	_, err := pricing.Validate(callCtx, &pricepb.PricingRequest{ProductId: productID, PriceCents: draft.PriceCents})
	if err != nil {
		// Terminal until the draft changes: retrying the same rejection hammers pricing.
		return fmt.Errorf("%w: %v", ErrPricingRejected, err)
	}
	return nil
}

func publish(
	ctx context.Context,
	media pb.MediaClient,
	pricing pricepb.PricingClient,
	productID string,
	draft DraftView,
) (int, error) {
	fingerprint := draftFingerprint(draft)
	if validatedFingerprint != fingerprint {
		if err := validateRenditions(ctx, media, productID, draft); err != nil {
			return 0, err
		}
		if err := validatePricing(ctx, pricing, productID, draft); err != nil {
			return 0, err
		}
		validatedFingerprint = fingerprint
	}
	// The pointer only moves after both validations passed: a held-back publish changes nothing.
	return SwapPublished(ctx, productID, draft.Version)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.StatusRuntimeException

object PublishValidation {
  val media = MediaGrpc.blockingStub(ManagedChannelBuilder.forAddress("media", 9000).usePlaintext().build())
  val pricing = PricingGrpc.blockingStub(ManagedChannelBuilder.forAddress("pricing", 9000).usePlaintext().build())

  // TODO: this draft publishes as soon as the first rendition lands, treats the rest as
  // best-effort, and retries a rejected pricing table until it passes. Review all three.
  def publish(productId: String, draft: DraftView): Int = {
    draft.renditions.values.foreach { rendition =>
      try {
        media
          .withDeadlineAfter(8, TimeUnit.SECONDS)
          .validate(RenditionRequest(productId = productId, rendition = rendition.name))
        return swapPublished(productId, draft.version)
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    while (true) {
      try {
        pricing.validate(PricingRequest(productId = productId, priceCents = draft.priceCents))
        return swapPublished(productId, draft.version)
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    swapPublished(productId, draft.version)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.StatusRuntimeException

object PublishValidation {
  val DeadlineSeconds = 5
  val Renditions = List("original", "thumb", "card")

  val media = MediaGrpc.blockingStub(ManagedChannelBuilder.forAddress("media", 9000).usePlaintext().build())
  val pricing = PricingGrpc.blockingStub(ManagedChannelBuilder.forAddress("pricing", 9000).usePlaintext().build())

  final case class PublishHeld(message: String) extends RuntimeException(message)
  final case class PricingRejected(message: String) extends RuntimeException(message)

  private var validatedFingerprint: Option[String] = None

  def draftFingerprint(draft: DraftView): String =
    s"\${draft.version}:\${draft.priceCents}:\${draft.taxClass}:\${draft.renditions.size}"

  def validateRenditions(productId: String, draft: DraftView): Unit = {
    Renditions.foreach { name =>
      if (!draft.renditions.get(name).exists(_.status == "ready")) {
        throw PublishHeld(s"rendition $name is not ready")
      }
    }
    Renditions.foreach { name =>
      media
        .withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
        .validate(RenditionRequest(productId = productId, rendition = name))
    }
  }

  def validatePricing(productId: String, draft: DraftView): Unit = {
    try {
      pricing
        .withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
        .validate(PricingRequest(productId = productId, priceCents = draft.priceCents))
    } catch {
      case exc: StatusRuntimeException =>
        // Terminal until the draft changes: retrying the same rejection hammers pricing.
        throw PricingRejected(exc.getMessage)
    }
  }

  def publish(productId: String, draft: DraftView): Int = {
    val fingerprint = draftFingerprint(draft)
    if (!validatedFingerprint.contains(fingerprint)) {
      validateRenditions(productId, draft)
      validatePricing(productId, draft)
      validatedFingerprint = Some(fingerprint)
    }
    // The pointer only moves after both validations passed: a held-back publish changes nothing.
    swapPublished(productId, draft.version)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "catalog.grpc.pb.h"

int swapPublished(const std::string& productId, int version);

int publish(Media::Stub& media, Pricing::Stub& pricing, const std::string& productId, const DraftView& draft) {
  // TODO: this draft publishes as soon as the first rendition lands, treats the rest as
  // best-effort, and retries a rejected pricing table until it passes. Review all three.
  for (const auto& [name, rendition] : draft.renditions()) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(8));
    RenditionRequest request;
    request.set_product_id(productId);
    request.set_rendition(rendition.name());
    RenditionReply reply;
    if (media.Validate(&context, request, &reply).ok()) {
      return swapPublished(productId, draft.version());
    }
  }
  while (true) {
    grpc::ClientContext context;
    PricingRequest request;
    request.set_product_id(productId);
    request.set_price_cents(draft.price_cents());
    PricingReply reply;
    if (pricing.Validate(&context, request, &reply).ok()) {
      return swapPublished(productId, draft.version());
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <vector>

#include "catalog.grpc.pb.h"

constexpr int kDeadlineSeconds = 5;
const std::vector<std::string> kRenditions = {"original", "thumb", "card"};

struct PublishHeld {
  std::string message;
};

struct PricingRejected {
  std::string message;
};

int swapPublished(const std::string& productId, int version);

std::string validatedFingerprint;

std::string draftFingerprint(const DraftView& draft) {
  return std::to_string(draft.version()) + ":" + std::to_string(draft.price_cents()) + ":" + draft.tax_class();
}

void validateRenditions(Media::Stub& media, const std::string& productId, const DraftView& draft) {
  for (const auto& name : kRenditions) {
    const auto it = draft.renditions().find(name);
    if (it == draft.renditions().end() || it->second.status() != "ready") {
      throw PublishHeld{"rendition " + name + " is not ready"};
    }
  }
  for (const auto& name : kRenditions) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
    RenditionRequest request;
    request.set_product_id(productId);
    request.set_rendition(name);
    RenditionReply reply;
    if (!media.Validate(&context, request, &reply).ok()) {
      throw PublishHeld{"rendition " + name + " failed validation"};
    }
  }
}

void validatePricing(Pricing::Stub& pricing, const std::string& productId, const DraftView& draft) {
  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
  PricingRequest request;
  request.set_product_id(productId);
  request.set_price_cents(draft.price_cents());
  PricingReply reply;
  if (!pricing.Validate(&context, request, &reply).ok()) {
    // Terminal until the draft changes: retrying the same rejection hammers pricing.
    throw PricingRejected{"pricing rejected this draft"};
  }
}

int publish(Media::Stub& media, Pricing::Stub& pricing, const std::string& productId, const DraftView& draft) {
  const auto fingerprint = draftFingerprint(draft);
  if (validatedFingerprint != fingerprint) {
    validateRenditions(media, productId, draft);
    validatePricing(pricing, productId, draft);
    validatedFingerprint = fingerprint;
  }
  // The pointer only moves after both validations passed: a held-back publish changes nothing.
  return swapPublished(productId, draft.version());
}
`,
    },
  },
  hints: [
    'A deadline is an argument on the call, not a wrapper: `timeout=DEADLINE_S`, `{deadline: Date.now() + DEADLINE_MS}`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Without one, one slow rendition pins the publish and the request that is holding it.',
    'Loop over the declared renditions and raise on the first one that is missing or not `ready` — the loop is over `RENDITIONS`, not over the draft\'s own renditions, because a draft with no main image has nothing to iterate. "Best effort" here means "publish a broken product".',
    'Validation is a precondition of the swap, not a side effect of it: run it before `swapPublished(...)` and let the exception propagate, so the previous version stays live. Fingerprint the draft instead of retrying the rejection, so a stale rejection cannot block a corrected draft.',
  ],
  debrief: `The interviewer is checking whether you can review failure handling on a path whose happy case is already written. Three defects: partial success treated as success (publish on the first rendition), an unbounded retry against a service that has already said no (a hot loop that also blocks the publish), and validation that does not gate the pointer swap — so even a validated failure can leave a half-published product. The pattern to internalise is "all-or-nothing across dependencies": validate everything under a deadline, raise on the first failure, and let the state change (the pointer swap) be the *last* thing that happens. Real catalogs add a per-rendition readiness webhook, a pricing evaluation cache keyed by draft fingerprint, and a compensating hold that tells merchandising why the version did not go live.`,
};
