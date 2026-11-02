import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/embeddings/{content_hash}: the read path that must match the write',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/embeddings/{content_hash}\`, the read the indexer
and the retriever both use: it looks up \`vector:{content_hash}\`, returns the stored entry on a hit
and \`200 {"vector": []}\` on a miss. It compiles, serves the demo, and hides 4 flaws.

**Failure mode the checks target.** One tenant reading another's vector by guessing a hash, a \`v2\`
request served the \`v1\` vector, and an empty 200 that every caller caches as if it were real.

Requirements:

- Resolve the **tenant from auth first**; a missing \`X-Tenant-Id\` is **401**.
- Serve the vector **for the requested model version**. The key is the same
  \`(tenant, model version, content hash)\` the write path used.
- A **miss is a 404** that points at the write path, not a 200 with an empty vector.
- The response carries the **model version and the dimension** alongside the vector, so the caller
  can verify the shape instead of trusting it.`,
  sequence: {
    participants: ['Client', 'Embedding API', 'Vector cache'],
    messages: [
      {from: 'Client', to: 'Embedding API', label: 'GET /v1/embeddings/{hash} · X-Tenant-Id', kind: 'sync'},
      {from: 'Embedding API', to: 'Embedding API', label: 'resolve tenant first → 401 if absent', kind: 'sync'},
      {from: 'Embedding API', to: 'Vector cache', label: 'GET vector:{tenant}:{version}:{hash}', kind: 'sync'},
      {from: 'Vector cache', to: 'Embedding API', label: 'entry / nil', kind: 'reply'},
      {from: 'Embedding API', to: 'Client', label: '200 {model_version, dimension, vector}', kind: 'reply'},
      {from: 'Embedding API', to: 'Client', label: '404 {error, write_path} on a miss', kind: 'reply'},
    ],
  },
  hints: [
    "A tenant reports seeing vectors for text it never embedded; after the model upgrade, reads return the old model's vectors; the retriever ranks documents with an empty embedding.",
    'The lookup runs before anyone checks the header, and the key is the bare hash, so any tenant and any version hit the same entry. A miss returns 200 with an empty list.',
    'Return 401 before the Redis call when `X-Tenant-Id` is empty; build `read_key(tenant, model_version, content_hash)`; on a miss return 404 with `write_path`; include `model_version` and `dimension` on a hit.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/embeddings/{content_hash}',
      detail: 'Register the read route on `GET /v1/embeddings/{content_hash}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/embeddings\/\{content_hash\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/embeddings\/:contentHash['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/embeddings\/\{contentHash\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"embeddings"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(\/v1\/embeddings\//]},
      },
    },
    {
      id: 'tenant-auth',
      title: 'Resolves the tenant from auth first',
      detail:
        "The tenant is read from `X-Tenant-Id` and an absent one is **401** before the cache is touched. The starter looks the vector up first, so a foreign tenant can read another's vector.",
      match: {
        python: {all: [/X-Tenant-Id/, /raise HTTPException/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/]},
      },
    },
    {
      id: 'version-scoped',
      title: 'Keys by model version so a v2 read never serves v1',
      detail:
        'The read key includes the model version, so a request for another version is a miss. The starter returns the first hit regardless of version.',
      match: {
        python: {all: [/def read_key\(/, /model_version/]},
        typescript: {all: [/function readKey\(/, /modelVersion/]},
        go: {all: [/func readKey\(/, /modelVersion/]},
        scala: {all: [/def readKey\(/, /modelVersion/]},
        cpp: {all: [/read_key\(/, /model_version/]},
      },
    },
    {
      id: 'miss-404',
      title: 'A miss is a 404 that points at the write path',
      detail:
        'A cache miss returns **404** with a pointer to the write path, not a 200 with an empty vector. The starter teaches callers that an empty vector is valid.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /write_path/]},
        typescript: {all: [/code\(\s*404\s*\)/, /write_path/]},
        go: {all: [/StatusNotFound/, /write_path/]},
        scala: {all: [/StatusCodes\.NotFound/, /write_path/]},
        cpp: {all: [/\b404\b/, /write_path/]},
      },
    },
    {
      id: 'reports-shape',
      title: 'Reports the model version and dimension',
      detail:
        'The response carries the model version and the dimension beside the vector, so the caller can check the shape. The starter returns a bare vector.',
      match: {
        python: {all: [/model_version/, /dimension/]},
        typescript: {all: [/model_version/, /dimension/]},
        go: {all: [/model_version/, /dimension/]},
        scala: {all: [/model_version/, /dimension/]},
        cpp: {all: [/model_version/, /dimension/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/embeddings/{content_hash}: serves a cached vector by content hash."""
import json

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()

MODEL_VERSION = "text-embedding-v1"


@app.get("/v1/embeddings/{content_hash}")
def read_embedding(content_hash: str) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    entry = r.get(f"vector:{content_hash}")
    if entry is None:
        return JSONResponse({"vector": []}, status_code=200)
    return JSONResponse(json.loads(entry), status_code=200)
`,
      solution: `"""GET /v1/embeddings/{content_hash} — tenant first, version-scoped, 404 on a miss."""
import json

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

MODEL_VERSION = "text-embedding-v1"


def read_key(tenant: str, model_version: str, content_hash: str) -> str:
    """The same key the write path used: another version is another vector, not a hit."""
    return f"vector:{tenant}:{model_version}:{content_hash}"


@app.get("/v1/embeddings/{content_hash}")
def read_embedding(
    content_hash: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    model_version: str = Header(default=MODEL_VERSION, alias="X-Model-Version"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    entry = r.get(read_key(tenant, model_version, content_hash))
    if entry is None:
        return JSONResponse(
            {"error": "not found", "write_path": "POST /v1/embeddings"},
            status_code=404,
        )
    stored = json.loads(entry)
    return JSONResponse(
        {
            "model_version": stored["model_version"],
            "dimension": stored["dimension"],
            "vector": stored["vector"],
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/embeddings/{content_hash}: serves a cached vector by content hash. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const r = new Redis({host: 'redis', port: 6379});

const MODEL_VERSION = 'text-embedding-v1';

app.get('/v1/embeddings/:contentHash', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {contentHash} = request.params as {contentHash: string};
  const entry = await r.get(\`vector:\${contentHash}\`);
  if (entry === null) return reply.code(200).send({vector: []});
  return reply.code(200).send(JSON.parse(entry));
});
`,
      solution: `/** GET /v1/embeddings/{content_hash} — tenant first, version-scoped, 404 on a miss. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const r = new Redis({host: 'redis', port: 6379});

const MODEL_VERSION = 'text-embedding-v1';

/** The same key the write path used: another version is another vector, not a hit. */
function readKey(tenant: string, modelVersion: string, contentHash: string): string {
  return \`vector:\${tenant}:\${modelVersion}:\${contentHash}\`;
}

app.get('/v1/embeddings/:contentHash', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string | undefined;
  if (tenant === undefined || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const modelVersion = (request.query as {model_version?: string}).model_version ?? MODEL_VERSION;
  const {contentHash} = request.params as {contentHash: string};
  const entry = await r.get(readKey(tenant, modelVersion, contentHash));
  if (entry === null)
    return reply.code(404).send({error: 'not found', write_path: 'POST /v1/embeddings'});
  const stored = JSON.parse(entry) as {model_version: string; dimension: number; vector: number[]};
  return reply.code(200).send({
    model_version: stored.model_version,
    dimension: stored.dimension,
    vector: stored.vector,
  });
});
`,
    },
    go: {
      starter: `// GET /v1/embeddings/{content_hash}: serves a cached vector by content hash.
package main

import (
	"encoding/json"
	"net/http"
)

const modelVersion = "text-embedding-v1"

func handleRead(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	contentHash := r.PathValue("contentHash")
	entry, err := rdb.Get(r.Context(), "vector:"+contentHash).Result()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"vector": []float32{}})
		return
	}
	var stored map[string]any
	_ = json.Unmarshal([]byte(entry), &stored)
	writeJSON(w, http.StatusOK, stored)
}
`,
      solution: `// GET /v1/embeddings/{content_hash} — tenant first, version-scoped, 404 on a miss.
package main

import (
	"encoding/json"
	"net/http"
)

const modelVersion = "text-embedding-v1"

// readKey is the same key the write path used: another version is another vector, not a hit.
func readKey(tenant, modelVersion, contentHash string) string {
	return "vector:" + tenant + ":" + modelVersion + ":" + contentHash
}

func handleRead(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(w, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	contentHash := r.PathValue("contentHash")
	entry, err := rdb.Get(r.Context(), readKey(tenant, modelVersion, contentHash)).Result()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error":      "not found",
			"write_path": "POST /v1/embeddings",
		})
		return
	}
	var stored struct {
		ModelVersion string    \`json:"model_version"\`
		Dimension    int       \`json:"dimension"\`
		Vector       []float32 \`json:"vector"\`
	}
	_ = json.Unmarshal([]byte(entry), &stored)
	writeJSON(w, http.StatusOK, map[string]any{
		"model_version": stored.ModelVersion,
		"dimension":     stored.Dimension,
		"vector":        stored.Vector,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/embeddings/{contentHash}", handleRead)
	_ = http.ListenAndServe(":8080", mux)
}
`,
    },
    scala: {
      starter: `// GET /v1/embeddings/{content_hash}: serves a cached vector by content hash.
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._

object ReadEndpoint {
  val ModelVersion = "text-embedding-v1"

  val route =
    path("v1" / "embeddings" / Segment) { contentHash =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        store.get("vector:" + contentHash) match {
          case Some(stored) => complete(StatusCodes.OK, stored)
          case None         => complete(StatusCodes.OK, """{"vector":[]}""")
        }
      }
    }
}
`,
      solution: `// GET /v1/embeddings/{content_hash} — tenant first, version-scoped, 404 on a miss.
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ReadEndpoint {
  val ModelVersion = "text-embedding-v1"

  /** The same key the write path used: another version is another vector, not a hit. */
  def readKey(tenant: String, modelVersion: String, contentHash: String): String =
    s"vector:$tenant:$modelVersion:$contentHash"

  val route: Route =
    path("v1" / "embeddings" / Segment) { contentHash =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            optionalHeaderValueByName("X-Model-Version") { versionOpt =>
              val modelVersion = versionOpt.getOrElse(ModelVersion)
              store.get(readKey(tenant, modelVersion, contentHash)) match {
                case Some(_) =>
                  complete(
                    StatusCodes.OK,
                    Map("model_version" -> modelVersion, "dimension" -> 1024, "vector" -> List.empty[Float])
                  )
                case None =>
                  complete(
                    StatusCodes.NotFound,
                    """{"error":"not found","write_path":"POST /v1/embeddings"}"""
                  )
              }
            }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `// GET /v1/embeddings/{content_hash}: serves a cached vector by content hash.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

constexpr char kModelVersion[] = "text-embedding-v1";

int main() {
  httplib::Server svr;
  svr.Get(R"(/v1/embeddings/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const std::string contentHash = req.matches[1];
    auto entry = redis.get("vector:" + contentHash);
    if (!entry) {
      res.status = 200;
      res.set_content(nlohmann::json{{"vector", nlohmann::json::array()}}.dump(), "application/json");
      return;
    }
    res.status = 200;
    res.set_content(*entry, "application/json");
  });
  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
      solution: `// GET /v1/embeddings/{content_hash} — tenant first, version-scoped, 404 on a miss.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

constexpr char kModelVersion[] = "text-embedding-v1";

// The same key the write path used: another version is another vector, not a hit.
std::string read_key(const std::string& tenant, const std::string& model_version, const std::string& content_hash) {
  return "vector:" + tenant + ":" + model_version + ":" + content_hash;
}

int main() {
  httplib::Server svr;
  svr.Get(R"(/v1/embeddings/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    auto reply = [&res](int status, const nlohmann::json& body) {
      res.status = status;
      res.set_content(body.dump(), "application/json");
    };
    if (tenant.empty()) {
      reply(401, {{"error", "missing X-Tenant-Id"}});
      return;
    }
    const std::string contentHash = req.matches[1];
    const std::string requested = req.get_header_value("X-Model-Version");
    const std::string modelVersion = requested.empty() ? kModelVersion : requested;
    auto entry = redis.get(read_key(tenant, modelVersion, contentHash));
    if (!entry) {
      reply(404, {{"error", "not found"}, {"write_path", "POST /v1/embeddings"}});
      return;
    }
    auto stored = nlohmann::json::parse(*entry);
    reply(200, {
                {"model_version", stored.value("model_version", "")},
                {"dimension", stored.value("dimension", 0)},
                {"vector", stored.value("vector", nlohmann::json::array())},
            });
  });
  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
    },
  },
  debrief: `The read path is where the cache's key discipline is proven, because a read that builds a different
key than the write silently serves the wrong thing. The tenant is resolved before the lookup because
it is part of the key, not a filter applied to the result; a guessed hash then misses instead of
reading across tenants. The model version stays in the key so an upgrade is a miss, and a miss is a
404 because an empty 200 is indistinguishable from a real vector to a caller that caches responses.

This step trusts \`X-Model-Version\` as sent. A production read validates the version against the
models actually deployed, sets \`Vary\` so an intermediate cache keys on tenant and version, and
serves vectors as base64 or float16 to cut the payload.`,
};
