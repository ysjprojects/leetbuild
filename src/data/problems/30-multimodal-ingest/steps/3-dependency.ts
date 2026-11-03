import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Vision captions under a deadline, degraded when they fail',
  concept: 'grpc',
  file: 'client',
  focus: ['ingest', 'vision', 'objects', 'redis'],
  task: `## Task

**Starting point.** The starter's \`caption_asset(asset)\` is the vision client the pipeline runs on
a registered asset. It keeps the uploader's caption when there is one (\`caption_source: "user"\`);
otherwise it calls the vision service's \`Caption\` over gRPC up to three times, sleeping a second
after each failure, and falls back to the caption \`"an image"\`. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A stalled vision service holds an ingest worker as long as the
connection lives; an image the content policy refuses is retried and then indexed with an invented
caption; an outage fills the index with "an image", which matches every query about an image; and
nothing records which assets went without a caption, so recovery has no list to work from.

\`\`\`proto
service Vision { rpc Caption(CaptionRequest) returns (CaptionReply); }  // PERMISSION_DENIED: refused by policy
\`\`\`

- Every \`Caption\` call carries a 3-second deadline: \`VISION_DEADLINE_S\` = 3 (\`VISION_DEADLINE_MS\`,
  \`visionDeadline\`, \`VisionDeadlineSeconds\`, \`kVisionDeadline\`).
- \`PERMISSION_DENIED\` raises \`ContentPolicyError\` (Go: \`ErrContentPolicy\`) after one call.
- Any other failure, a deadline or \`UNAVAILABLE\`, answers at once with caption null,
  \`caption_source: "none"\` and \`degraded: true\`: the image is indexed without a caption.
- A degraded asset goes into the backfill set: \`assets.queue_backfill(asset_id)\`.`,
  sequence: {
    participants: ['Ingest pipeline', 'Vision service', 'Redis'],
    messages: [
      {
        from: 'Ingest pipeline',
        to: 'Vision service',
        label: 'Caption(asset_id, checksum, mime) · deadline 3 s',
        kind: 'sync',
      },
      {
        from: 'Vision service',
        to: 'Ingest pipeline',
        label: 'CaptionReply{caption} → caption_source vision',
        kind: 'reply',
      },
      {from: 'Vision service', to: 'Ingest pipeline', label: 'PERMISSION_DENIED → ContentPolicyError', kind: 'reply'},
      {
        from: 'Vision service',
        to: 'Ingest pipeline',
        label: 'DEADLINE_EXCEEDED · UNAVAILABLE → caption null, degraded',
        kind: 'reply',
      },
      {from: 'Ingest pipeline', to: 'Redis', label: 'SADD ingest:backfill a-7', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'user-caption',
      title: "Keeps the uploader's caption and asks vision otherwise",
      detail:
        'An asset with a caption is answered with it (`caption_source: "user"`) without a call; an asset without one is captioned by `Caption` (`caption_source: "vision"`).',
      match: {
        python: {all: [/["']user["']/, /\.Caption\(/]},
        typescript: {all: [/['"]user['"]/, /\.Caption\(/]},
        go: {all: [/"user"/, /\.Caption\(/]},
        scala: {all: [/"user"/, /\.caption\(/]},
        cpp: {all: [/"user"/, /->Caption\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every Caption call carries a 3-second deadline',
      detail:
        'The call is made with `VISION_DEADLINE_S` (3 s) as its gRPC deadline; the starter sets none, so a stalled vision service holds the ingest worker indefinitely.',
      match: {
        python: {all: [/VISION_DEADLINE_S\s*=\s*3\b/, /Caption\([^)]*\)?[^\n]*timeout\s*=\s*VISION_DEADLINE_S/]},
        typescript: {all: [/VISION_DEADLINE_MS\s*=\s*3000\b/, /deadline:[^\n]*VISION_DEADLINE_MS/]},
        go: {all: [/visionDeadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*visionDeadline\s*\)/]},
        scala: {all: [/VisionDeadlineSeconds\s*=\s*3L?\b/, /withDeadlineAfter\(\s*VisionDeadlineSeconds/]},
        cpp: {all: [/kVisionDeadline\{3\}/, /set_deadline\([^\n]*kVisionDeadline\)/]},
      },
    },
    {
      id: 'policy-terminal',
      title: 'A content-policy refusal fails the asset after one call',
      detail:
        '`PERMISSION_DENIED` raises `ContentPolicyError` (`ErrContentPolicy`) without a retry or a sleep; the starter retries it like any error and then invents a caption.',
      match: {
        python: {all: [/PERMISSION_DENIED/, /raise ContentPolicyError/], none: [/time\.sleep\(/, /for \w+ in range/]},
        typescript: {
          all: [/PERMISSION_DENIED/, /throw new ContentPolicyError/],
          none: [/setTimeout\(/, /for \(let attempt/],
        },
        go: {all: [/codes\.PermissionDenied/, /%w[^\n]*ErrContentPolicy/], none: [/time\.Sleep\(/, /for attempt :=/]},
        scala: {all: [/PERMISSION_DENIED/, /throw new ContentPolicyError/], none: [/Thread\.sleep\(/, /\(1 to /]},
        cpp: {all: [/PERMISSION_DENIED/, /throw ContentPolicyError/], none: [/sleep_for\(/, /for \(int attempt/]},
      },
    },
    {
      id: 'text-only-fallback',
      title: 'An outage indexes no caption, marked degraded',
      detail:
        'A deadline or `UNAVAILABLE` answers caption null, `caption_source: "none"`, `degraded: true`; the starter indexes the placeholder "an image", which matches every query about an image.',
      match: {
        python: {all: [/["']none["']/, /["']degraded["']\s*:\s*True/], none: [/an image/]},
        typescript: {all: [/['"]none['"]/, /degraded:\s*true/], none: [/an image/]},
        go: {all: [/"none"/, /Degraded:\s*true/], none: [/an image/]},
        scala: {all: [/"none"/, /degraded\s*=\s*true/], none: [/an image/]},
        cpp: {all: [/"none"/, /\btrue\}/], none: [/an image/]},
      },
    },
    {
      id: 'backfill',
      title: 'Queues every degraded asset for the caption backfill',
      detail:
        'An asset indexed without a caption is added to `ingest:backfill` with `queue_backfill`/`queueBackfill`; the starter records nothing, so after an outage nothing finds the assets to caption.',
      match: {
        python: {all: [/assets\.queue_backfill\(/]},
        typescript: {all: [/queueBackfill\(/]},
        go: {all: [/assets\.QueueBackfill\(/]},
        scala: {all: [/Assets\.queueBackfill\(/]},
        cpp: {all: [/assets::queueBackfill\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import vision_pb2
import vision_pb2_grpc
from ingest import assets  # assets.queue_backfill(asset_id)

VISION_ATTEMPTS = 3

vision = vision_pb2_grpc.VisionStub(grpc.insecure_channel("vision:9000"))


class ContentPolicyError(Exception):
    """The vision service refused the image under the content policy: the asset fails, with the reason."""


def caption_asset(asset: dict) -> dict:
    """The caption ingest indexes for the asset: {"caption", "caption_source": user | vision | none, "degraded"}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if asset["caption"]:
        return {"caption": asset["caption"], "caption_source": "user", "degraded": False}
    request = vision_pb2.CaptionRequest(asset_id=asset["asset_id"], tenant=asset["tenant"], checksum=asset["checksum"], mime=asset["mime"])
    for attempt in range(VISION_ATTEMPTS):
        try:
            reply = vision.Caption(request)
            return {"caption": reply.caption, "caption_source": "vision", "degraded": False}
        except grpc.RpcError:
            time.sleep(1.0)  # the vision service is flaky: try again
    return {"caption": "an image", "caption_source": "vision", "degraded": False}
`,
      solution: `import grpc

import vision_pb2
import vision_pb2_grpc
from ingest import assets  # assets.queue_backfill(asset_id)

VISION_DEADLINE_S = 3

vision = vision_pb2_grpc.VisionStub(grpc.insecure_channel("vision:9000"))


class ContentPolicyError(Exception):
    """The vision service refused the image under the content policy: the asset fails, with the reason."""


def caption_asset(asset: dict) -> dict:
    """The caption ingest indexes for the asset: {"caption", "caption_source": user | vision | none, "degraded"}."""
    if asset["caption"]:
        return {"caption": asset["caption"], "caption_source": "user", "degraded": False}
    request = vision_pb2.CaptionRequest(asset_id=asset["asset_id"], tenant=asset["tenant"], checksum=asset["checksum"], mime=asset["mime"])
    try:
        reply = vision.Caption(request, timeout=VISION_DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.PERMISSION_DENIED:
            # A verdict about the image: no retry can change it.
            raise ContentPolicyError(exc.details()) from exc
        # A deadline or an outage says nothing about the image: index it without a caption now, caption it later.
        assets.queue_backfill(asset["asset_id"])
        return {"caption": None, "caption_source": "none", "degraded": True}
    return {"caption": reply.caption, "caption_source": "vision", "degraded": False}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Asset, type Captioned, queueBackfill} from 'ingest/assets';

export const VISION_ATTEMPTS = 3;

interface CaptionRequest {
  asset_id: string;
  tenant: string;
  checksum: string;
  mime: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('vision.proto')) as unknown as {
  ingest: {Vision: grpc.ServiceClientConstructor};
};
const vision = new pkg.ingest.Vision('vision:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Caption(request: CaptionRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{caption: string; model: string}>;
};

/** The vision service refused the image under the content policy: the asset fails, with the reason. */
export class ContentPolicyError extends Error {}

/** The caption ingest indexes for the asset. */
export async function captionAsset(asset: Asset): Promise<Captioned> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (asset.caption) return {caption: asset.caption, caption_source: 'user', degraded: false};
  const request = {asset_id: asset.asset_id, tenant: asset.tenant, checksum: asset.checksum, mime: asset.mime};
  for (let attempt = 0; attempt < VISION_ATTEMPTS; attempt++) {
    try {
      const reply = await vision.Caption(request, new grpc.Metadata(), {});
      return {caption: reply.caption, caption_source: 'vision', degraded: false};
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000)); // the vision service is flaky: try again
    }
  }
  return {caption: 'an image', caption_source: 'vision', degraded: false};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Asset, type Captioned, queueBackfill} from 'ingest/assets';

export const VISION_DEADLINE_MS = 3000;

interface CaptionRequest {
  asset_id: string;
  tenant: string;
  checksum: string;
  mime: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('vision.proto')) as unknown as {
  ingest: {Vision: grpc.ServiceClientConstructor};
};
const vision = new pkg.ingest.Vision('vision:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Caption(request: CaptionRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{caption: string; model: string}>;
};

/** The vision service refused the image under the content policy: the asset fails, with the reason. */
export class ContentPolicyError extends Error {}

/** The caption ingest indexes for the asset. */
export async function captionAsset(asset: Asset): Promise<Captioned> {
  if (asset.caption) return {caption: asset.caption, caption_source: 'user', degraded: false};
  const request = {asset_id: asset.asset_id, tenant: asset.tenant, checksum: asset.checksum, mime: asset.mime};
  try {
    const reply = await vision.Caption(request, new grpc.Metadata(), {deadline: Date.now() + VISION_DEADLINE_MS});
    return {caption: reply.caption, caption_source: 'vision', degraded: false};
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    // A verdict about the image: no retry can change it.
    if (code === grpc.status.PERMISSION_DENIED) throw new ContentPolicyError(details);
    // A deadline or an outage says nothing about the image: index it without a caption now, caption it later.
    await queueBackfill(asset.asset_id);
    return {caption: null, caption_source: 'none', degraded: true};
  }
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

	"ingest/assets" // assets.Asset, assets.Captioned, assets.QueueBackfill(ctx, assetID)
	pb "ingest/gen/vision"
)

const visionAttempts = 3

var (
	visionConn, _ = grpc.NewClient("vision:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	vision        = pb.NewVisionClient(visionConn)
)

// ErrContentPolicy: the vision service refused the image under the content policy; the asset fails, with the reason.
var ErrContentPolicy = errors.New("refused by the content policy")

// captionAsset is the caption ingest indexes for the asset.
func captionAsset(ctx context.Context, a assets.Asset) (assets.Captioned, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if a.Caption != "" {
		return assets.Captioned{Caption: a.Caption, Source: "user"}, nil
	}
	req := &pb.CaptionRequest{AssetId: a.AssetID, Tenant: a.Tenant, Checksum: a.Checksum, Mime: a.Mime}
	for attempt := 0; attempt < visionAttempts; attempt++ {
		reply, err := vision.Caption(ctx, req)
		if err == nil {
			return assets.Captioned{Caption: reply.GetCaption(), Source: "vision"}, nil
		}
		time.Sleep(time.Second) // the vision service is flaky: try again
	}
	return assets.Captioned{Caption: "an image", Source: "vision"}, nil
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

	"ingest/assets" // assets.Asset, assets.Captioned, assets.QueueBackfill(ctx, assetID)
	pb "ingest/gen/vision"
)

const visionDeadline = 3 * time.Second

var (
	visionConn, _ = grpc.NewClient("vision:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	vision        = pb.NewVisionClient(visionConn)
)

// ErrContentPolicy: the vision service refused the image under the content policy; the asset fails, with the reason.
var ErrContentPolicy = errors.New("refused by the content policy")

// captionAsset is the caption ingest indexes for the asset.
func captionAsset(ctx context.Context, a assets.Asset) (assets.Captioned, error) {
	if a.Caption != "" {
		return assets.Captioned{Caption: a.Caption, Source: "user"}, nil
	}
	req := &pb.CaptionRequest{AssetId: a.AssetID, Tenant: a.Tenant, Checksum: a.Checksum, Mime: a.Mime}
	callCtx, cancel := context.WithTimeout(ctx, visionDeadline)
	defer cancel()
	reply, err := vision.Caption(callCtx, req)
	if err == nil {
		return assets.Captioned{Caption: reply.GetCaption(), Source: "vision"}, nil
	}
	if status.Code(err) == codes.PermissionDenied {
		// A verdict about the image: no retry can change it.
		return assets.Captioned{}, fmt.Errorf("%w: %s", ErrContentPolicy, status.Convert(err).Message())
	}
	// A deadline or an outage says nothing about the image: index it without a caption now, caption it later.
	if err := assets.QueueBackfill(ctx, a.AssetID); err != nil {
		return assets.Captioned{}, err
	}
	return assets.Captioned{Source: "none", Degraded: true}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import ingest.Assets // Assets.Asset, Assets.Captioned, Assets.queueBackfill(assetId)
import ingest.vision.{CaptionRequest, VisionGrpc}

/** The vision service refused the image under the content policy: the asset fails, with the reason. */
final class ContentPolicyError(message: String) extends Exception(message)

object Captioner {
  val VisionAttempts = 3

  private val vision = VisionGrpc.blockingStub(ManagedChannelBuilder.forAddress("vision", 9000).usePlaintext().build())

  /** The caption ingest indexes for the asset. */
  def captionAsset(asset: Assets.Asset): Assets.Captioned = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    asset.caption match {
      case Some(caption) => Assets.Captioned(Some(caption), "user", degraded = false)
      case None =>
        val request = CaptionRequest(asset.assetId, asset.tenant, asset.checksum, asset.mime)
        (1 to VisionAttempts).iterator
          .map { _ =>
            try Some(vision.caption(request))
            catch {
              case _: StatusRuntimeException =>
                Thread.sleep(1000) // the vision service is flaky: try again
                None
            }
          }
          .collectFirst { case Some(reply) => Assets.Captioned(Some(reply.caption), "vision", degraded = false) }
          .getOrElse(Assets.Captioned(Some("an image"), "vision", degraded = false))
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import ingest.Assets // Assets.Asset, Assets.Captioned, Assets.queueBackfill(assetId)
import ingest.vision.{CaptionRequest, VisionGrpc}

/** The vision service refused the image under the content policy: the asset fails, with the reason. */
final class ContentPolicyError(message: String) extends Exception(message)

object Captioner {
  val VisionDeadlineSeconds = 3L

  private val vision = VisionGrpc.blockingStub(ManagedChannelBuilder.forAddress("vision", 9000).usePlaintext().build())

  /** The caption ingest indexes for the asset. */
  def captionAsset(asset: Assets.Asset): Assets.Captioned = asset.caption match {
    case Some(caption) => Assets.Captioned(Some(caption), "user", degraded = false)
    case None =>
      val request = CaptionRequest(asset.assetId, asset.tenant, asset.checksum, asset.mime)
      try {
        val reply = vision.withDeadlineAfter(VisionDeadlineSeconds, TimeUnit.SECONDS).caption(request)
        Assets.Captioned(Some(reply.caption), "vision", degraded = false)
      } catch {
        // A verdict about the image: no retry can change it.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.PERMISSION_DENIED =>
          throw new ContentPolicyError(Option(e.getStatus.getDescription).getOrElse("refused by the content policy"))
        // A deadline or an outage says nothing about the image: index it without a caption now, caption it later.
        case _: StatusRuntimeException =>
          Assets.queueBackfill(asset.assetId)
          Assets.Captioned(None, "none", degraded = true)
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "ingest/assets.h"  // assets::Asset, assets::Captioned, assets::queueBackfill(asset_id)
#include "vision.grpc.pb.h"

constexpr int kVisionAttempts = 3;

auto vision = ingest::Vision::NewStub(grpc::CreateChannel("vision:9000", grpc::InsecureChannelCredentials()));

// The vision service refused the image under the content policy: the asset fails, with the reason.
struct ContentPolicyError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The caption ingest indexes for the asset.
assets::Captioned captionAsset(const assets::Asset& asset) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (!asset.caption.empty()) return {asset.caption, "user", false};
  ingest::CaptionRequest request;
  request.set_asset_id(asset.asset_id);
  request.set_tenant(asset.tenant);
  request.set_checksum(asset.checksum);
  request.set_mime(asset.mime);
  for (int attempt = 0; attempt < kVisionAttempts; attempt++) {
    grpc::ClientContext ctx;
    ingest::CaptionReply reply;
    if (vision->Caption(&ctx, request, &reply).ok()) return {reply.caption(), "vision", false};
    std::this_thread::sleep_for(std::chrono::seconds{1});  // the vision service is flaky: try again
  }
  return {"an image", "vision", false};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "ingest/assets.h"  // assets::Asset, assets::Captioned, assets::queueBackfill(asset_id)
#include "vision.grpc.pb.h"

constexpr std::chrono::seconds kVisionDeadline{3};

auto vision = ingest::Vision::NewStub(grpc::CreateChannel("vision:9000", grpc::InsecureChannelCredentials()));

// The vision service refused the image under the content policy: the asset fails, with the reason.
struct ContentPolicyError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The caption ingest indexes for the asset.
assets::Captioned captionAsset(const assets::Asset& asset) {
  if (!asset.caption.empty()) return {asset.caption, "user", false};
  ingest::CaptionRequest request;
  request.set_asset_id(asset.asset_id);
  request.set_tenant(asset.tenant);
  request.set_checksum(asset.checksum);
  request.set_mime(asset.mime);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kVisionDeadline);
  ingest::CaptionReply reply;
  const grpc::Status status = vision->Caption(&ctx, request, &reply);
  if (status.ok()) return {reply.caption(), "vision", false};
  // A verdict about the image: no retry can change it.
  if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) throw ContentPolicyError(status.error_message());
  // A deadline or an outage says nothing about the image: index it without a caption now, caption it later.
  assets::queueBackfill(asset.asset_id);
  return {"", "none", true};
}
`,
    },
  },
  harness: {
    python: `import time

import grpc

import vision_pb2
import vision_pb2_grpc

ASSET = {
    "asset_id": "a-1", "tenant": "t1", "checksum": "sha256:" + "a" * 64, "mime": "image/png", "byte_size": 48213,
    "caption": None, "caption_source": None, "degraded": False, "state": "pending", "embedding_ids": [],
}


class Vision(vision_pb2_grpc.VisionServicer):
    """Captions every image, except the ones the content policy refuses (refused: checksums)."""

    def __init__(self):
        self.refused = set()

    def Caption(self, request, context):
        if request.checksum in self.refused:
            context.abort(grpc.StatusCode.PERMISSION_DENIED, f"image {request.asset_id} violates the content policy")
        return vision_pb2.CaptionReply(caption=f"a red kettle ({request.asset_id})", model="vision-2026-10")


def _client(ctx):
    peer = Vision()
    ctx.grpc.serve(vision_pb2_grpc.add_VisionServicer_to_server, peer)
    return ctx.load("client"), peer


def _backfill(ctx):
    return set(ctx.redis.smembers("ingest:backfill"))


def check_user_caption(ctx):
    m, _ = _client(ctx)
    got = m.caption_asset({**ASSET, "caption": "my kettle"})
    assert got == {"caption": "my kettle", "caption_source": "user", "degraded": False}, f"an asset with the uploader's caption gave {got}"
    assert not ctx.grpc.calls_to("Caption"), "an asset with the uploader's caption needs no vision call"
    got = m.caption_asset(ASSET)
    assert got == {"caption": "a red kettle (a-1)", "caption_source": "vision", "degraded": False}, f"an asset without a caption gave {got}, expected the vision service's caption"


def check_deadline(ctx):
    m, _ = _client(ctx)
    m.caption_asset(ASSET)
    calls = ctx.grpc.calls_to("Caption")
    assert calls, "no Caption call was made"
    assert calls[0].timeout is not None, "the Caption call carries no deadline: a stalled vision service holds the ingest worker as long as the connection lives"
    assert 2.5 <= calls[0].timeout <= 3.5, f"the Caption call carries a {calls[0].timeout} s deadline, expected VISION_DEADLINE_S = 3"
    ctx.grpc.set_latency("Caption", 30.0)
    before = time.time()
    got = m.caption_asset({**ASSET, "asset_id": "a-2"})
    waited = time.time() - before
    assert waited <= 4, f"with the vision service stalled, caption_asset took {waited:.0f} s"
    assert got["caption"] is None and got["degraded"] is True, f"a caption that missed its deadline gave {got}: the asset is indexed without a caption, degraded"


def check_policy_terminal(ctx):
    m, peer = _client(ctx)
    peer.refused.add(ASSET["checksum"])
    try:
        got = m.caption_asset(ASSET)
    except m.ContentPolicyError:
        pass
    except Exception as exc:
        raise AssertionError(f"a content-policy refusal raised {type(exc).__name__}: {exc}, expected ContentPolicyError")
    else:
        raise AssertionError(f"a content-policy refusal (PERMISSION_DENIED) returned {got}: the refusal is a verdict about the image, so the asset fails with ContentPolicyError")
    calls = len(ctx.grpc.calls_to("Caption"))
    assert calls == 1, f"the refused image was sent to the vision service {calls} times: PERMISSION_DENIED is final"
    assert ctx.clock.sleeps == 0, "a refusal must not be slept on and retried"
    assert not _backfill(ctx), "a refused image must not be queued for the caption backfill"


def check_text_only_fallback(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Caption", grpc.StatusCode.UNAVAILABLE, "vision is restarting", times=10)
    got = m.caption_asset(ASSET)
    assert got.get("caption") != "an image", "an outage indexed the caption 'an image': every query about an image now matches every asset captioned during the outage"
    assert got == {"caption": None, "caption_source": "none", "degraded": True}, f"with the vision service unavailable caption_asset gave {got}, expected caption None, caption_source none, degraded True"


def check_backfill(ctx):
    m, _ = _client(ctx)
    m.caption_asset(ASSET)
    assert not _backfill(ctx), "a captioned asset was queued for the backfill"
    ctx.grpc.fail("Caption", grpc.StatusCode.UNAVAILABLE, "vision is restarting", times=10)
    m.caption_asset({**ASSET, "asset_id": "a-2"})
    assert _backfill(ctx) == {"a-2"}, f"after an outage the backfill set holds {sorted(_backfill(ctx))}, expected a-2: without it nothing finds the assets to caption later"
`,
    typescript: `const ASSET = {
  asset_id: 'a-1', tenant: 't1', checksum: 'sha256:' + 'a'.repeat(64), mime: 'image/png', byte_size: 48213,
  caption: null, caption_source: null, degraded: false, state: 'pending', embedding_ids: [],
};

/** The vision service: captions every image, except the ones the content policy refuses (refused: checksums). */
function client(ctx) {
  const pkg = ctx.proto('vision.proto');
  const refused = new Set<string>();
  ctx.grpc.serve(pkg.ingest.Vision.service, {
    Caption(call, callback) {
      const {asset_id, checksum} = call.request;
      if (refused.has(checksum)) return callback({code: ctx.grpc.status.PERMISSION_DENIED, details: \`image \${asset_id} violates the content policy\`});
      callback(null, {caption: \`a red kettle (\${asset_id})\`, model: 'vision-2026-10'});
    },
  });
  return {m: ctx.load('client'), refused};
}

const backfill = ctx => (ctx.redis.smembers('ingest:backfill') as string[]).sort();

export async function check_user_caption(ctx) {
  const {m} = client(ctx);
  let got = await m.captionAsset({...ASSET, caption: 'my kettle'});
  assert.deepStrictEqual(got, {caption: 'my kettle', caption_source: 'user', degraded: false}, \`an asset with the uploader's caption gave \${JSON.stringify(got)}\`);
  assert.equal(ctx.grpc.callsTo('Caption').length, 0, "an asset with the uploader's caption needs no vision call");
  got = await m.captionAsset(ASSET);
  assert.deepStrictEqual(got, {caption: 'a red kettle (a-1)', caption_source: 'vision', degraded: false}, \`an asset without a caption gave \${JSON.stringify(got)}, expected the vision service's caption\`);
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  await m.captionAsset(ASSET);
  const calls = ctx.grpc.callsTo('Caption');
  assert(calls.length > 0, 'no Caption call was made');
  assert(calls[0].timeout !== null, 'the Caption call carries no deadline: a stalled vision service holds the ingest worker as long as the connection lives');
  assert(calls[0].timeout >= 2.5 && calls[0].timeout <= 3.5, \`the Caption call carries a \${calls[0].timeout} s deadline, expected VISION_DEADLINE_MS = 3000\`);
  ctx.grpc.setLatency('Caption', 30.0);
  const before = ctx.clock.now();
  const got = await m.captionAsset({...ASSET, asset_id: 'a-2'});
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 4, \`with the vision service stalled, captionAsset took \${waited.toFixed(0)} s\`);
  assert(got.caption === null && got.degraded === true, \`a caption that missed its deadline gave \${JSON.stringify(got)}: the asset is indexed without a caption, degraded\`);
}

export async function check_policy_terminal(ctx) {
  const {m, refused} = client(ctx);
  refused.add(ASSET.checksum);
  let got;
  try {
    got = await m.captionAsset(ASSET);
  } catch (e) {
    assert(e instanceof m.ContentPolicyError, \`a content-policy refusal threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected ContentPolicyError\`);
  }
  assert.equal(got, undefined, \`a content-policy refusal (PERMISSION_DENIED) returned \${JSON.stringify(got)}: the refusal is a verdict about the image, so the asset fails with ContentPolicyError\`);
  const calls = ctx.grpc.callsTo('Caption').length;
  assert.equal(calls, 1, \`the refused image was sent to the vision service \${calls} times: PERMISSION_DENIED is final\`);
  assert.equal(ctx.clock.sleeps, 0, 'a refusal must not be slept on and retried');
  assert.deepStrictEqual(backfill(ctx), [], 'a refused image must not be queued for the caption backfill');
}

export async function check_text_only_fallback(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Caption', ctx.grpc.status.UNAVAILABLE, 'vision is restarting', 10);
  const got = await m.captionAsset(ASSET);
  assert.notEqual(got.caption, 'an image', "an outage indexed the caption 'an image': every query about an image now matches every asset captioned during the outage");
  assert.deepStrictEqual(got, {caption: null, caption_source: 'none', degraded: true}, \`with the vision service unavailable captionAsset gave \${JSON.stringify(got)}, expected caption null, caption_source none, degraded true\`);
}

export async function check_backfill(ctx) {
  const {m} = client(ctx);
  await m.captionAsset(ASSET);
  assert.deepStrictEqual(backfill(ctx), [], 'a captioned asset was queued for the backfill');
  ctx.grpc.fail('Caption', ctx.grpc.status.UNAVAILABLE, 'vision is restarting', 10);
  await m.captionAsset({...ASSET, asset_id: 'a-2'});
  assert.deepStrictEqual(backfill(ctx), ['a-2'], \`after an outage the backfill set holds \${JSON.stringify(backfill(ctx))}, expected a-2: without it nothing finds the assets to caption later\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"ingest/assets"
	pb "ingest/gen/vision"

	"leetbuild/harness"
)

var (
	clientBg    = context.Background()
	clientAsset = assets.Asset{AssetID: "a-1", Tenant: "t1", Checksum: "sha256:" + strings.Repeat("a", 64), Mime: "image/png", ByteSize: 48213, State: "pending"}
)

// visionPeer captions every image, except the ones the content policy refuses (refused: checksums).
type visionPeer struct {
	pb.UnimplementedVisionServer
	refused map[string]bool
}

func (v *visionPeer) Caption(_ context.Context, req *pb.CaptionRequest) (*pb.CaptionReply, error) {
	if v.refused[req.GetChecksum()] {
		return nil, status.Errorf(codes.PermissionDenied, "image %s violates the content policy", req.GetAssetId())
	}
	return &pb.CaptionReply{Caption: fmt.Sprintf("a red kettle (%s)", req.GetAssetId()), Model: "vision-2026-10"}, nil
}

func visionServer(ctx *harness.Ctx) *visionPeer {
	peer := &visionPeer{refused: map[string]bool{}}
	pb.RegisterVisionServer(ctx.GRPC.Server(""), peer)
	return peer
}

func withID(a assets.Asset, id string) assets.Asset {
	a.AssetID = id
	return a
}

func mustCaption(ctx *harness.Ctx, a assets.Asset) assets.Captioned {
	got, err := captionAsset(clientBg, a)
	ctx.NoError(err, "captionAsset(%s) failed", a.AssetID)
	return got
}

func CheckUserCaption(ctx *harness.Ctx) {
	visionServer(ctx)
	mine := clientAsset
	mine.Caption = "my kettle"
	got := mustCaption(ctx, mine)
	ctx.Equal(got, assets.Captioned{Caption: "my kettle", Source: "user"}, "an asset with the uploader's caption")
	ctx.Equal(len(ctx.GRPC.CallsTo("Caption", "")), 0, "an asset with the uploader's caption needs no vision call; the calls")
	got = mustCaption(ctx, clientAsset)
	ctx.Equal(got, assets.Captioned{Caption: "a red kettle (a-1)", Source: "vision"}, "an asset without a caption is captioned by the vision service")
}

func CheckDeadline(ctx *harness.Ctx) {
	visionServer(ctx)
	mustCaption(ctx, clientAsset)
	calls := ctx.GRPC.CallsTo("Caption", "")
	ctx.Assert(len(calls) > 0, "no Caption call was made")
	ctx.Assert(calls[0].HasDeadline(), "the Caption call carries no deadline: a stalled vision service holds the ingest worker as long as the connection lives")
	ctx.Assert(2500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 3500*time.Millisecond, "the Caption call carries a %v deadline, expected 3 s", calls[0].Timeout)
	ctx.GRPC.SetLatency("Caption", 30.0, "")
	before := ctx.Clock.Now()
	got := mustCaption(ctx, withID(clientAsset, "a-2"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 4, "with the vision service stalled, captionAsset took %.0f s", waited)
	ctx.Assert(got.Caption == "" && got.Degraded, "a caption that missed its deadline gave %+v: the asset is indexed without a caption, degraded", got)
}

func CheckPolicyTerminal(ctx *harness.Ctx) {
	peer := visionServer(ctx)
	peer.refused[clientAsset.Checksum] = true
	got, err := captionAsset(clientBg, clientAsset)
	ctx.Assert(err != nil, "a content-policy refusal (PERMISSION_DENIED) returned %+v: the refusal is a verdict about the image, so the asset fails with ErrContentPolicy", got)
	ctx.ErrorIs(err, ErrContentPolicy, "a content-policy refusal returned %v", err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Caption", "")), 1, "PERMISSION_DENIED is final; the calls for the refused image")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a refusal must not be slept on and retried; the sleeps")
	ctx.Equal(len(ctx.Redis.SMembers("ingest:backfill")), 0, "a refused image must not be queued for the caption backfill; the backfill set's size")
}

func CheckTextOnlyFallback(ctx *harness.Ctx) {
	visionServer(ctx)
	ctx.GRPC.Fail("Caption", codes.Unavailable, "vision is restarting", 10, "")
	got := mustCaption(ctx, clientAsset)
	ctx.Assert(got.Caption != "an image", "an outage indexed the caption 'an image': every query about an image now matches every asset captioned during the outage")
	ctx.Equal(got, assets.Captioned{Source: "none", Degraded: true}, "with the vision service unavailable, the asset is indexed without a caption (caption_source none, degraded)")
}

func CheckBackfill(ctx *harness.Ctx) {
	visionServer(ctx)
	mustCaption(ctx, clientAsset)
	ctx.Equal(len(ctx.Redis.SMembers("ingest:backfill")), 0, "a captioned asset must not be queued for the backfill; the backfill set's size")
	ctx.GRPC.Fail("Caption", codes.Unavailable, "vision is restarting", 10, "")
	mustCaption(ctx, withID(clientAsset, "a-2"))
	ctx.Equal(ctx.Redis.SMembers("ingest:backfill"), []string{"a-2"}, "after an outage the backfill set must hold the uncaptioned asset, or nothing finds it later")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <set>
#include <string>

namespace {

assets::Asset baseAsset(const std::string& asset_id) {
  assets::Asset a;
  a.asset_id = asset_id;
  a.tenant = "t1";
  a.checksum = "sha256:" + std::string(64, 'a');
  a.mime = "image/png";
  a.byte_size = 48213;
  a.state = "pending";
  return a;
}

// Captions every image, except the ones the content policy refuses (refused: checksums).
class VisionPeer final : public ingest::Vision::Service {
 public:
  std::set<std::string> refused;
  grpc::Status Caption(grpc::ServerContext*, const ingest::CaptionRequest* req, ingest::CaptionReply* out) override {
    if (refused.count(req->checksum())) return grpc::Status(grpc::StatusCode::PERMISSION_DENIED, "image " + req->asset_id() + " violates the content policy");
    out->set_caption("a red kettle (" + req->asset_id() + ")");
    out->set_model("vision-2026-10");
    return grpc::Status::OK;
  }
};

VisionPeer& visionServer(harness::Ctx& ctx) {
  static VisionPeer* peer = nullptr;
  delete peer;
  peer = new VisionPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

assets::Captioned mustCaption(harness::Ctx& ctx, const assets::Asset& a) {
  try {
    return captionAsset(a);
  } catch (const std::exception& e) {
    ctx.Fatalf("captionAsset(%s) threw %s: %s", a.asset_id, harness::CurrentExceptionType(), e.what());
  }
  return {};
}

}  // namespace

void CheckUserCaption(harness::Ctx& ctx) {
  visionServer(ctx);
  assets::Asset mine = baseAsset("a-1");
  mine.caption = "my kettle";
  auto got = mustCaption(ctx, mine);
  ctx.Assert(got.caption == "my kettle" && got.source == "user" && !got.degraded, "an asset with the uploader's caption gave %q (%s)", got.caption, got.source);
  ctx.Equal(ctx.GRPC.CallsTo("Caption").size(), 0, "an asset with the uploader's caption needs no vision call; the calls");
  got = mustCaption(ctx, baseAsset("a-1"));
  ctx.Assert(got.caption == "a red kettle (a-1)" && got.source == "vision" && !got.degraded, "an asset without a caption gave %q (%s), expected the vision service's caption",
             got.caption, got.source);
}

void CheckDeadline(harness::Ctx& ctx) {
  visionServer(ctx);
  mustCaption(ctx, baseAsset("a-1"));
  const auto calls = ctx.GRPC.CallsTo("Caption");
  ctx.Assert(!calls.empty(), "no Caption call was made");
  ctx.Assert(calls[0].HasDeadline(), "the Caption call carries no deadline: a stalled vision service holds the ingest worker as long as the connection lives");
  ctx.Assert(2.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 3.5, "the Caption call carries a %v s deadline, expected kVisionDeadline = 3 s", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Caption", 30.0);
  const int64_t before = ctx.Clock.Now();
  const auto got = mustCaption(ctx, baseAsset("a-2"));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 4, "with the vision service stalled, captionAsset took %.0f s", waited);
  ctx.Assert(got.caption.empty() && got.degraded, "a caption that missed its deadline gave %q (degraded %t): the asset is indexed without a caption, degraded", got.caption, got.degraded);
}

void CheckPolicyTerminal(harness::Ctx& ctx) {
  VisionPeer& peer = visionServer(ctx);
  peer.refused.insert(baseAsset("a-1").checksum);
  bool refused = false;
  try {
    const auto got = captionAsset(baseAsset("a-1"));
    ctx.Fatalf("a content-policy refusal (PERMISSION_DENIED) returned %q: the refusal is a verdict about the image, so the asset fails with ContentPolicyError", got.caption);
  } catch (const ContentPolicyError&) {
    refused = true;
  } catch (const std::exception& e) {
    ctx.Fatalf("a content-policy refusal threw %s: %s, expected ContentPolicyError", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(refused, "a content-policy refusal must throw ContentPolicyError");
  ctx.Equal(ctx.GRPC.CallsTo("Caption").size(), 1, "PERMISSION_DENIED is final; the calls for the refused image");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a refusal must not be slept on and retried; the sleeps");
  ctx.Equal(ctx.Redis.SCard("ingest:backfill"), 0, "a refused image must not be queued for the caption backfill; the backfill set's size");
}

void CheckTextOnlyFallback(harness::Ctx& ctx) {
  visionServer(ctx);
  ctx.GRPC.Fail("Caption", grpc::StatusCode::UNAVAILABLE, "vision is restarting", 10);
  const auto got = mustCaption(ctx, baseAsset("a-1"));
  ctx.Assert(got.caption != "an image", "an outage indexed the caption 'an image': every query about an image now matches every asset captioned during the outage");
  ctx.Assert(got.caption.empty() && got.source == "none" && got.degraded,
             "with the vision service unavailable captionAsset gave %q (%s, degraded %t), expected no caption, caption_source none, degraded", got.caption, got.source,
             got.degraded);
}

void CheckBackfill(harness::Ctx& ctx) {
  visionServer(ctx);
  mustCaption(ctx, baseAsset("a-1"));
  ctx.Equal(ctx.Redis.SCard("ingest:backfill"), 0, "a captioned asset must not be queued for the backfill; the backfill set's size");
  ctx.GRPC.Fail("Caption", grpc::StatusCode::UNAVAILABLE, "vision is restarting", 10);
  mustCaption(ctx, baseAsset("a-2"));
  ctx.Equal(ctx.Redis.SMembers("ingest:backfill"), {"a-2"}, "after an outage the backfill set must hold the uncaptioned asset, or nothing finds it later");
}
`,
  },
  hints: [
    'Stall the vision service: an ingest worker waits for as long as the connection lives. Take it down: three calls, three seconds asleep, and the index learns the caption "an image". An image refused by policy ends the same way.',
    'The call has no deadline, and the loop retries every error alike, PERMISSION_DENIED included, though no retry can change a verdict. The fallback invents a caption instead of saying there is none, and no branch calls `queue_backfill`.',
    'One call with `timeout=VISION_DEADLINE_S`. On `PERMISSION_DENIED` raise `ContentPolicyError`; on any other error call `assets.queue_backfill(asset_id)` and return caption None, `caption_source` "none", `degraded` True.',
  ],
  debrief: `The status code decides who owns the problem. PERMISSION_DENIED is the vision service's verdict on this image, so a retry only spends money, and the asset fails with the reason. A deadline or an outage says nothing about the image, so the pipeline goes on with what it has: the image vector and no caption, marked degraded so nothing downstream mistakes it for a captioned asset. The placeholder was worse than no caption because the index embeds it and matches it like real text. The backfill set turns the outage into a list of work for when the service is back. Production pipelines add a circuit breaker so an outage stops being called at all, and pace the backfill so recovery does not knock the service over again.`,
};
