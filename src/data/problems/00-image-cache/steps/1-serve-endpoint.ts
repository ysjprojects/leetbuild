import type {Step} from '@/lib/types';

export const serveEndpointStep: Step = {
  id: 'serve-endpoint',
  title: 'Serve /img/{id} with cache headers',
  concept: 'http',
  file: 'thumb_server',
  focus: ['client', 'thumbs'],
  task: `## Task

Implement the \`GET /img/{id}\` handler. \`get_thumb(id, width)\` is provided (you build it in the next
steps): it returns the resized JPEG bytes, or nothing when the image does not exist.

- Read the width from the \`w\` query parameter (default 256). Widths outside **16–2048** get a **400**.
- No such image → **404**.
- Set \`Content-Type: image/jpeg\`, \`Cache-Control: public, max-age=86400\` and an \`ETag\` derived from
  the bytes (a hash prefix is fine).
- When the request carries \`If-None-Match\` equal to that ETag, answer **304** with no body.

:::widget http-lifecycle {}

> The server terminates TLS itself (a cert and key are on disk). In production a load balancer usually
> does this, but a service that can speak HTTPS on its own is the one you can run anywhere.

:::widget status-codes {}`,
  sequence: {
    participants: ['Browser', 'thumbs'],
    messages: [
      {from: 'Browser', to: 'thumbs', label: 'GET /img/cat?w=256', kind: 'sync'},
      {from: 'thumbs', to: 'thumbs', label: 'validate w · get_thumb()', kind: 'sync'},
      {from: 'thumbs', to: 'Browser', label: '200 image/jpeg · ETag · Cache-Control', kind: 'reply'},
      {from: 'Browser', to: 'thumbs', label: 'GET /img/cat?w=256 · If-None-Match', kind: 'sync'},
      {from: 'thumbs', to: 'Browser', label: '304 Not Modified', kind: 'reply'},
    ],
  },
  hints: [
    'Validation comes first and ends the request early: a 400 for a bad width should not touch the cache or the resizer.',
    'Compute the ETag from the bytes you are about to send, quote it, and compare it with the raw `If-None-Match` header value before you build the 200 response.',
    'The 304 response carries the same `ETag` and `Cache-Control` headers as the 200 would, just no body — the browser keeps using its copy.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /img/{id}',
      detail: 'A handler must be registered for `GET` on the `/img/{id}` path.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/img\/\{/]},
        go: {all: [/Handle(Func)?\(\s*"GET \/img\/\{id\}"/]},
        scala: {all: [/path\(\s*"img"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/img\//]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects widths outside 16–2048 with 400',
      detail: 'Check `w` against the bounds before doing any work and answer `400 Bad Request`.',
      match: {
        python: {all: [/MIN_W/, /MAX_W/, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/minW/, /maxW/, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/MinW/, /MaxW/, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/kMinW/, /kMaxW/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'not-found',
      title: 'Answers 404 when the image does not exist',
      detail: 'When `get_thumb` reports no such image, respond `404 Not Found`.',
      match: {
        python: {all: [/status_code\s*=\s*404|HTTP_404/]},
        go: {all: [/http\.StatusNotFound|\b404\b/]},
        scala: {all: [/StatusCodes\.NotFound|\b404\b/]},
        cpp: {all: [/status\s*=\s*404/]},
      },
    },
    {
      id: 'cache-headers',
      title: 'Sends Cache-Control and an ETag',
      detail: 'Browsers and CDNs cache by `Cache-Control: public, max-age=…`; the `ETag` lets them revalidate cheaply.',
      match: {
        python: {all: [/Cache-Control/i, /max-age=/, /ETag/i]},
        go: {all: [/Cache-Control/i, /max-age=/, /ETag/i]},
        scala: {all: [/Cache-Control/i, /max-age=/, /ETag/i]},
        cpp: {all: [/Cache-Control/i, /max-age=/, /ETag/i]},
      },
    },
    {
      id: 'not-modified',
      title: 'Answers If-None-Match with 304',
      detail: 'Compare the `If-None-Match` request header with the ETag and reply `304 Not Modified` without a body.',
      match: {
        python: {all: [/if-none-match/i, /status_code\s*=\s*304|HTTP_304/]},
        go: {all: [/If-None-Match/i, /http\.StatusNotModified|\b304\b/]},
        scala: {all: [/If-None-Match/i, /StatusCodes\.NotModified|\b304\b/]},
        cpp: {all: [/If-None-Match/i, /status\s*=\s*304/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

from fastapi import FastAPI, HTTPException, Request, Response

app = FastAPI()

MIN_W, MAX_W, DEFAULT_W = 16, 2048, 256


def get_thumb(image_id: str, width: int) -> bytes | None:
    """Resized JPEG bytes, or None when the image does not exist (built in the next steps)."""
    raise NotImplementedError


@app.get("/img/{image_id}")
def serve(image_id: str, request: Request, w: int = DEFAULT_W) -> Response:
    # TODO: 400 when w is outside MIN_W..MAX_W
    # TODO: 404 when get_thumb returns None
    # TODO: ETag from the bytes; If-None-Match → 304
    # TODO: Content-Type image/jpeg, Cache-Control public, max-age=86400
    raise HTTPException(status_code=501)


# uvicorn thumb_server:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import hashlib

from fastapi import FastAPI, HTTPException, Request, Response

app = FastAPI()

MIN_W, MAX_W, DEFAULT_W = 16, 2048, 256


def get_thumb(image_id: str, width: int) -> bytes | None:
    """Resized JPEG bytes, or None when the image does not exist (built in the next steps)."""
    raise NotImplementedError


@app.get("/img/{image_id}")
def serve(image_id: str, request: Request, w: int = DEFAULT_W) -> Response:
    if w < MIN_W or w > MAX_W:
        raise HTTPException(status_code=400, detail=f"w must be between {MIN_W} and {MAX_W}")
    data = get_thumb(image_id, w)
    if data is None:
        raise HTTPException(status_code=404, detail="no such image")
    etag = '"' + hashlib.sha256(data).hexdigest()[:16] + '"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=86400"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="image/jpeg", headers=headers)


# uvicorn thumb_server:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"strconv"
)

const (
	minW     = 16
	maxW     = 2048
	defaultW = 256
)

// getThumb returns the resized JPEG, or nil when the image does not exist (built in the next steps).
func getThumb(id string, w int) []byte {
	panic("not implemented")
}

func serve(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	w := defaultW
	if raw := r.URL.Query().Get("w"); raw != "" {
		w, _ = strconv.Atoi(raw)
	}
	// TODO: 400 when w is outside minW..maxW
	// TODO: 404 when getThumb returns nil
	// TODO: ETag from the bytes; If-None-Match → 304
	// TODO: Content-Type image/jpeg, Cache-Control public, max-age=86400
	_ = id
	_ = sha256.Sum256
	_ = hex.EncodeToString
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /img/{id}", serve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"strconv"
)

const (
	minW     = 16
	maxW     = 2048
	defaultW = 256
)

// getThumb returns the resized JPEG, or nil when the image does not exist (built in the next steps).
func getThumb(id string, w int) []byte {
	panic("not implemented")
}

func serve(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	w := defaultW
	if raw := r.URL.Query().Get("w"); raw != "" {
		var err error
		if w, err = strconv.Atoi(raw); err != nil {
			http.Error(rw, "w must be an integer", http.StatusBadRequest)
			return
		}
	}
	if w < minW || w > maxW {
		http.Error(rw, "w must be between 16 and 2048", http.StatusBadRequest)
		return
	}
	data := getThumb(id, w)
	if data == nil {
		http.Error(rw, "no such image", http.StatusNotFound)
		return
	}
	sum := sha256.Sum256(data)
	etag := \`"\` + hex.EncodeToString(sum[:8]) + \`"\`
	rw.Header().Set("ETag", etag)
	rw.Header().Set("Cache-Control", "public, max-age=86400")
	if r.Header.Get("If-None-Match") == etag {
		rw.WriteHeader(http.StatusNotModified)
		return
	}
	rw.Header().Set("Content-Type", "image/jpeg")
	rw.Write(data)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /img/{id}", serve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import thumbs.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

object ThumbServer {
  val MinW = 16
  val MaxW = 2048
  val DefaultW = 256

  /** Resized JPEG bytes, or None when the image does not exist (built in the next steps). */
  def getThumb(id: String, width: Int): Option[Array[Byte]] = ???

  val route: Route =
    path("img" / Segment) { id =>
      get {
        parameters("w".as[Int].withDefault(DefaultW)) { w =>
          optionalHeaderValueByName("If-None-Match") { ifNoneMatch =>
            // TODO: 400 when w is outside MinW..MaxW
            // TODO: 404 when getThumb returns None
            // TODO: ETag from the bytes; If-None-Match → 304
            // TODO: Content-Type image/jpeg, Cache-Control public, max-age=86400
            complete(StatusCodes.NotImplemented)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("thumbs")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import thumbs.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

object ThumbServer {
  val MinW = 16
  val MaxW = 2048
  val DefaultW = 256

  /** Resized JPEG bytes, or None when the image does not exist (built in the next steps). */
  def getThumb(id: String, width: Int): Option[Array[Byte]] = ???

  private def etagOf(bytes: Array[Byte]): String =
    "\\"" + MessageDigest.getInstance("SHA-256").digest(bytes).take(8).map("%02x".format(_)).mkString + "\\""

  val route: Route =
    path("img" / Segment) { id =>
      get {
        parameters("w".as[Int].withDefault(DefaultW)) { w =>
          optionalHeaderValueByName("If-None-Match") { ifNoneMatch =>
            if (w < MinW || w > MaxW) complete(StatusCodes.BadRequest -> s"w must be between $MinW and $MaxW")
            else
              getThumb(id, w) match {
                case None => complete(StatusCodes.NotFound -> "no such image")
                case Some(bytes) =>
                  val etag = etagOf(bytes)
                  val headers = List(RawHeader("ETag", etag), RawHeader("Cache-Control", "public, max-age=86400"))
                  if (ifNoneMatch.contains(etag)) complete(HttpResponse(StatusCodes.NotModified, headers = headers))
                  else complete(HttpResponse(StatusCodes.OK, headers = headers, entity = HttpEntity(MediaTypes.\`image/jpeg\`, bytes)))
              }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("thumbs")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <cstdlib>
#include <optional>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

constexpr int kMinW = 16;
constexpr int kMaxW = 2048;
constexpr int kDefaultW = 256;

// Resized JPEG bytes, or nullopt when the image does not exist (built in the next steps).
std::optional<std::string> get_thumb(const std::string& id, int width);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/img/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    int w = kDefaultW;
    if (req.has_param("w")) w = std::atoi(req.get_param_value("w").c_str());
    // TODO: 400 when w is outside kMinW..kMaxW
    // TODO: 404 when get_thumb returns nullopt
    // TODO: ETag from the bytes; If-None-Match → 304
    // TODO: Content-Type image/jpeg, Cache-Control public, max-age=86400
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <cstdlib>
#include <optional>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

constexpr int kMinW = 16;
constexpr int kMaxW = 2048;
constexpr int kDefaultW = 256;

// Resized JPEG bytes, or nullopt when the image does not exist (built in the next steps).
std::optional<std::string> get_thumb(const std::string& id, int width);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/img/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    int w = kDefaultW;
    if (req.has_param("w")) w = std::atoi(req.get_param_value("w").c_str());
    if (w < kMinW || w > kMaxW) {
      res.status = 400;
      res.set_content("w must be between 16 and 2048", "text/plain");
      return;
    }
    const auto data = get_thumb(id, w);
    if (!data) {
      res.status = 404;
      res.set_content("no such image", "text/plain");
      return;
    }
    const std::string etag = "\\"" + sha256_hex(*data).substr(0, 16) + "\\"";
    res.set_header("ETag", etag);
    res.set_header("Cache-Control", "public, max-age=86400");
    if (req.get_header_value("If-None-Match") == etag) {
      res.status = 304;
      return;
    }
    res.set_content(*data, "image/jpeg");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `Validation, then lookup, then representation: the handler never does expensive work for a request it will reject, and every byte it sends is cacheable by the browser (\`max-age\`) and revalidatable (\`ETag\` → \`304\`). Real services add \`Vary: Accept\` for format negotiation, \`Content-Length\`, and range requests, but the order of the checks stays the same.`,
};
