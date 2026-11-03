import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Media and pricing calls before a partial publish',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'media', 'pricing'],
  task: `## Task

**Starting point.** The starter is the validation the publish path runs before the pointer moves:
\`validate_and_publish(product_id, draft, expected)\` asks the media service for the draft's
renditions and the pricing service for its price and tax class over gRPC, then calls
\`publish_snapshot\` (step 2, provided as \`catalog.snapshot\`). With both services healthy it
publishes, and it hides five flaws.

**Failure mode the checks target.** A product goes live without its card image; a draft the pricing
table rejects is retried against pricing five times and published anyway; a slow pricing service
holds the publish open for eight seconds; and a rejection is never remembered, so every retry of
the same draft pays the calls again.

\`\`\`proto
service Media   { rpc ValidateRendition(RenditionRequest) returns (Rendition); }   // NOT_FOUND: not produced
service Pricing { rpc ValidatePricing(PricingRequest) returns (PricingVerdict); }  // FAILED_PRECONDITION: rejected
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 5 s** deadline.
- Every rendition in \`RENDITIONS\` is validated; one that is \`NOT_FOUND\` raises \`PublishHeld\` and
  nothing is published.
- The pricing status decides: \`FAILED_PRECONDITION\` is \`PricingRejected\`, terminal for this draft;
  \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\` is \`ValidationUnavailable\`, which the caller may retry.
- A rejection is remembered per product under \`draft_fingerprint(product_id, draft)\`: a replay of
  the same draft raises \`PricingRejected\` without a call; a changed draft, or a look-alike draft of
  another product, is validated.
- Validation runs before \`publish_snapshot\`, so a held or rejected draft leaves the pointer alone.`,
  sequence: {
    participants: ['Catalog API', 'Media service', 'Pricing service', 'Redis pointer'],
    messages: [
      {from: 'Catalog API', to: 'Media service', label: 'ValidateRendition ×3 · deadline 5 s', kind: 'sync'},
      {from: 'Media service', to: 'Catalog API', label: 'Rendition · or NOT_FOUND → PublishHeld', kind: 'reply'},
      {from: 'Catalog API', to: 'Pricing service', label: 'ValidatePricing · deadline 5 s', kind: 'sync'},
      {
        from: 'Pricing service',
        to: 'Catalog API',
        label: 'PricingVerdict · FAILED_PRECONDITION → PricingRejected · DEADLINE_EXCEEDED → ValidationUnavailable',
        kind: 'reply',
      },
      {from: 'Catalog API', to: 'Redis pointer', label: 'publish_snapshot only after both passed', kind: 'sync'},
      {from: 'Redis pointer', to: 'Catalog API', label: 'previous version still live on a hold', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every validation call carries a 5-second deadline',
      detail:
        'Both the media and the pricing call are made with `DEADLINE_S` (5 s); the starter gives media eight seconds and pricing none, so one stuck dependency holds the publish open.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*5\b/,
            /ValidateRendition\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/,
            /ValidatePricing\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*5000\b/,
            /ValidateRendition\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
            /ValidatePricing\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
          ],
        },
        go: {
          all: [/deadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/],
          none: [/8\s*\*\s*time\.Second/],
        },
        scala: {
          all: [/DeadlineSeconds\s*=\s*5L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/],
          none: [/withDeadlineAfter\(\s*8/],
        },
        cpp: {all: [/kDeadline\{5\}/, /set_deadline\([^\n]*kDeadline\)/], none: [/seconds\{8\}|seconds\(8\)/]},
      },
    },
    {
      id: 'renditions-required',
      title: 'A missing rendition holds the whole version back',
      detail:
        'Every rendition in `RENDITIONS` is validated and a `NOT_FOUND` raises `PublishHeld`; the starter stops at the first rendition that answers and skips the ones that fail.',
      match: {
        python: {all: [/for \w+ in RENDITIONS/, /raise PublishHeld/], none: [/\n\s*continue\b/, /\n\s*break\b/]},
        typescript: {
          all: [/for \(const \w+ of RENDITIONS\)/, /throw new PublishHeld/],
          none: [/\bcontinue;/, /\bbreak;/],
        },
        go: {all: [/range renditions/, /ErrPublishHeld/], none: [/\bcontinue\b/, /\bbreak\b/]},
        scala: {
          all: [/Renditions\.foreach|for \(\w+ <- Renditions\)/, /throw new PublishHeld/],
          none: [/\.find\(|\.exists\(|headOption/],
        },
        cpp: {all: [/for \(const [\w:&\s]+ : kRenditions\)/, /throw PublishHeld/], none: [/\bcontinue;/, /\bbreak;/]},
      },
    },
    {
      id: 'pricing-terminal',
      title: 'A rejection is terminal, a deadline is retryable',
      detail:
        '`FAILED_PRECONDITION` from pricing raises `PricingRejected`; `DEADLINE_EXCEEDED` or `UNAVAILABLE` raises `ValidationUnavailable`; neither is retried in place. The starter retries any error, sleeping between attempts, then publishes anyway.',
      match: {
        python: {
          all: [/FAILED_PRECONDITION/, /raise PricingRejected/, /raise ValidationUnavailable/],
          none: [/time\.sleep\(/, /for attempt in/, /while\s+True/],
        },
        typescript: {
          all: [/FAILED_PRECONDITION/, /throw new PricingRejected/, /throw new ValidationUnavailable/],
          none: [/setTimeout\(/, /for \(let attempt/, /for \(;;\)/, /while \(true\)/],
        },
        go: {
          all: [/codes\.FailedPrecondition/, /ErrPricingRejected/, /ErrValidationUnavailable/],
          none: [/time\.Sleep\(/, /for attempt :=/],
        },
        scala: {
          all: [/FAILED_PRECONDITION/, /throw new PricingRejected/, /throw new ValidationUnavailable/],
          none: [/Thread\.sleep\(/, /for \(attempt <-|\(1 to \d\)/, /while \(true\)/],
        },
        cpp: {
          all: [/FAILED_PRECONDITION/, /throw PricingRejected/, /throw ValidationUnavailable/],
          none: [/sleep_for\(/, /for \(int attempt/, /while \(true\)/],
        },
      },
    },
    {
      id: 'hold-back',
      title: 'Validates before the pointer swap',
      detail:
        'Renditions and pricing are validated, each raising on failure, before `publish_snapshot`/`publishSnapshot` is called, so a held or rejected draft leaves the storefront on the previous version.',
      match: {
        python: {
          order: [
            /def validate_renditions/,
            /def validate_pricing/,
            /validate_renditions\(/,
            /validate_pricing\(/,
            /publish_snapshot\(/,
          ],
        },
        typescript: {
          order: [
            /function validateRenditions/,
            /function validatePricing/,
            /validateRenditions\(/,
            /validatePricing\(/,
            /publishSnapshot\(/,
          ],
        },
        go: {
          order: [
            /func validateRenditions/,
            /func validatePricing/,
            /validateRenditions\(/,
            /validatePricing\(/,
            /snapshot\.PublishSnapshot\(/,
          ],
        },
        scala: {
          order: [
            /def validateRenditions/,
            /def validatePricing/,
            /validateRenditions\(/,
            /validatePricing\(/,
            /Snapshot\.publishSnapshot\(/,
          ],
        },
        cpp: {
          order: [
            /void validateRenditions/,
            /void validatePricing/,
            /validateRenditions\(/,
            /validatePricing\(/,
            /snapshot::publishSnapshot\(/,
          ],
        },
      },
    },
    {
      id: 'draft-fingerprint',
      title: 'Remembers a rejection per product and draft',
      detail:
        'The rejected draft is fingerprinted with its product id (`draft_fingerprint(product_id, draft)`) and remembered in `rejected` keyed by the product, so a replay raises without a call while a changed draft, or another product with the same fields, is validated.',
      match: {
        python: {
          all: [/def draft_fingerprint\(\s*product_id/, /rejected\.get\(\s*product_id|rejected\[\s*product_id\s*\]/],
        },
        typescript: {
          all: [
            /draftFingerprint\s*=\s*\(\s*productId|function draftFingerprint\(\s*productId/,
            /rejected\.get\(\s*productId|rejected\.set\(\s*productId/,
          ],
        },
        go: {all: [/func draftFingerprint\(\s*productID/, /rejected\[\s*productID\s*\]/]},
        scala: {all: [/def draftFingerprint\(\s*productId/, /rejected\.get\(\s*productId|rejected\(\s*productId\s*\)/]},
        cpp: {
          all: [
            /draftFingerprint\(\s*const std::string& product_id/,
            /rejected\[\s*product_id\s*\]|rejected\.find\(\s*product_id/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import validation_pb2
import validation_pb2_grpc
from catalog.snapshot import publish_snapshot

RENDITIONS = ("original", "thumb", "card")

media = validation_pb2_grpc.MediaStub(grpc.insecure_channel("media:9000"))
pricing = validation_pb2_grpc.PricingStub(grpc.insecure_channel("pricing:9000"))


class PublishHeld(Exception):
    """A rendition is not ready: the whole version is held back."""


class PricingRejected(Exception):
    """The pricing table rejected this draft: terminal until the draft changes."""


class ValidationUnavailable(Exception):
    """A dependency did not answer in time: the caller may retry."""


def validate_and_publish(product_id: str, draft: dict, expected: int | None) -> bool:
    """Validate the draft row (product_id, version, title, price_cents, tax_class) and make it the published version."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    for name in RENDITIONS:
        try:
            media.ValidateRendition(
                validation_pb2.RenditionRequest(product_id=product_id, version=draft["version"], rendition=name),
                timeout=8.0,
            )
            break  # one rendition is ready: the others are produced on demand
        except grpc.RpcError:
            continue
    for attempt in range(5):
        try:
            pricing.ValidatePricing(
                validation_pb2.PricingRequest(
                    product_id=product_id, version=draft["version"], price_cents=draft["price_cents"], tax_class=draft["tax_class"]
                )
            )
            break
        except grpc.RpcError:
            time.sleep(1.0)  # pricing is flaky: try again
    snapshot = {name: draft[name] for name in ("product_id", "version", "title", "price_cents", "tax_class")}
    return publish_snapshot(product_id, draft["version"], snapshot, expected)
`,
      solution: `import grpc

import validation_pb2
import validation_pb2_grpc
from catalog.snapshot import publish_snapshot

DEADLINE_S = 5
RENDITIONS = ("original", "thumb", "card")

media = validation_pb2_grpc.MediaStub(grpc.insecure_channel("media:9000"))
pricing = validation_pb2_grpc.PricingStub(grpc.insecure_channel("pricing:9000"))


class PublishHeld(Exception):
    """A rendition is not ready: the whole version is held back."""


class PricingRejected(Exception):
    """The pricing table rejected this draft: terminal until the draft changes."""


class ValidationUnavailable(Exception):
    """A dependency did not answer in time: the caller may retry."""


# Per product, the fingerprint of the draft pricing last rejected: a replay of it is refused without a call.
rejected: dict[str, str] = {}


def draft_fingerprint(product_id: str, draft: dict) -> str:
    return f"{product_id}:{draft['version']}:{draft['price_cents']}:{draft['tax_class']}"


def validate_renditions(product_id: str, version: int) -> None:
    for name in RENDITIONS:
        try:
            media.ValidateRendition(
                validation_pb2.RenditionRequest(product_id=product_id, version=version, rendition=name),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.NOT_FOUND:
                raise PublishHeld(f"rendition {name} is not ready") from exc
            raise ValidationUnavailable(f"media: {exc.code().name}") from exc


def validate_pricing(product_id: str, draft: dict) -> None:
    fingerprint = draft_fingerprint(product_id, draft)
    if rejected.get(product_id) == fingerprint:
        raise PricingRejected("pricing rejected this draft; change it before publishing again")
    try:
        pricing.ValidatePricing(
            validation_pb2.PricingRequest(
                product_id=product_id, version=draft["version"], price_cents=draft["price_cents"], tax_class=draft["tax_class"]
            ),
            timeout=DEADLINE_S,
        )
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
            rejected[product_id] = fingerprint  # terminal until the draft changes
            raise PricingRejected(exc.details()) from exc
        # DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the draft: the caller may retry.
        raise ValidationUnavailable(f"pricing: {exc.code().name}") from exc


def validate_and_publish(product_id: str, draft: dict, expected: int | None) -> bool:
    """Validate the draft row (product_id, version, title, price_cents, tax_class) and make it the published version."""
    validate_renditions(product_id, draft["version"])
    validate_pricing(product_id, draft)
    # Both passed: only now does the pointer move.
    snapshot = {name: draft[name] for name in ("product_id", "version", "title", "price_cents", "tax_class")}
    return publish_snapshot(product_id, draft["version"], snapshot, expected)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {publishSnapshot} from 'catalog/snapshot';

export const RENDITIONS = ['original', 'thumb', 'card'] as const;

export interface Draft {
  product_id: string;
  version: number;
  title: string | null;
  price_cents: number | null;
  tax_class: string | null;
}

interface RenditionRequest {
  product_id: string;
  version: number;
  rendition: string;
}

interface PricingRequest {
  product_id: string;
  version: number;
  price_cents: number;
  tax_class: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('validation.proto')) as unknown as {
  catalog: {Media: grpc.ServiceClientConstructor; Pricing: grpc.ServiceClientConstructor};
};
const media = new pkg.catalog.Media('media:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ValidateRendition(request: RenditionRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rendition: string; url: string}>;
};
const pricing = new pkg.catalog.Pricing('pricing:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ValidatePricing(request: PricingRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{price_list: string}>;
};

/** A rendition is not ready: the whole version is held back. */
export class PublishHeld extends Error {}
/** The pricing table rejected this draft: terminal until the draft changes. */
export class PricingRejected extends Error {}
/** A dependency did not answer in time: the caller may retry. */
export class ValidationUnavailable extends Error {}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Validate the draft row and make it the published version. */
export async function validateAndPublish(productId: string, draft: Draft, expected: number | null): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (const name of RENDITIONS) {
    try {
      await media.ValidateRendition({product_id: productId, version: draft.version, rendition: name}, new grpc.Metadata(), {deadline: Date.now() + 8000});
      break; // one rendition is ready: the others are produced on demand
    } catch {
      continue;
    }
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await pricing.ValidatePricing(
        {product_id: productId, version: draft.version, price_cents: draft.price_cents ?? 0, tax_class: draft.tax_class ?? ''},
        new grpc.Metadata(),
        {},
      );
      break;
    } catch {
      await sleep(1000); // pricing is flaky: try again
    }
  }
  const {product_id, version, title, price_cents, tax_class} = draft;
  return publishSnapshot(productId, draft.version, {product_id, version, title, price_cents, tax_class}, expected);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {publishSnapshot} from 'catalog/snapshot';

export const DEADLINE_MS = 5000;
export const RENDITIONS = ['original', 'thumb', 'card'] as const;

export interface Draft {
  product_id: string;
  version: number;
  title: string | null;
  price_cents: number | null;
  tax_class: string | null;
}

interface RenditionRequest {
  product_id: string;
  version: number;
  rendition: string;
}

interface PricingRequest {
  product_id: string;
  version: number;
  price_cents: number;
  tax_class: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('validation.proto')) as unknown as {
  catalog: {Media: grpc.ServiceClientConstructor; Pricing: grpc.ServiceClientConstructor};
};
const media = new pkg.catalog.Media('media:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ValidateRendition(request: RenditionRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rendition: string; url: string}>;
};
const pricing = new pkg.catalog.Pricing('pricing:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ValidatePricing(request: PricingRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{price_list: string}>;
};

/** A rendition is not ready: the whole version is held back. */
export class PublishHeld extends Error {}
/** The pricing table rejected this draft: terminal until the draft changes. */
export class PricingRejected extends Error {}
/** A dependency did not answer in time: the caller may retry. */
export class ValidationUnavailable extends Error {}

/** Per product, the fingerprint of the draft pricing last rejected: a replay of it is refused without a call. */
export const rejected = new Map<string, string>();

export const draftFingerprint = (productId: string, draft: Draft): string =>
  \`\${productId}:\${draft.version}:\${draft.price_cents}:\${draft.tax_class}\`;

async function validateRenditions(productId: string, version: number): Promise<void> {
  for (const name of RENDITIONS) {
    try {
      await media.ValidateRendition({product_id: productId, version, rendition: name}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.NOT_FOUND) throw new PublishHeld(\`rendition \${name} is not ready\`);
      throw new ValidationUnavailable(\`media: \${grpc.status[code]}\`);
    }
  }
}

async function validatePricing(productId: string, draft: Draft): Promise<void> {
  const fingerprint = draftFingerprint(productId, draft);
  if (rejected.get(productId) === fingerprint) throw new PricingRejected('pricing rejected this draft; change it before publishing again');
  try {
    await pricing.ValidatePricing(
      {product_id: productId, version: draft.version, price_cents: draft.price_cents ?? 0, tax_class: draft.tax_class ?? ''},
      new grpc.Metadata(),
      {deadline: Date.now() + DEADLINE_MS},
    );
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    if (code === grpc.status.FAILED_PRECONDITION) {
      rejected.set(productId, fingerprint); // terminal until the draft changes
      throw new PricingRejected(details);
    }
    // DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the draft: the caller may retry.
    throw new ValidationUnavailable(\`pricing: \${grpc.status[code]}\`);
  }
}

/** Validate the draft row and make it the published version. */
export async function validateAndPublish(productId: string, draft: Draft, expected: number | null): Promise<boolean> {
  await validateRenditions(productId, draft.version);
  await validatePricing(productId, draft);
  // Both passed: only now does the pointer move.
  const {product_id, version, title, price_cents, tax_class} = draft;
  return publishSnapshot(productId, draft.version, {product_id, version, title, price_cents, tax_class}, expected);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"catalog/snapshot" // snapshot.PublishSnapshot(ctx, productID, version, snapshot, expected) (bool, error)
	"catalog/store"    // store.Row
	pb "catalog/gen/validation"
)

var renditions = []string{"original", "thumb", "card"}

var (
	mediaConn, _   = grpc.NewClient("media:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	pricingConn, _ = grpc.NewClient("pricing:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	media          = pb.NewMediaClient(mediaConn)
	pricing        = pb.NewPricingClient(pricingConn)
)

var (
	// ErrPublishHeld: a rendition is not ready, the whole version is held back.
	ErrPublishHeld = errors.New("publish held: a rendition is not ready")
	// ErrPricingRejected: the pricing table rejected this draft, terminal until the draft changes.
	ErrPricingRejected = errors.New("pricing rejected this draft")
	// ErrValidationUnavailable: a dependency did not answer in time, the caller may retry.
	ErrValidationUnavailable = errors.New("validation unavailable")
)

// validateAndPublish validates the draft row and makes it the published version.
func validateAndPublish(ctx context.Context, productID string, draft store.Row, expected int) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for _, name := range renditions {
		callCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		_, err := media.ValidateRendition(callCtx, &pb.RenditionRequest{ProductId: productID, Version: int64(draft.Version), Rendition: name})
		cancel()
		if err != nil {
			continue
		}
		break // one rendition is ready: the others are produced on demand
	}
	for attempt := 0; attempt < 5; attempt++ {
		_, err := pricing.ValidatePricing(ctx, &pb.PricingRequest{ProductId: productID, Version: int64(draft.Version), PriceCents: draft.PriceCents, TaxClass: draft.TaxClass})
		if err == nil {
			break
		}
		time.Sleep(time.Second) // pricing is flaky: try again
	}
	doc := map[string]any{"product_id": draft.ProductID, "version": draft.Version, "title": draft.Title, "price_cents": draft.PriceCents, "tax_class": draft.TaxClass}
	return snapshot.PublishSnapshot(ctx, productID, draft.Version, doc, expected)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"catalog/snapshot" // snapshot.PublishSnapshot(ctx, productID, version, snapshot, expected) (bool, error)
	"catalog/store"    // store.Row
	pb "catalog/gen/validation"
)

const deadline = 5 * time.Second

var renditions = []string{"original", "thumb", "card"}

var (
	mediaConn, _   = grpc.NewClient("media:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	pricingConn, _ = grpc.NewClient("pricing:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	media          = pb.NewMediaClient(mediaConn)
	pricing        = pb.NewPricingClient(pricingConn)
)

var (
	// ErrPublishHeld: a rendition is not ready, the whole version is held back.
	ErrPublishHeld = errors.New("publish held: a rendition is not ready")
	// ErrPricingRejected: the pricing table rejected this draft, terminal until the draft changes.
	ErrPricingRejected = errors.New("pricing rejected this draft")
	// ErrValidationUnavailable: a dependency did not answer in time, the caller may retry.
	ErrValidationUnavailable = errors.New("validation unavailable")
)

// rejected holds, per product, the fingerprint of the draft pricing last rejected: a replay of it is refused without a call.
var rejected = map[string]string{}

func draftFingerprint(productID string, draft store.Row) string {
	return fmt.Sprintf("%s:%d:%d:%s", productID, draft.Version, draft.PriceCents, draft.TaxClass)
}

func validateRenditions(ctx context.Context, productID string, version int) error {
	for _, name := range renditions {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		_, err := media.ValidateRendition(callCtx, &pb.RenditionRequest{ProductId: productID, Version: int64(version), Rendition: name})
		cancel()
		if err != nil {
			if status.Code(err) == codes.NotFound {
				return fmt.Errorf("%w: rendition %s", ErrPublishHeld, name)
			}
			return fmt.Errorf("%w: media: %v", ErrValidationUnavailable, status.Code(err))
		}
	}
	return nil
}

func validatePricing(ctx context.Context, productID string, draft store.Row) error {
	fingerprint := draftFingerprint(productID, draft)
	if rejected[productID] == fingerprint {
		return fmt.Errorf("%w: change the draft before publishing again", ErrPricingRejected)
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	_, err := pricing.ValidatePricing(callCtx, &pb.PricingRequest{ProductId: productID, Version: int64(draft.Version), PriceCents: draft.PriceCents, TaxClass: draft.TaxClass})
	if err == nil {
		return nil
	}
	if status.Code(err) == codes.FailedPrecondition {
		rejected[productID] = fingerprint // terminal until the draft changes
		return fmt.Errorf("%w: %s", ErrPricingRejected, status.Convert(err).Message())
	}
	// DeadlineExceeded, Unavailable and the rest say nothing about the draft: the caller may retry.
	return fmt.Errorf("%w: pricing: %v", ErrValidationUnavailable, status.Code(err))
}

// validateAndPublish validates the draft row and makes it the published version.
func validateAndPublish(ctx context.Context, productID string, draft store.Row, expected int) (bool, error) {
	if err := validateRenditions(ctx, productID, draft.Version); err != nil {
		return false, err
	}
	if err := validatePricing(ctx, productID, draft); err != nil {
		return false, err
	}
	// Both passed: only now does the pointer move.
	doc := map[string]any{"product_id": draft.ProductID, "version": draft.Version, "title": draft.Title, "price_cents": draft.PriceCents, "tax_class": draft.TaxClass}
	return snapshot.PublishSnapshot(ctx, productID, draft.Version, doc, expected)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

import catalog.Snapshot // Snapshot.publishSnapshot(productId, version, snapshot, expected): Boolean
import catalog.Store    // Store.Row
import catalog.validation.{MediaGrpc, PricingGrpc, PricingRequest, RenditionRequest}

/** A rendition is not ready: the whole version is held back. */
final class PublishHeld(message: String) extends Exception(message)
/** The pricing table rejected this draft: terminal until the draft changes. */
final class PricingRejected(message: String) extends Exception(message)
/** A dependency did not answer in time: the caller may retry. */
final class ValidationUnavailable(message: String) extends Exception(message)

object Client {
  val Renditions: Seq[String] = Seq("original", "thumb", "card")

  private val media = MediaGrpc.blockingStub(ManagedChannelBuilder.forAddress("media", 9000).usePlaintext().build())
  private val pricing = PricingGrpc.blockingStub(ManagedChannelBuilder.forAddress("pricing", 9000).usePlaintext().build())

  private def snapshotOf(draft: Store.Row): JsObject = JsObject(
    "product_id" -> JsString(draft.productId), "version" -> JsNumber(draft.version),
    "title" -> draft.title.map(JsString(_)).getOrElse(JsNull), "price_cents" -> draft.priceCents.map(JsNumber(_)).getOrElse(JsNull),
    "tax_class" -> draft.taxClass.map(JsString(_)).getOrElse(JsNull))

  /** Validate the draft row and make it the published version. */
  def validateAndPublish(productId: String, draft: Store.Row, expected: Option[Long]): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    Renditions.find { name =>
      try { media.withDeadlineAfter(8, TimeUnit.SECONDS).validateRendition(RenditionRequest(productId, draft.version, name)); true }
      catch { case _: StatusRuntimeException => false }
    } // one rendition is ready: the others are produced on demand
    val request = PricingRequest(productId, draft.version, draft.priceCents.getOrElse(0L), draft.taxClass.getOrElse(""))
    var attempt = 0
    var ok = false
    while (attempt < 5 && !ok) {
      try { pricing.validatePricing(request); ok = true }
      catch { case _: StatusRuntimeException => Thread.sleep(1000); attempt += 1 } // pricing is flaky: try again
    }
    Snapshot.publishSnapshot(productId, draft.version, snapshotOf(draft), expected)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import spray.json._

import catalog.Snapshot // Snapshot.publishSnapshot(productId, version, snapshot, expected): Boolean
import catalog.Store    // Store.Row
import catalog.validation.{MediaGrpc, PricingGrpc, PricingRequest, RenditionRequest}

/** A rendition is not ready: the whole version is held back. */
final class PublishHeld(message: String) extends Exception(message)
/** The pricing table rejected this draft: terminal until the draft changes. */
final class PricingRejected(message: String) extends Exception(message)
/** A dependency did not answer in time: the caller may retry. */
final class ValidationUnavailable(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 5L
  val Renditions: Seq[String] = Seq("original", "thumb", "card")

  private val media = MediaGrpc.blockingStub(ManagedChannelBuilder.forAddress("media", 9000).usePlaintext().build())
  private val pricing = PricingGrpc.blockingStub(ManagedChannelBuilder.forAddress("pricing", 9000).usePlaintext().build())

  /** Per product, the fingerprint of the draft pricing last rejected: a replay of it is refused without a call. */
  private val rejected = scala.collection.mutable.Map.empty[String, String]

  def draftFingerprint(productId: String, draft: Store.Row): String =
    s"$productId:\${draft.version}:\${draft.priceCents.getOrElse(0L)}:\${draft.taxClass.getOrElse("")}"

  private def snapshotOf(draft: Store.Row): JsObject = JsObject(
    "product_id" -> JsString(draft.productId), "version" -> JsNumber(draft.version),
    "title" -> draft.title.map(JsString(_)).getOrElse(JsNull), "price_cents" -> draft.priceCents.map(JsNumber(_)).getOrElse(JsNull),
    "tax_class" -> draft.taxClass.map(JsString(_)).getOrElse(JsNull))

  def validateRenditions(productId: String, version: Long): Unit =
    Renditions.foreach { name =>
      try media.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).validateRendition(RenditionRequest(productId, version, name))
      catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.NOT_FOUND => throw new PublishHeld(s"rendition $name is not ready")
        case e: StatusRuntimeException => throw new ValidationUnavailable(s"media: \${e.getStatus.getCode}")
      }
    }

  def validatePricing(productId: String, draft: Store.Row): Unit = {
    val fingerprint = draftFingerprint(productId, draft)
    if (rejected.get(productId).contains(fingerprint)) throw new PricingRejected("pricing rejected this draft; change it before publishing again")
    val request = PricingRequest(productId, draft.version, draft.priceCents.getOrElse(0L), draft.taxClass.getOrElse(""))
    try pricing.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).validatePricing(request)
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.FAILED_PRECONDITION =>
        rejected(productId) = fingerprint // terminal until the draft changes
        throw new PricingRejected(Option(e.getStatus.getDescription).getOrElse("rejected"))
      // DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the draft: the caller may retry.
      case e: StatusRuntimeException => throw new ValidationUnavailable(s"pricing: \${e.getStatus.getCode}")
    }
  }

  /** Validate the draft row and make it the published version. */
  def validateAndPublish(productId: String, draft: Store.Row, expected: Option[Long]): Boolean = {
    validateRenditions(productId, draft.version)
    validatePricing(productId, draft)
    // Both passed: only now does the pointer move.
    Snapshot.publishSnapshot(productId, draft.version, snapshotOf(draft), expected)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "catalog/snapshot.h"  // snapshot::publishSnapshot(product_id, version, snapshot, expected) -> bool
#include "catalog/store.h"     // store::Row
#include "validation.grpc.pb.h"

using json = nlohmann::json;

const std::vector<std::string> kRenditions = {"original", "thumb", "card"};

auto media = catalog::Media::NewStub(grpc::CreateChannel("media:9000", grpc::InsecureChannelCredentials()));
auto pricing = catalog::Pricing::NewStub(grpc::CreateChannel("pricing:9000", grpc::InsecureChannelCredentials()));

// A rendition is not ready: the whole version is held back.
struct PublishHeld : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The pricing table rejected this draft: terminal until the draft changes.
struct PricingRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// A dependency did not answer in time: the caller may retry.
struct ValidationUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

json snapshotOf(const store::Row& draft) {
  return json{{"product_id", draft.product_id}, {"version", draft.version}, {"title", draft.title},
              {"price_cents", draft.price_cents}, {"tax_class", draft.tax_class}};
}

// Validate the draft row and make it the published version.
bool validateAndPublish(const std::string& product_id, const store::Row& draft, long expected) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (const std::string& name : kRenditions) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{8});
    catalog::RenditionRequest request;
    request.set_product_id(product_id);
    request.set_version(draft.version);
    request.set_rendition(name);
    catalog::Rendition rendition;
    if (!media->ValidateRendition(&ctx, request, &rendition).ok()) continue;
    break;  // one rendition is ready: the others are produced on demand
  }
  catalog::PricingRequest request;
  request.set_product_id(product_id);
  request.set_version(draft.version);
  request.set_price_cents(draft.price_cents);
  request.set_tax_class(draft.tax_class);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    catalog::PricingVerdict verdict;
    if (pricing->ValidatePricing(&ctx, request, &verdict).ok()) break;
    std::this_thread::sleep_for(std::chrono::seconds{1});  // pricing is flaky: try again
  }
  return snapshot::publishSnapshot(product_id, draft.version, snapshotOf(draft), expected);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "catalog/snapshot.h"  // snapshot::publishSnapshot(product_id, version, snapshot, expected) -> bool
#include "catalog/store.h"     // store::Row
#include "validation.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kDeadline{5};
const std::vector<std::string> kRenditions = {"original", "thumb", "card"};

auto media = catalog::Media::NewStub(grpc::CreateChannel("media:9000", grpc::InsecureChannelCredentials()));
auto pricing = catalog::Pricing::NewStub(grpc::CreateChannel("pricing:9000", grpc::InsecureChannelCredentials()));

// A rendition is not ready: the whole version is held back.
struct PublishHeld : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The pricing table rejected this draft: terminal until the draft changes.
struct PricingRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// A dependency did not answer in time: the caller may retry.
struct ValidationUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Per product, the fingerprint of the draft pricing last rejected: a replay of it is refused without a call.
std::map<std::string, std::string> rejected;

std::string draftFingerprint(const std::string& product_id, const store::Row& draft) {
  return product_id + ":" + std::to_string(draft.version) + ":" + std::to_string(draft.price_cents) + ":" + draft.tax_class;
}

json snapshotOf(const store::Row& draft) {
  return json{{"product_id", draft.product_id}, {"version", draft.version}, {"title", draft.title},
              {"price_cents", draft.price_cents}, {"tax_class", draft.tax_class}};
}

void validateRenditions(const std::string& product_id, long version) {
  for (const std::string& name : kRenditions) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    catalog::RenditionRequest request;
    request.set_product_id(product_id);
    request.set_version(version);
    request.set_rendition(name);
    catalog::Rendition rendition;
    const grpc::Status status = media->ValidateRendition(&ctx, request, &rendition);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::NOT_FOUND) throw PublishHeld("rendition " + name + " is not ready");
      throw ValidationUnavailable("media: " + status.error_message());
    }
  }
}

void validatePricing(const std::string& product_id, const store::Row& draft) {
  const std::string fingerprint = draftFingerprint(product_id, draft);
  if (rejected.find(product_id) != rejected.end() && rejected[product_id] == fingerprint) {
    throw PricingRejected("pricing rejected this draft; change it before publishing again");
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  catalog::PricingRequest request;
  request.set_product_id(product_id);
  request.set_version(draft.version);
  request.set_price_cents(draft.price_cents);
  request.set_tax_class(draft.tax_class);
  catalog::PricingVerdict verdict;
  const grpc::Status status = pricing->ValidatePricing(&ctx, request, &verdict);
  if (status.ok()) return;
  if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) {
    rejected[product_id] = fingerprint;  // terminal until the draft changes
    throw PricingRejected(status.error_message());
  }
  // DEADLINE_EXCEEDED, UNAVAILABLE and the rest say nothing about the draft: the caller may retry.
  throw ValidationUnavailable("pricing: " + status.error_message());
}

// Validate the draft row and make it the published version.
bool validateAndPublish(const std::string& product_id, const store::Row& draft, long expected) {
  validateRenditions(product_id, draft.version);
  validatePricing(product_id, draft);
  // Both passed: only now does the pointer move.
  return snapshot::publishSnapshot(product_id, draft.version, snapshotOf(draft), expected);
}
`,
    },
  },
  harness: {
    python: `import grpc

import validation_pb2
import validation_pb2_grpc
from catalog.snapshot import read_published

DRAFT = {"product_id": "p-1", "version": 1, "title": "Kettle", "price_cents": 3499, "tax_class": "standard"}
BAD = {**DRAFT, "tax_class": "none"}


class Media(validation_pb2_grpc.MediaServicer):
    """Every rendition of every product is ready, except those in missing (product_id, rendition)."""

    def __init__(self):
        self.missing = set()

    def ValidateRendition(self, request, context):
        if (request.product_id, request.rendition) in self.missing:
            context.abort(grpc.StatusCode.NOT_FOUND, f"rendition {request.rendition} of {request.product_id} is not produced")
        return validation_pb2.Rendition(rendition=request.rendition, url=f"https://img/{request.product_id}/{request.version}/{request.rendition}.jpg")


class Pricing(validation_pb2_grpc.PricingServicer):
    """The price list has every tax class but none."""

    def ValidatePricing(self, request, context):
        if request.tax_class == "none" or request.price_cents <= 0:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"tax class {request.tax_class!r} is not in the price list")
        return validation_pb2.PricingVerdict(price_list="2026-q4")


def _client(ctx):
    media = Media()
    ctx.grpc.serve(validation_pb2_grpc.add_MediaServicer_to_server, media)
    ctx.grpc.serve(validation_pb2_grpc.add_PricingServicer_to_server, Pricing())
    return ctx.load("client"), media


def _raises(m, exc, draft, why):
    try:
        moved = m.validate_and_publish("p-1" if draft is None else draft["product_id"], DRAFT if draft is None else draft, None)
    except exc:
        return
    except Exception as other:
        raise AssertionError(f"{why}: validate_and_publish raised {type(other).__name__}: {other}, expected {exc.__name__}")
    raise AssertionError(f"{why}: validate_and_publish returned {moved!r} instead of raising {exc.__name__}")


def check_deadline(ctx):
    m, _ = _client(ctx)
    assert m.validate_and_publish("p-1", DRAFT, None) is True, "with both services healthy the draft must be published"
    for method in ("ValidateRendition", "ValidatePricing"):
        calls = ctx.grpc.calls_to(method)
        assert calls, f"no {method} call was made"
        for call in calls:
            assert call.timeout is not None, f"a {method} call carries no deadline: a stalled dependency would hold the publish open"
            assert 4.5 <= call.timeout <= 5.5, f"a {method} call carries a {call.timeout} s deadline, expected DEADLINE_S = 5"
    ctx.grpc.set_latency("ValidatePricing", 10.0)
    before = len(ctx.grpc.calls_to("ValidatePricing"))
    v2 = {**DRAFT, "version": 2}
    _raises(m, m.ValidationUnavailable, v2, "pricing slower than the deadline")
    assert len(ctx.grpc.calls_to("ValidatePricing")) == before + 1, "a deadline is reported to the caller, not retried in place"
    assert read_published("p-1")["version"] == 1, f"a publish that timed out on pricing moved the pointer to {read_published('p-1')}"


def check_renditions_required(ctx):
    m, media = _client(ctx)
    media.missing.add(("p-1", "card"))
    _raises(m, m.PublishHeld, None, "with the card rendition not produced")
    asked = {c.request.rendition for c in ctx.grpc.calls_to("ValidateRendition")}
    assert asked == set(m.RENDITIONS), f"the media service was asked for {sorted(asked)}, expected every rendition in RENDITIONS {sorted(m.RENDITIONS)}"
    assert read_published("p-1") is None, f"a version missing its card rendition went live: {read_published('p-1')}"
    media.missing.clear()
    assert m.validate_and_publish("p-1", DRAFT, None) is True, "once every rendition is produced the draft must be published"
    assert read_published("p-1") == DRAFT, f"the storefront serves {read_published('p-1')}"


def check_pricing_terminal(ctx):
    m, _ = _client(ctx)
    _raises(m, m.PricingRejected, BAD, "with a tax class the price list rejects")
    calls = len(ctx.grpc.calls_to("ValidatePricing"))
    assert calls == 1, f"a rejected draft was sent to pricing {calls} times: a rejection is terminal, not retried"
    assert ctx.clock.sleeps == 0, "a rejection must not be slept on and retried"
    assert read_published("p-1") is None, f"a draft pricing rejected went live: {read_published('p-1')}"
    ctx.grpc.set_latency("ValidatePricing", 10.0)
    _raises(m, m.ValidationUnavailable, None, "with pricing slower than the deadline")
    ctx.grpc.set_latency("ValidatePricing", 0.0)
    assert m.validate_and_publish("p-1", DRAFT, None) is True, "a deadline is retryable: once pricing answers again the same draft must be published"


def check_hold_back(ctx):
    m, media = _client(ctx)
    assert m.validate_and_publish("p-1", DRAFT, None) is True, "a valid draft must be published"
    v2 = {**DRAFT, "version": 2, "title": "Kettle, 2 L"}
    media.missing.add(("p-1", "thumb"))
    _raises(m, m.PublishHeld, v2, "with the thumb rendition of version 2 not produced")
    assert read_published("p-1") == DRAFT, f"a held version 2 moved the pointer: the storefront serves {read_published('p-1')}, expected version 1"
    media.missing.clear()
    _raises(m, m.PricingRejected, {**v2, "tax_class": "none"}, "with version 2 priced in a tax class the price list rejects")
    assert read_published("p-1") == DRAFT, f"a rejected version 2 moved the pointer: the storefront serves {read_published('p-1')}, expected version 1"
    assert m.validate_and_publish("p-1", v2, 1) is True, "the corrected version 2 must be published"
    assert read_published("p-1") == v2, f"the storefront serves {read_published('p-1')}, expected version 2"


def check_draft_fingerprint(ctx):
    m, _ = _client(ctx)
    _raises(m, m.PricingRejected, BAD, "with a tax class the price list rejects")
    assert len(ctx.grpc.calls_to("ValidatePricing")) == 1, "the first attempt makes one pricing call"
    _raises(m, m.PricingRejected, BAD, "replaying the rejected draft")
    assert len(ctx.grpc.calls_to("ValidatePricing")) == 1, f"a replay of the rejected draft called pricing again ({len(ctx.grpc.calls_to('ValidatePricing'))} calls): the rejection is terminal until the draft changes"
    lookalike = {**BAD, "product_id": "p-2"}
    _raises(m, m.PricingRejected, lookalike, "with a look-alike draft of another product")
    assert len(ctx.grpc.calls_to("ValidatePricing")) == 2, "a look-alike draft of another product is a different draft: pricing must be asked about it"
    assert read_published("p-2") is None, "the look-alike draft of p-2 must not be published"
    fixed = {**BAD, "version": 2, "tax_class": "standard"}
    assert m.validate_and_publish("p-1", fixed, None) is True, "a changed draft of the rejected product must be validated and published"
    assert len(ctx.grpc.calls_to("ValidatePricing")) == 3, "the changed draft must be sent to pricing"
    assert read_published("p-1") == fixed, f"the storefront serves {read_published('p-1')}, expected the corrected version 2"
`,
    typescript: `const DRAFT = {product_id: 'p-1', version: 1, title: 'Kettle', price_cents: 3499, tax_class: 'standard'};
const BAD = {...DRAFT, tax_class: 'none'};

/** The media service (every rendition ready but those in missing) and the price list (every tax class but none). */
function client(ctx) {
  const pkg = ctx.proto('validation.proto');
  const missing = new Set<string>();
  ctx.grpc.serve(pkg.catalog.Media.service, {
    ValidateRendition(call, callback) {
      const {product_id, version, rendition} = call.request;
      if (missing.has(\`\${product_id}/\${rendition}\`)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`rendition \${rendition} of \${product_id} is not produced\`});
      callback(null, {rendition, url: \`https://img/\${product_id}/\${version}/\${rendition}.jpg\`});
    },
  });
  ctx.grpc.serve(pkg.catalog.Pricing.service, {
    ValidatePricing(call, callback) {
      const {tax_class, price_cents} = call.request;
      if (tax_class === 'none' || Number(price_cents) <= 0) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: \`tax class "\${tax_class}" is not in the price list\`});
      callback(null, {price_list: '2026-q4'});
    },
  });
  const m = ctx.load('client');
  const {readPublished} = ctx.load('/support/catalog/snapshot.ts');
  return {m, missing, readPublished};
}

async function raises(m, exc, draft, why: string): Promise<void> {
  let moved;
  try {
    moved = await m.validateAndPublish(draft.product_id, draft, null);
  } catch (e) {
    if (e instanceof exc) return;
    assert.fail(\`\${why}: validateAndPublish threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected \${exc.name}\`);
  }
  assert.fail(\`\${why}: validateAndPublish returned \${moved} instead of throwing \${exc.name}\`);
}

export async function check_deadline(ctx) {
  const {m, readPublished} = client(ctx);
  assert.equal(await m.validateAndPublish('p-1', DRAFT, null), true, 'with both services healthy the draft must be published');
  for (const method of ['ValidateRendition', 'ValidatePricing']) {
    const calls = ctx.grpc.callsTo(method);
    assert(calls.length > 0, \`no \${method} call was made\`);
    for (const call of calls) {
      assert(call.timeout !== null, \`a \${method} call carries no deadline: a stalled dependency would hold the publish open\`);
      assert(4.5 <= call.timeout && call.timeout <= 5.5, \`a \${method} call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 5000\`);
    }
  }
  ctx.grpc.setLatency('ValidatePricing', 10.0);
  const before = ctx.grpc.callsTo('ValidatePricing').length;
  await raises(m, m.ValidationUnavailable, {...DRAFT, version: 2}, 'pricing slower than the deadline');
  assert.equal(ctx.grpc.callsTo('ValidatePricing').length, before + 1, 'a deadline is reported to the caller, not retried in place');
  assert.equal((await readPublished('p-1')).version, 1, 'a publish that timed out on pricing moved the pointer');
}

export async function check_renditions_required(ctx) {
  const {m, missing, readPublished} = client(ctx);
  missing.add('p-1/card');
  await raises(m, m.PublishHeld, DRAFT, 'with the card rendition not produced');
  const asked = [...new Set(ctx.grpc.callsTo('ValidateRendition').map(c => c.request.rendition))].sort();
  assert.deepStrictEqual(asked, [...m.RENDITIONS].sort(), \`the media service was asked for \${JSON.stringify(asked)}, expected every rendition in RENDITIONS\`);
  assert.equal(await readPublished('p-1'), null, 'a version missing its card rendition went live');
  missing.clear();
  assert.equal(await m.validateAndPublish('p-1', DRAFT, null), true, 'once every rendition is produced the draft must be published');
  assert.deepStrictEqual(await readPublished('p-1'), DRAFT, 'the storefront must serve version 1');
}

export async function check_pricing_terminal(ctx) {
  const {m, readPublished} = client(ctx);
  await raises(m, m.PricingRejected, BAD, 'with a tax class the price list rejects');
  const calls = ctx.grpc.callsTo('ValidatePricing').length;
  assert.equal(calls, 1, \`a rejected draft was sent to pricing \${calls} times: a rejection is terminal, not retried\`);
  assert.equal(ctx.clock.sleeps, 0, 'a rejection must not be slept on and retried');
  assert.equal(await readPublished('p-1'), null, 'a draft pricing rejected went live');
  ctx.grpc.setLatency('ValidatePricing', 10.0);
  await raises(m, m.ValidationUnavailable, DRAFT, 'with pricing slower than the deadline');
  ctx.grpc.setLatency('ValidatePricing', 0);
  assert.equal(await m.validateAndPublish('p-1', DRAFT, null), true, 'a deadline is retryable: once pricing answers again the same draft must be published');
}

export async function check_hold_back(ctx) {
  const {m, missing, readPublished} = client(ctx);
  assert.equal(await m.validateAndPublish('p-1', DRAFT, null), true, 'a valid draft must be published');
  const v2 = {...DRAFT, version: 2, title: 'Kettle, 2 L'};
  missing.add('p-1/thumb');
  await raises(m, m.PublishHeld, v2, 'with the thumb rendition of version 2 not produced');
  assert.deepStrictEqual(await readPublished('p-1'), DRAFT, 'a held version 2 moved the pointer: the storefront must still serve version 1');
  missing.clear();
  await raises(m, m.PricingRejected, {...v2, tax_class: 'none'}, 'with version 2 priced in a tax class the price list rejects');
  assert.deepStrictEqual(await readPublished('p-1'), DRAFT, 'a rejected version 2 moved the pointer: the storefront must still serve version 1');
  assert.equal(await m.validateAndPublish('p-1', v2, 1), true, 'the corrected version 2 must be published');
  assert.deepStrictEqual(await readPublished('p-1'), v2, 'the storefront must serve version 2');
}

export async function check_draft_fingerprint(ctx) {
  const {m, readPublished} = client(ctx);
  await raises(m, m.PricingRejected, BAD, 'with a tax class the price list rejects');
  assert.equal(ctx.grpc.callsTo('ValidatePricing').length, 1, 'the first attempt makes one pricing call');
  await raises(m, m.PricingRejected, BAD, 'replaying the rejected draft');
  assert.equal(ctx.grpc.callsTo('ValidatePricing').length, 1, 'a replay of the rejected draft called pricing again: the rejection is terminal until the draft changes');
  await raises(m, m.PricingRejected, {...BAD, product_id: 'p-2'}, 'with a look-alike draft of another product');
  assert.equal(ctx.grpc.callsTo('ValidatePricing').length, 2, 'a look-alike draft of another product is a different draft: pricing must be asked about it');
  assert.equal(await readPublished('p-2'), null, 'the look-alike draft of p-2 must not be published');
  const fixed = {...BAD, version: 2, tax_class: 'standard'};
  assert.equal(await m.validateAndPublish('p-1', fixed, null), true, 'a changed draft of the rejected product must be validated and published');
  assert.equal(ctx.grpc.callsTo('ValidatePricing').length, 3, 'the changed draft must be sent to pricing');
  assert.deepStrictEqual(await readPublished('p-1'), fixed, 'the storefront must serve the corrected version 2');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"catalog/snapshot"
	"catalog/store"
	pb "catalog/gen/validation"

	"leetbuild/harness"
)

var (
	clientBg = context.Background()
	draft    = store.Row{ProductID: "p-1", Version: 1, Status: "draft", Title: "Kettle", PriceCents: 3499, TaxClass: "standard"}
	bad      = store.Row{ProductID: "p-1", Version: 1, Status: "draft", Title: "Kettle", PriceCents: 3499, TaxClass: "none"}
)

// mediaPeer has every rendition of every product ready, except those in missing ("product/rendition").
type mediaPeer struct {
	pb.UnimplementedMediaServer
	missing map[string]bool
}

func (m *mediaPeer) ValidateRendition(_ context.Context, req *pb.RenditionRequest) (*pb.Rendition, error) {
	if m.missing[req.GetProductId()+"/"+req.GetRendition()] {
		return nil, status.Errorf(codes.NotFound, "rendition %s of %s is not produced", req.GetRendition(), req.GetProductId())
	}
	return &pb.Rendition{Rendition: req.GetRendition(), Url: fmt.Sprintf("https://img/%s/%d/%s.jpg", req.GetProductId(), req.GetVersion(), req.GetRendition())}, nil
}

// pricingPeer's price list has every tax class but none.
type pricingPeer struct {
	pb.UnimplementedPricingServer
}

func (pricingPeer) ValidatePricing(_ context.Context, req *pb.PricingRequest) (*pb.PricingVerdict, error) {
	if req.GetTaxClass() == "none" || req.GetPriceCents() <= 0 {
		return nil, status.Errorf(codes.FailedPrecondition, "tax class %q is not in the price list", req.GetTaxClass())
	}
	return &pb.PricingVerdict{PriceList: "2026-q4"}, nil
}

func client(ctx *harness.Ctx) *mediaPeer {
	media := &mediaPeer{missing: map[string]bool{}}
	pb.RegisterMediaServer(ctx.GRPC.Server(""), media)
	pb.RegisterPricingServer(ctx.GRPC.Server(""), pricingPeer{})
	return media
}

func published(ctx *harness.Ctx, productID string) map[string]any {
	s, err := snapshot.ReadPublished(clientBg, productID)
	ctx.NoError(err, "ReadPublished(%s) failed", productID)
	return s
}

func publishedVersion(ctx *harness.Ctx, productID string) int {
	s := published(ctx, productID)
	if s == nil {
		return 0
	}
	v, _ := s["version"].(float64)
	return int(v)
}

func mustMove(ctx *harness.Ctx, d store.Row, expected int, why string) {
	moved, err := validateAndPublish(clientBg, d.ProductID, d, expected)
	ctx.NoError(err, "%s: validateAndPublish failed", why)
	ctx.Equal(moved, true, "%s: the pointer must move; moved", why)
}

func mustFail(ctx *harness.Ctx, d store.Row, target error, why string) {
	moved, err := validateAndPublish(clientBg, d.ProductID, d, 0)
	ctx.Assert(err != nil, "%s: validateAndPublish returned %v instead of an error wrapping %v", why, moved, target)
	ctx.ErrorIs(err, target, "%s: validateAndPublish returned %v", why, err)
}

func with(d store.Row, version int, title, taxClass string) store.Row {
	d.Version = version
	if title != "" {
		d.Title = title
	}
	if taxClass != "" {
		d.TaxClass = taxClass
	}
	return d
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	mustMove(ctx, draft, 0, "with both services healthy")
	for _, method := range []string{"ValidateRendition", "ValidatePricing"} {
		calls := ctx.GRPC.CallsTo(method, "")
		ctx.Assert(len(calls) > 0, "no %s call was made", method)
		for _, call := range calls {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled dependency would hold the publish open", method)
			ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a %s call carries a %v deadline, expected 5 s", method, call.Timeout)
		}
	}
	ctx.GRPC.SetLatency("ValidatePricing", 10.0, "")
	before := len(ctx.GRPC.CallsTo("ValidatePricing", ""))
	mustFail(ctx, with(draft, 2, "", ""), ErrValidationUnavailable, "pricing slower than the deadline")
	ctx.Equal(len(ctx.GRPC.CallsTo("ValidatePricing", "")), before+1, "a deadline is reported to the caller, not retried in place; pricing calls")
	ctx.Equal(publishedVersion(ctx, "p-1"), 1, "a publish that timed out on pricing must leave the pointer; the published version")
}

func CheckRenditionsRequired(ctx *harness.Ctx) {
	media := client(ctx)
	media.missing["p-1/card"] = true
	mustFail(ctx, draft, ErrPublishHeld, "with the card rendition not produced")
	asked := map[string]bool{}
	for _, c := range ctx.GRPC.CallsTo("ValidateRendition", "") {
		asked[c.Request.(*pb.RenditionRequest).GetRendition()] = true
	}
	names := make([]string, 0, len(asked))
	for n := range asked {
		names = append(names, n)
	}
	sort.Strings(names)
	want := append([]string{}, renditions...)
	sort.Strings(want)
	ctx.Equal(names, want, "the media service must be asked for every rendition in renditions; asked")
	ctx.Assert(published(ctx, "p-1") == nil, "a version missing its card rendition went live: %v", published(ctx, "p-1"))
	delete(media.missing, "p-1/card")
	mustMove(ctx, draft, 0, "once every rendition is produced")
	ctx.Equal(publishedVersion(ctx, "p-1"), 1, "the published version")
}

func CheckPricingTerminal(ctx *harness.Ctx) {
	client(ctx)
	mustFail(ctx, bad, ErrPricingRejected, "with a tax class the price list rejects")
	ctx.Equal(len(ctx.GRPC.CallsTo("ValidatePricing", "")), 1, "a rejection is terminal, not retried; the pricing calls for one rejected draft")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a rejection must not be slept on and retried; the sleeps")
	ctx.Assert(published(ctx, "p-1") == nil, "a draft pricing rejected went live: %v", published(ctx, "p-1"))
	ctx.GRPC.SetLatency("ValidatePricing", 10.0, "")
	mustFail(ctx, draft, ErrValidationUnavailable, "with pricing slower than the deadline")
	ctx.GRPC.SetLatency("ValidatePricing", 0, "")
	mustMove(ctx, draft, 0, "a deadline is retryable: once pricing answers again the same draft")
}

func CheckHoldBack(ctx *harness.Ctx) {
	media := client(ctx)
	mustMove(ctx, draft, 0, "a valid draft")
	v2 := with(draft, 2, "Kettle, 2 L", "")
	media.missing["p-1/thumb"] = true
	mustFail(ctx, v2, ErrPublishHeld, "with the thumb rendition of version 2 not produced")
	ctx.Equal(publishedVersion(ctx, "p-1"), 1, "a held version 2 must not move the pointer; the published version")
	delete(media.missing, "p-1/thumb")
	mustFail(ctx, with(v2, 2, "", "none"), ErrPricingRejected, "with version 2 priced in a tax class the price list rejects")
	ctx.Equal(publishedVersion(ctx, "p-1"), 1, "a rejected version 2 must not move the pointer; the published version")
	mustMove(ctx, v2, 1, "the corrected version 2")
	ctx.Equal(publishedVersion(ctx, "p-1"), 2, "the published version")
	ctx.Equal(published(ctx, "p-1")["title"], "Kettle, 2 L", "the published title")
}

func CheckDraftFingerprint(ctx *harness.Ctx) {
	client(ctx)
	mustFail(ctx, bad, ErrPricingRejected, "with a tax class the price list rejects")
	ctx.Equal(len(ctx.GRPC.CallsTo("ValidatePricing", "")), 1, "the first attempt makes one pricing call; the calls")
	mustFail(ctx, bad, ErrPricingRejected, "replaying the rejected draft")
	ctx.Equal(len(ctx.GRPC.CallsTo("ValidatePricing", "")), 1, "a replay of the rejected draft must not call pricing again (the rejection is terminal until the draft changes); the calls")
	lookalike := bad
	lookalike.ProductID = "p-2"
	mustFail(ctx, lookalike, ErrPricingRejected, "with a look-alike draft of another product")
	ctx.Equal(len(ctx.GRPC.CallsTo("ValidatePricing", "")), 2, "a look-alike draft of another product is a different draft: pricing must be asked about it; the calls")
	ctx.Assert(published(ctx, "p-2") == nil, "the look-alike draft of p-2 must not be published")
	fixed := with(bad, 2, "", "standard")
	mustMove(ctx, fixed, 0, "a changed draft of the rejected product")
	ctx.Equal(len(ctx.GRPC.CallsTo("ValidatePricing", "")), 3, "the changed draft must be sent to pricing; the calls")
	ctx.Equal(publishedVersion(ctx, "p-1"), 2, "the published version")
	_ = errors.Is
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace {

const store::Row kDraft{"p-1", 1, "draft", "Kettle", 3499, "standard"};
const store::Row kBad{"p-1", 1, "draft", "Kettle", 3499, "none"};

// Every rendition of every product is ready, except those in missing ("product/rendition").
class MediaPeer final : public catalog::Media::Service {
 public:
  std::set<std::string> missing;
  grpc::Status ValidateRendition(grpc::ServerContext*, const catalog::RenditionRequest* req, catalog::Rendition* out) override {
    if (missing.count(req->product_id() + "/" + req->rendition())) {
      return grpc::Status(grpc::StatusCode::NOT_FOUND, "rendition " + req->rendition() + " of " + req->product_id() + " is not produced");
    }
    out->set_rendition(req->rendition());
    out->set_url("https://img/" + req->product_id() + "/" + std::to_string(req->version()) + "/" + req->rendition() + ".jpg");
    return grpc::Status::OK;
  }
};

// The price list has every tax class but none.
class PricingPeer final : public catalog::Pricing::Service {
 public:
  grpc::Status ValidatePricing(grpc::ServerContext*, const catalog::PricingRequest* req, catalog::PricingVerdict* out) override {
    if (req->tax_class() == "none" || req->price_cents() <= 0) {
      return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "tax class \\"" + req->tax_class() + "\\" is not in the price list");
    }
    out->set_price_list("2026-q4");
    return grpc::Status::OK;
  }
};

struct Peers {
  MediaPeer media;
  PricingPeer pricing;
};

MediaPeer& client(harness::Ctx& ctx) {
  static Peers* peers = nullptr;
  delete peers;
  peers = new Peers;
  ctx.GRPC.Server("")->RegisterService(&peers->media);
  ctx.GRPC.Server("")->RegisterService(&peers->pricing);
  rejected.clear();
  return peers->media;
}

long publishedVersion(const std::string& product_id) {
  const auto s = snapshot::readPublished(product_id);
  return s ? s->value("version", 0L) : 0L;
}

store::Row with(store::Row d, long version, const std::string& title, const std::string& tax_class) {
  d.version = version;
  if (!title.empty()) d.title = title;
  if (!tax_class.empty()) d.tax_class = tax_class;
  return d;
}

void mustMove(harness::Ctx& ctx, const store::Row& d, long expected, const std::string& why) {
  bool moved = false;
  try {
    moved = validateAndPublish(d.product_id, d, expected);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: validateAndPublish threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(moved, true, "%s: the pointer must move; moved", why);
}

template <class E>
void mustThrow(harness::Ctx& ctx, const store::Row& d, const std::string& expected, const std::string& why) {
  bool moved = false;
  try {
    moved = validateAndPublish(d.product_id, d, 0);
  } catch (const E&) {
    return;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: validateAndPublish threw %s: %s, expected %s", why, harness::CurrentExceptionType(), e.what(), expected);
  }
  ctx.Fatalf("%s: validateAndPublish returned %t instead of throwing %s", why, moved, expected);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  mustMove(ctx, kDraft, 0, "with both services healthy");
  for (const std::string method : {"ValidateRendition", "ValidatePricing"}) {
    const auto calls = ctx.GRPC.CallsTo(method);
    ctx.Assert(!calls.empty(), "no %s call was made", method);
    for (const auto& call : calls) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled dependency would hold the publish open", method);
      ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a %s call carries a %v s deadline, expected kDeadline = 5 s", method, call.TimeoutSeconds());
    }
  }
  ctx.GRPC.SetLatency("ValidatePricing", 10.0);
  const size_t before = ctx.GRPC.CallsTo("ValidatePricing").size();
  mustThrow<ValidationUnavailable>(ctx, with(kDraft, 2, "", ""), "ValidationUnavailable", "pricing slower than the deadline");
  ctx.Equal(ctx.GRPC.CallsTo("ValidatePricing").size(), before + 1, "a deadline is reported to the caller, not retried in place; pricing calls");
  ctx.Equal(publishedVersion("p-1"), 1, "a publish that timed out on pricing must leave the pointer; the published version");
}

void CheckRenditionsRequired(harness::Ctx& ctx) {
  MediaPeer& media = client(ctx);
  media.missing.insert("p-1/card");
  mustThrow<PublishHeld>(ctx, kDraft, "PublishHeld", "with the card rendition not produced");
  std::set<std::string> asked;
  for (const auto& c : ctx.GRPC.CallsTo("ValidateRendition")) asked.insert(c.Request<catalog::RenditionRequest>().rendition());
  std::vector<std::string> want(kRenditions.begin(), kRenditions.end());
  std::sort(want.begin(), want.end());
  ctx.Equal(std::vector<std::string>(asked.begin(), asked.end()), want, "the media service must be asked for every rendition in kRenditions; asked");
  ctx.Equal(publishedVersion("p-1"), 0, "a version missing its card rendition went live; the published version");
  media.missing.clear();
  mustMove(ctx, kDraft, 0, "once every rendition is produced");
  ctx.Equal(publishedVersion("p-1"), 1, "the published version");
}

void CheckPricingTerminal(harness::Ctx& ctx) {
  client(ctx);
  mustThrow<PricingRejected>(ctx, kBad, "PricingRejected", "with a tax class the price list rejects");
  ctx.Equal(ctx.GRPC.CallsTo("ValidatePricing").size(), 1, "a rejection is terminal, not retried; the pricing calls for one rejected draft");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a rejection must not be slept on and retried; the sleeps");
  ctx.Equal(publishedVersion("p-1"), 0, "a draft pricing rejected went live; the published version");
  ctx.GRPC.SetLatency("ValidatePricing", 10.0);
  mustThrow<ValidationUnavailable>(ctx, kDraft, "ValidationUnavailable", "with pricing slower than the deadline");
  ctx.GRPC.SetLatency("ValidatePricing", 0);
  mustMove(ctx, kDraft, 0, "a deadline is retryable: once pricing answers again the same draft");
}

void CheckHoldBack(harness::Ctx& ctx) {
  MediaPeer& media = client(ctx);
  mustMove(ctx, kDraft, 0, "a valid draft");
  const store::Row v2 = with(kDraft, 2, "Kettle, 2 L", "");
  media.missing.insert("p-1/thumb");
  mustThrow<PublishHeld>(ctx, v2, "PublishHeld", "with the thumb rendition of version 2 not produced");
  ctx.Equal(publishedVersion("p-1"), 1, "a held version 2 must not move the pointer; the published version");
  media.missing.clear();
  mustThrow<PricingRejected>(ctx, with(v2, 2, "", "none"), "PricingRejected", "with version 2 priced in a tax class the price list rejects");
  ctx.Equal(publishedVersion("p-1"), 1, "a rejected version 2 must not move the pointer; the published version");
  mustMove(ctx, v2, 1, "the corrected version 2");
  ctx.Equal(publishedVersion("p-1"), 2, "the published version");
  ctx.Equal(snapshot::readPublished("p-1")->value("title", ""), "Kettle, 2 L", "the published title");
}

void CheckDraftFingerprint(harness::Ctx& ctx) {
  client(ctx);
  mustThrow<PricingRejected>(ctx, kBad, "PricingRejected", "with a tax class the price list rejects");
  ctx.Equal(ctx.GRPC.CallsTo("ValidatePricing").size(), 1, "the first attempt makes one pricing call; the calls");
  mustThrow<PricingRejected>(ctx, kBad, "PricingRejected", "replaying the rejected draft");
  ctx.Equal(ctx.GRPC.CallsTo("ValidatePricing").size(), 1, "a replay of the rejected draft must not call pricing again (the rejection is terminal until the draft changes); the calls");
  store::Row lookalike = kBad;
  lookalike.product_id = "p-2";
  mustThrow<PricingRejected>(ctx, lookalike, "PricingRejected", "with a look-alike draft of another product");
  ctx.Equal(ctx.GRPC.CallsTo("ValidatePricing").size(), 2, "a look-alike draft of another product is a different draft: pricing must be asked about it; the calls");
  ctx.Equal(publishedVersion("p-2"), 0, "the look-alike draft of p-2 must not be published; its published version");
  const store::Row fixed = with(kBad, 2, "", "standard");
  mustMove(ctx, fixed, 0, "a changed draft of the rejected product");
  ctx.Equal(ctx.GRPC.CallsTo("ValidatePricing").size(), 3, "the changed draft must be sent to pricing; the calls");
  ctx.Equal(publishedVersion("p-1"), 2, "the published version");
}
`,
  },
  hints: [
    'Take the card rendition away and publish: the product goes live without it. Price a draft in a tax class the list refuses: pricing is called five times and the pointer moves.',
    'The rendition loop stops at the first success and swallows failures; the pricing loop treats a rejection and a timeout alike, as something to sleep on. Nothing stops the swap afterwards.',
    'Loop over all RENDITIONS with `timeout=DEADLINE_S`, NOT_FOUND → `PublishHeld`. One pricing call: FAILED_PRECONDITION → store `rejected[product_id] = draft_fingerprint(...)`, raise `PricingRejected`; anything else → `ValidationUnavailable`. Swap last.',
  ],
  debrief: `The status code is the contract: the pricing service already told the caller whether the draft is wrong (FAILED_PRECONDITION) or the call was unlucky (DEADLINE_EXCEEDED), so the client's only job is to keep those two apart. A rejection is remembered under the product and the draft's fingerprint, which is why a look-alike draft of another product still gets its own call and a corrected draft of the same product clears the memory. Running both validations before the swap is what lets a failure cost nothing: the storefront keeps the version it had. Production catalogs persist the rejection with the draft row so every replica refuses the replay, run the rendition checks in parallel under one deadline, and let the media service push "rendition ready" events instead of being polled per publish.`,
};
