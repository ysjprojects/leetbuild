import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Vision model calls with a deterministic fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['ingest', 'vision', 'objects', 'indexer'],
  task: `## Task

**Starting point.** The starter's \`caption_asset(channel, asset_id, mime)\` calls the vision
service's \`Caption\` with no deadline, catches every exception, substitutes the caption
\`"an image"\` and returns \`embedding_kind: "text_image"\` either way. It serves the demo and hides
five flaws.

**Failure mode the checks target.** A stalled vision service holds an ingest worker for as long as
the socket lives; a single \`except\` turns a content-policy refusal into a retry that cannot
succeed; an outage is indexed as if the image had been captioned; the placeholder matches every
query that contains "image"; and nothing marks the asset for a backfill, so recovery has no list
to work from.

The vision client ingest uses when the request carried no caption:

- \`Caption\` is called with a **3-second deadline** (\`VISION_DEADLINE_S\` / \`VISION_DEADLINE_MS\` /
  \`visionDeadline\`), passed as the gRPC deadline.
- \`PERMISSION_DENIED\` is a decision, not a failure: raise \`ContentPolicyError\`
  (\`POLICY_REJECTED\`) so the asset fails with a reason and no retry.
- \`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` are the outage: index with **text-only** embeddings
  (\`text_only\`) and \`caption: null\` instead of blocking or retrying.
- Mark the degraded result with \`degraded: true\` and \`caption_source: "unsupported"\` (vs
  \`"generated"\`), so a backfill can find every asset to caption later.
- The literal caption **"an image"** does not enter the index on any path.`,
  sequence: {
    participants: ['Ingest API', 'Vision service', 'Indexer'],
    messages: [
      {from: 'Ingest API', to: 'Vision service', label: 'Caption(asset_id, mime) · deadline 3 s', kind: 'sync'},
      {from: 'Vision service', to: 'Ingest API', label: 'CaptionReply{caption}', kind: 'reply'},
      {from: 'Vision service', to: 'Ingest API', label: 'DEADLINE_EXCEEDED · PERMISSION_DENIED', kind: 'reply'},
      {from: 'Ingest API', to: 'Ingest API', label: 'caption: null · degraded: true · text_only', kind: 'sync'},
      {from: 'Ingest API', to: 'Indexer', label: 'upsert text vectors only', kind: 'sync'},
      {from: 'Indexer', to: 'Ingest API', label: 'embedding ids', kind: 'reply'},
    ],
  },
  hints: [
    'After a vision outage one tenant\'s search returns the same uncaptioned screenshots for every query containing "image", and an asset moderation refused is searchable. No alert fired; the index just got worse.',
    "The starter's `except Exception` is the whole failure policy: a hung call has no deadline to end it, and `PERMISSION_DENIED`, `DEADLINE_EXCEEDED` and `UNAVAILABLE` all become the same placeholder caption.",
    'Pass `timeout=VISION_DEADLINE_S` (3) on the call; map `PERMISSION_DENIED` to `ContentPolicyError`, `DEADLINE_EXCEEDED`/`UNAVAILABLE` to `caption = None`, `EMBEDDING_TEXT_ONLY`, `degraded: True`, `caption_source: "unsupported"`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Calls Caption with a 3-second deadline',
      detail:
        'The client sets `VISION_DEADLINE_S = 3` / `VISION_DEADLINE_MS = 3000` (`visionDeadline`, `VisionDeadline`, `kVisionDeadlineMs`) and passes it as the gRPC deadline. The starter calls without one, so a stalled vision service stalls ingest.',
      match: {
        python: {all: [/VISION_DEADLINE_S\s*=\s*3/, /timeout=VISION_DEADLINE_S/]},
        typescript: {all: [/VISION_DEADLINE_MS\s*=\s*3000/, /deadline:/]},
        go: {all: [/visionDeadline\s*=\s*3 \* time\.Second/, /context\.WithTimeout/]},
        scala: {all: [/VisionDeadline\s*=\s*3/, /withDeadlineAfter/]},
        cpp: {all: [/kVisionDeadlineMs\s*=\s*3000/, /set_deadline/]},
      },
    },
    {
      id: 'policy',
      title: 'A policy rejection fails the asset with a reason',
      detail:
        '`PERMISSION_DENIED` is mapped to `ContentPolicyError` / `ErrContentPolicy` carrying `POLICY_REJECTED`, and the call is not retried. The starter treats a moderation decision as a transient error and falls back to indexing the asset anyway.',
      match: {
        python: {all: [/ContentPolicyError/, /POLICY_REJECTED/], none: [/except Exception/]},
        typescript: {all: [/ContentPolicyError/, /grpc\.status\.PERMISSION_DENIED/]},
        go: {all: [/ErrContentPolicy/, /policyRejected/]},
        scala: {all: [/ContentPolicyError/, /PolicyRejected/]},
        cpp: {all: [/ContentPolicyError/, /kPolicyRejected/]},
      },
    },
    {
      id: 'timeout-fallback',
      title: 'A timeout degrades to text-only indexing',
      detail:
        '`DEADLINE_EXCEEDED` (and `UNAVAILABLE`) falls back to text-only embeddings (`text_only` / `textOnly` / `TextOnly` / `kTextOnly`) instead of blocking, retrying forever or failing the whole upload.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /EMBEDDING_TEXT_ONLY/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /EMBEDDING_TEXT_ONLY/]},
        go: {all: [/codes\.DeadlineExceeded/, /textOnly/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /TextOnly/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /kTextOnly/]},
      },
    },
    {
      id: 'no-placeholder',
      title: 'No placeholder caption ever reaches the index',
      detail:
        'The fallback path carries `caption: null` (`None` / `nil` / `std::nullopt`), so no asset is indexed with the literal string `an image`. The starter invents that caption and search cannot tell it from a real one.',
      match: {
        python: {all: [/caption = None/], none: [/an image/]},
        typescript: {all: [/caption: null/], none: [/an image/]},
        go: {all: [/Caption: nil/], none: [/an image/]},
        scala: {all: [/caption = None/], none: [/an image/]},
        cpp: {all: [/caption = std::nullopt/], none: [/an image/]},
      },
    },
    {
      id: 'degraded-flag',
      title: 'The degraded result is visible downstream',
      detail:
        'The record carries `degraded` and where the caption came from (`caption_source` / `CaptionSource`), so an operator can count degraded assets and a backfill can find them once the vision service recovers.',
      match: {
        python: {all: [/degraded/, /caption_source/]},
        typescript: {all: [/degraded/, /caption_source/]},
        go: {all: [/Degraded/, /CaptionSource/]},
        scala: {all: [/degraded/, /captionSource/]},
        cpp: {all: [/degraded/, /caption_source/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""client.py — the vision client ingest calls when the request carried no caption."""

import grpc

import vision_pb2
import vision_pb2_grpc


def caption_asset(channel: grpc.Channel, asset_id: str, mime: str) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    stub = vision_pb2_grpc.VisionStub(channel)
    request = vision_pb2.CaptionRequest(asset_id=asset_id, mime=mime)
    try:
        reply = stub.Caption(request)
        caption = reply.caption
    except Exception:
        caption = "an image"
    return {"caption": caption, "embedding_kind": "text_image"}
`,
      solution: `"""client.py — the vision client ingest calls when the request carried no caption."""

import grpc

import vision_pb2
import vision_pb2_grpc

VISION_DEADLINE_S = 3.0
EMBEDDING_TEXT_ONLY = "text_only"
EMBEDDING_TEXT_IMAGE = "text_image"
POLICY_REJECTED = "POLICY_REJECTED"


class ContentPolicyError(Exception):
    """The vision service refused to caption this asset under its content policy."""


def caption_asset(channel: grpc.Channel, asset_id: str, mime: str) -> dict:
    """The captioning outcome for one asset: a generated caption, or a degraded text-only record."""
    stub = vision_pb2_grpc.VisionStub(channel)
    request = vision_pb2.CaptionRequest(asset_id=asset_id, mime=mime)
    try:
        reply = stub.Caption(request, timeout=VISION_DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.PERMISSION_DENIED:
            raise ContentPolicyError(POLICY_REJECTED) from exc
        if exc.code() in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE):
            caption = None
            return {
                "caption": caption,
                "embedding_kind": EMBEDDING_TEXT_ONLY,
                "caption_source": "unsupported",
                "degraded": True,
            }
        raise
    return {
        "caption": reply.caption,
        "embedding_kind": EMBEDDING_TEXT_IMAGE,
        "caption_source": "generated",
        "degraded": False,
    }


def index_asset(index, asset_id: str, captioning: dict) -> dict:
    """Upsert whatever the client returned: text and image vectors, or text only when degraded."""
    return index.upsert(
        {
            "asset_id": asset_id,
            "caption": captioning["caption"],
            "embedding_kind": captioning["embedding_kind"],
            "degraded": captioning["degraded"],
        }
    )
`,
    },
    typescript: {
      starter: `/** client.ts — the vision client ingest calls when the request carried no caption. */
import {visionClient} from './vision_client';

interface Captioning {
  caption: string;
  embedding_kind: string;
}

export async function captionAsset(assetId: string, mime: string): Promise<Captioning> {
  try {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const reply = await visionClient.Caption({asset_id: assetId, mime});
    return {caption: reply.caption, embedding_kind: 'text_image'};
  } catch {
    return {caption: 'an image', embedding_kind: 'text_image'};
  }
}
`,
      solution: `/** client.ts — the vision client ingest calls when the request carried no caption. */
import * as grpc from '@grpc/grpc-js';

import {visionClient} from './vision_client';

export const VISION_DEADLINE_MS = 3000;
export const EMBEDDING_TEXT_ONLY = 'text_only';
export const EMBEDDING_TEXT_IMAGE = 'text_image';
export const POLICY_REJECTED = 'POLICY_REJECTED';

export class ContentPolicyError extends Error {}

interface Captioning {
  caption: string | null;
  embedding_kind: string;
  caption_source: string;
  degraded: boolean;
}

export async function captionAsset(assetId: string, mime: string): Promise<Captioning> {
  try {
    const reply = await visionClient.Caption({asset_id: assetId, mime}, {deadline: Date.now() + VISION_DEADLINE_MS});
    return {
      caption: reply.caption,
      embedding_kind: EMBEDDING_TEXT_IMAGE,
      caption_source: 'generated',
      degraded: false,
    };
  } catch (err) {
    const code = (err as grpc.ServiceError).code;
    if (code === grpc.status.PERMISSION_DENIED) throw new ContentPolicyError(POLICY_REJECTED);
    if (code === grpc.status.DEADLINE_EXCEEDED || code === grpc.status.UNAVAILABLE) {
      return {
        caption: null,
        embedding_kind: EMBEDDING_TEXT_ONLY,
        caption_source: 'unsupported',
        degraded: true,
      };
    }
    throw err;
  }
}

export async function indexAsset(index: {upsert: (record: unknown) => Promise<unknown>}, assetId: string, captioning: Captioning) {
  return index.upsert({
    asset_id: assetId,
    caption: captioning.caption,
    embedding_kind: captioning.embedding_kind,
    degraded: captioning.degraded,
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	visionpb "ingest/visionpb"
)

type Captioning struct {
	Caption       string \`json:"caption"\`
	EmbeddingKind string \`json:"embedding_kind"\`
}

func CaptionAsset(ctx context.Context, client visionpb.VisionClient, assetID, mime string) Captioning {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	reply, err := client.Caption(ctx, &visionpb.CaptionRequest{AssetId: assetID, Mime: mime})
	if err != nil {
		return Captioning{Caption: "an image", EmbeddingKind: "text_image"}
	}
	return Captioning{Caption: reply.Caption, EmbeddingKind: "text_image"}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	visionpb "ingest/visionpb"
)

const (
	visionDeadline = 3 * time.Second
	textOnly       = "text_only"
	textImage      = "text_image"
	policyRejected = "POLICY_REJECTED"
)

// ErrContentPolicy is the vision service refusing an asset under its content policy: not retryable.
var ErrContentPolicy = errors.New("vision: content policy rejected the asset")

type Captioning struct {
	Caption       *string \`json:"caption"\`
	EmbeddingKind string  \`json:"embedding_kind"\`
	CaptionSource string  \`json:"caption_source"\`
	Degraded      bool    \`json:"degraded"\`
}

func CaptionAsset(ctx context.Context, client visionpb.VisionClient, assetID, mime string) (Captioning, error) {
	ctx, cancel := context.WithTimeout(ctx, visionDeadline)
	defer cancel()
	reply, err := client.Caption(ctx, &visionpb.CaptionRequest{AssetId: assetID, Mime: mime})
	if err != nil {
		switch status.Code(err) {
		case codes.PermissionDenied:
			return Captioning{}, fmt.Errorf("%w: %s", ErrContentPolicy, policyRejected)
		case codes.DeadlineExceeded, codes.Unavailable:
			return Captioning{Caption: nil, EmbeddingKind: textOnly, CaptionSource: "unsupported", Degraded: true}, nil
		default:
			return Captioning{}, err
		}
	}
	caption := reply.Caption
	return Captioning{Caption: &caption, EmbeddingKind: textImage, CaptionSource: "generated", Degraded: false}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannel

final case class Captioning(caption: Option[String], embeddingKind: String)

object Client {
  def captionAsset(channel: ManagedChannel, assetId: String, mime: String): Captioning = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    try {
      val reply = VisionGrpc.blockingStub(channel).caption(CaptionRequest(assetId, mime))
      Captioning(Some(reply.caption), "text_image")
    } catch {
      case _: Throwable => Captioning(Some("an image"), "text_image")
    }
  }
}
`,
      solution: `import io.grpc.{ManagedChannel, Status, StatusRuntimeException}

import java.util.concurrent.TimeUnit

final case class Captioning(caption: Option[String], embeddingKind: String, captionSource: String, degraded: Boolean)

object Client {
  val VisionDeadline = 3
  val TextOnly = "text_only"
  val TextImage = "text_image"
  val PolicyRejected = "POLICY_REJECTED"

  final class ContentPolicyError(reason: String) extends RuntimeException(reason)

  def captionAsset(channel: ManagedChannel, assetId: String, mime: String): Captioning = {
    try {
      val reply = VisionGrpc
        .blockingStub(channel)
        .withDeadlineAfter(VisionDeadline, TimeUnit.SECONDS)
        .caption(CaptionRequest(assetId, mime))
      Captioning(Some(reply.caption), TextImage, "generated", degraded = false)
    } catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.PERMISSION_DENIED =>
        throw new ContentPolicyError(PolicyRejected)
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        val caption = None
        Captioning(caption, TextOnly, "unsupported", degraded = true)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

struct Captioning {
  std::string caption;
  std::string embedding_kind;
};

Captioning caption_asset(const std::string& asset_id, const std::string& mime) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  vision::CaptionRequest request;
  request.set_asset_id(asset_id);
  request.set_mime(mime);
  vision::CaptionReply reply;
  grpc::ClientContext ctx;
  const grpc::Status status = vision_stub().Caption(&ctx, request, &reply);
  if (!status.ok()) return Captioning{"an image", "text_image"};
  return Captioning{reply.caption(), "text_image"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>

constexpr int kVisionDeadlineMs = 3000;
const std::string kTextOnly = "text_only";
const std::string kTextImage = "text_image";
const std::string kPolicyRejected = "POLICY_REJECTED";

class ContentPolicyError : public std::runtime_error {
 public:
  explicit ContentPolicyError(const std::string& reason) : std::runtime_error(reason) {}
};

struct Captioning {
  std::optional<std::string> caption;
  std::string embedding_kind;
  std::string caption_source;
  bool degraded = false;
};

// The captioning outcome for one asset: a generated caption, or a degraded text-only record.
Captioning caption_asset(const std::string& asset_id, const std::string& mime) {
  vision::CaptionRequest request;
  request.set_asset_id(asset_id);
  request.set_mime(mime);
  vision::CaptionReply reply;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kVisionDeadlineMs));
  const grpc::Status status = vision_stub().Caption(&ctx, request, &reply);
  if (status.ok()) return Captioning{reply.caption(), kTextImage, "generated", false};
  if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) throw ContentPolicyError(kPolicyRejected);
  if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ||
      status.error_code() == grpc::StatusCode::UNAVAILABLE) {
    const std::optional<std::string> caption = std::nullopt;
    return Captioning{caption, kTextOnly, "unsupported", true};
  }
  throw std::runtime_error(status.error_message());
}
`,
    },
  },
  debrief: `A vision call has three outcomes, not two: success, an outage the pipeline can absorb, and a
refusal it must not absorb. The starter collapses them into one \`except\`, so a moderation decision
is indexed and a request that cannot succeed is retried. The placeholder is the failure that does
not look like one: nothing crashes, no alert fires, and the index fills with a caption that matches
every query with the word "image". A null caption plus a degraded flag makes recovery possible,
because a nightly job can list \`caption_source: "unsupported"\` assets and re-caption them once
the service is healthy. Production clients put a circuit breaker in front of the vision service so
an outage stops costing 3 seconds per asset.`,
};
