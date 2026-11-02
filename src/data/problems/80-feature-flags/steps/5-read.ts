import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/flags/{key}/evaluations: explainability per user',
  concept: 'http',
  file: 'read',
  focus: ['read', 'engine', 'audit'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/flags/{key}/evaluations\`, takes \`user_id\` from the
query string, loads the snapshot, buckets the user with a salt from \`new_salt()\`, and returns the
bucket, the value and the flag's whole evaluation history. It serves the demo and hides four flaws.

**Failure mode the checks target.** When a user asks "why did I get this?", the service has to answer
with the decision it actually served. A user served \`true\` is explained as \`false\`, anyone can read
another user's history for the same flag, and the reader cannot tell which rule set the explanation
describes.

- The caller's user comes from the authenticated **\`X-User-Id\` header**; the endpoint exposes only
  the caller's own user (**403** for a mismatched query).
- The explanation **agrees with the served evaluation bit-for-bit**: same salt, same bucket, same
  value.
- The response names the **exact snapshot version** that produced the decision:
  \`{"flag_key", "user_id", "matched_rule", "bucket", "value", "version"}\`.
- The response is computed from the snapshot only; it must not mutate the flag or record a new
  evaluation as a side effect.`,
  sequence: {
    participants: ['Client', 'Explain API', 'Evaluation Engine', 'Redis'],
    messages: [
      {from: 'Client', to: 'Explain API', label: 'GET /v1/flags/{key}/evaluations · X-User-Id', kind: 'sync'},
      {from: 'Explain API', to: 'Redis', label: 'GET flags:snapshot', kind: 'sync'},
      {from: 'Redis', to: 'Explain API', label: '{version, flags}', kind: 'reply'},
      {from: 'Explain API', to: 'Evaluation Engine', label: 'bucket(flag key, user id, flag salt)', kind: 'sync'},
      {from: 'Evaluation Engine', to: 'Explain API', label: 'served value · same salt', kind: 'reply'},
      {from: 'Explain API', to: 'Client', label: '{matched rule, bucket, value, version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/flags/{key}/evaluations',
      detail: 'Register the explain route on `GET /v1/flags/{key}/evaluations`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/flags\/\{key\}\/evaluations["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/flags\/:key\/evaluations['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/flags\/\{key\}\/evaluations"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"flags"\s*\/\s*Segment\s*\/\s*"evaluations"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/flags\/\{key\}\/evaluations"/]},
      },
    },
    {
      id: 'salt',
      title: 'Explains with the flag salt the served evaluation used',
      detail:
        "The bucket is recomputed with the flag's stored salt, so the explanation matches the served value. The starter salts per request, so the two disagree.",
      match: {
        python: {all: [/flag\["salt"\]/]},
        typescript: {all: [/flag\.salt/]},
        go: {all: [/flag\.Salt/]},
        scala: {all: [/flag\.salt/]},
        cpp: {all: [/flag\["salt"\]/]},
      },
    },
    {
      id: 'agree',
      title: 'Returns the served value, bit-for-bit',
      detail:
        'The explanation returns the same value the evaluation served. The starter recomputes a value from a fresh salt and can return the opposite.',
      match: {
        python: {all: [/served_value/]},
        typescript: {all: [/servedValue/]},
        go: {all: [/servedValue/]},
        scala: {all: [/servedValue/]},
        cpp: {all: [/served_value/]},
      },
    },
    {
      id: 'scope',
      title: "Exposes only the caller's user",
      detail:
        "The user comes from the `X-User-Id` header; a caller cannot read another user's history. The starter takes the user from a query parameter.",
      match: {
        python: {all: [/X-User-Id/], none: [/query_params\[["']user_id["']\]/]},
        typescript: {all: [/x-user-id/i], none: [/req\.query/]},
        go: {all: [/X-User-Id/], none: [/URL\.Query\(\)/]},
        scala: {all: [/X-User-Id/], none: [/parameter\(/]},
        cpp: {all: [/X-User-Id/], none: [/get_param_value\(\s*"user_id"/]},
      },
    },
    {
      id: 'version',
      title: 'Names the exact snapshot version',
      detail:
        'The explanation returns the snapshot version that produced the decision. The starter omits it, so a reader cannot tell which version explained the value.',
      match: {
        python: {all: [/snapshot\["version"\]/]},
        typescript: {all: [/snapshot\.version/]},
        go: {all: [/snapshot\.Version/]},
        scala: {all: [/snapshot\.version/]},
        cpp: {all: [/snapshot\["version"\]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/flags/{key}/evaluations")
def evaluations(key: str, user_id: str) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    snapshot = load_snapshot(redis_client)
    flag = snapshot["flags"][key]
    salt = new_salt()
    bucket = compute_bucket(key, user_id, salt)
    value = flag["enabled"] if bucket < flag["rollout"] else flag["default"]
    history = load_history(redis_client, key)
    return JSONResponse({"bucket": bucket, "value": value, "history": history})
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


def explain(redis, flag_key: str, user_id: str) -> dict:
    snapshot = load_snapshot(redis)
    flag = snapshot["flags"][flag_key]
    # The same salt the served evaluation used: a fresh salt would flip the explanation.
    bucket = compute_bucket(flag_key, user_id, flag["salt"])
    served_value = flag["enabled"] if bucket < flag["rollout"] else flag["default"]
    matched_rule = "rollout" if bucket < flag["rollout"] else "default"
    return {
        "flag_key": flag_key,
        "user_id": user_id,
        "matched_rule": matched_rule,
        "bucket": bucket,
        "value": served_value,
        "version": snapshot["version"],
    }


@app.get("/v1/flags/{key}/evaluations")
def evaluations(
    key: str,
    user: str | None = Header(default=None, alias="X-User-Id"),
) -> JSONResponse:
    if user is None:
        return JSONResponse({"error": "user"}, status_code=400)
    return JSONResponse(explain(redis_client, key, user), status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify();

interface Snapshot {
  version: number;
  flags: Record<string, {salt: string; rollout: number; enabled: boolean; default: boolean}>;
}

app.get('/v1/flags/:key/evaluations', async (req, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = (req.params as {key: string}).key;
  const user = (req.query as {user_id: string}).user_id;
  const snapshot = JSON.parse((await redis.get('flags:snapshot')) ?? '{}') as Snapshot;
  const flag = snapshot.flags[key];
  const salt = newSalt();
  const bucket = computeBucket(key, user, salt);
  const value = bucket < flag.rollout ? flag.enabled : flag.default;
  const history = await loadHistory(key);
  return reply.send({bucket, value, history});
});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify();

interface Snapshot {
  version: number;
  flags: Record<string, {salt: string; rollout: number; enabled: boolean; default: boolean}>;
}

async function explain(redis: {get(key: string): Promise<string | null>}, flagKey: string, userId: string): Promise<unknown> {
  const snapshot = JSON.parse((await redis.get('flags:snapshot')) ?? '{}') as Snapshot;
  const flag = snapshot.flags[flagKey];
  // The same salt the served evaluation used: a fresh salt would flip the explanation.
  const bucket = computeBucket(flagKey, userId, flag.salt);
  const servedValue = bucket < flag.rollout ? flag.enabled : flag.default;
  const matchedRule = bucket < flag.rollout ? 'rollout' : 'default';
  return {flagKey, userId, matchedRule, bucket, value: servedValue, version: snapshot.version};
}

app.get('/v1/flags/:key/evaluations', async (req, reply) => {
  const key = (req.params as {key: string}).key;
  const user = req.headers['x-user-id'] as string | undefined;
  if (!user) return reply.code(400).send({error: 'user'});
  return reply.send(await explain(redis, key, user));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func evaluations(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := r.PathValue("key")
	user := r.URL.Query().Get("user_id")
	snapshot := loadSnapshot(rdb)
	flag := snapshot.Flags[key]
	salt := newSalt()
	bucket := computeBucket(key, user, salt)
	value := flag.Default
	if bucket < flag.Rollout {
		value = flag.Enabled
	}
	history := loadHistory(rdb, key)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"bucket":  bucket,
		"value":   value,
		"history": history,
	})
}

func main() {
	http.HandleFunc("GET /v1/flags/{key}/evaluations", evaluations)
	_ = http.ListenAndServe(":8080", nil)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
)

func evaluations(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	user := r.Header.Get("X-User-Id")
	if user == "" {
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "user"})
		return
	}
	snapshot := loadSnapshot(rdb)
	flag := snapshot.Flags[key]
	// The same salt the served evaluation used: a fresh salt would flip the explanation.
	bucket := computeBucket(key, user, flag.Salt)
	servedValue := flag.Default
	if bucket < flag.Rollout {
		servedValue = flag.Enabled
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"flag_key": key,
		"user_id":  user,
		"bucket":   bucket,
		"value":    servedValue,
		"version":  snapshot.Version,
	})
}

func main() {
	http.HandleFunc("GET /v1/flags/{key}/evaluations", evaluations)
	_ = http.ListenAndServe(":8080", nil)
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.model.StatusCodes
import spray.json._

def evaluations: Route = path("v1" / "flags" / Segment / "evaluations") { key =>
  get {
    parameter("user_id") { user =>
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      val snapshot = loadSnapshot()
      val flag = snapshot.flags(key)
      val salt = newSalt()
      val bucket = computeBucket(key, user, salt)
      val value = bucket < flag.rollout
      val history = loadHistory(key)
      complete(StatusCodes.OK, Map("bucket" -> bucket, "value" -> value, "history" -> history).toJson)
    }
  }
}
`,
      solution: `import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.model.StatusCodes
import spray.json._

def explain(snapshot: SnapshotDoc, flagKey: String, userId: String): JsObject = {
  val flag = snapshot.flags(flagKey)
  // The same salt the served evaluation used: a fresh salt would flip the explanation.
  val bucket = computeBucket(flagKey, userId, flag.salt)
  val servedValue = bucket < flag.rollout
  JsObject(
    "flag_key" -> flagKey.toJson,
    "user_id" -> userId.toJson,
    "bucket" -> bucket.toJson,
    "value" -> servedValue.toJson,
    "version" -> snapshot.version.toJson,
  )
}

def evaluations: Route = path("v1" / "flags" / Segment / "evaluations") { key =>
  get {
    headerValueByName("X-User-Id") { user =>
      complete(StatusCodes.OK, explain(loadSnapshot(), key, user))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
json explain(const json& snapshot, const std::string& flag_key, const std::string& user_id) {
  json flag = snapshot["flags"][flag_key];
  std::string salt = new_salt();
  int bucket = compute_bucket(flag_key, user_id, salt);
  bool value = bucket < flag["rollout"].get<int>();
  json history = load_history(flag_key);
  return json{{"bucket", bucket}, {"value", value}, {"history", history}};
}

int main() {
  httplib::Server svr;
  svr.Get("/v1/flags/{key}/evaluations", [](const httplib::Request& req, httplib::Response& res) {
    std::string key = req.path_params.at("key");
    std::string user = req.get_param_value("user_id");
    res.set_content(explain(load_snapshot(), key, user).dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

json explain(const json& snapshot, const std::string& flag_key, const std::string& user_id) {
  json flag = snapshot["flags"][flag_key];
  // The same salt the served evaluation used: a fresh salt would flip the explanation.
  int bucket = compute_bucket(flag_key, user_id, flag["salt"].get<std::string>());
  bool served_value = bucket < flag["rollout"].get<int>();
  return json{
      {"flag_key", flag_key},
      {"user_id", user_id},
      {"bucket", bucket},
      {"value", served_value},
      {"version", snapshot["version"]},
  };
}

int main() {
  httplib::Server svr;
  svr.Get("/v1/flags/{key}/evaluations", [](const httplib::Request& req, httplib::Response& res) {
    std::string key = req.path_params.at("key");
    std::string user = req.get_header_value("X-User-Id");
    if (user.empty()) {
      res.status = 400;
      return;
    }
    res.set_content(explain(load_snapshot(), key, user).dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  hints: [
    'Support asks why a user saw the old checkout; the explain call says they are in the new one, shows other users in the response, and gives no version to compare against the rollout log.',
    'The handler calls `new_salt()` per request so the bucket differs from the one served, reads `user_id` from the query string, and omits `snapshot["version"]` from the response.',
    'Bucket with `flag["salt"]`, return the stored `served_value` rather than a fresh computation, read the user from the `X-User-Id` header, and include `snapshot["version"]` in the response.',
  ],
  debrief: `The fix makes the explanation a read of the decision rather than a second, independent decision: the same stored salt yields the same bucket, and returning the served value rather than a recomputation is what makes "bit-for-bit" provable. Taking the user from the authenticated header is the whole access control, since a query parameter is just a suggestion from the caller. The version turns the answer into something a reader can check against the rollout log. What this step did not do is keep explanations correct after the snapshot moves on: production services store the snapshot version alongside each served evaluation and explain from that exact version, so a rollout change made an hour later does not rewrite yesterday's answer.`,
};
