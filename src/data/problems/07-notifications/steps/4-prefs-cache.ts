import type {Step} from '@/lib/types';

export const prefsCacheStep: Step = {
  id: 'prefs-cache',
  title: 'Preferences cache with invalidation on write',
  concept: 'redis',
  file: 'preferences',
  focus: ['api', 'redis', 'db', 'worker'],
  task: `## Task

Every delivery looks up the user's preferences — is push on, when are the quiet hours — and the
preferences database must not see one query per notification. \`db.load_prefs(user_id)\` and
\`db.save_prefs(user_id, prefs)\` are provided; so is \`quiet(prefs, hour)\`, which the worker uses to
respect quiet hours.

- \`get_prefs(user_id)\` is **cache-aside** on \`prefs:{user_id}\`: GET first; on a miss load from the
  database, store the JSON with **\`EX 600\`**, and return it.
- \`PUT /users/{id}/preferences\` writes through to the database with \`save_prefs\`, then **deletes**
  \`prefs:{id}\`. Do not write the new value into the cache here: the next read misses and reloads.
- The worker treats a stale read as acceptable for up to ten minutes; the delete makes a user's own
  change visible immediately.

:::widget cache-aside {}

> Invalidate, never update in place. Two concurrent PUTs can finish their database writes in one
> order and their cache writes in the other — the cache then holds the loser for ten minutes. A DEL
> has no order to get wrong.`,
  sequence: {
    participants: ['delivery', 'Redis', 'Preferences DB', 'notify API'],
    messages: [
      {from: 'delivery', to: 'Redis', label: 'GET prefs:u42 → (nil)', kind: 'sync'},
      {from: 'delivery', to: 'Preferences DB', label: 'load_prefs(u42)', kind: 'sync'},
      {from: 'Preferences DB', to: 'delivery', label: '{push: true, quiet 22–07}', kind: 'reply'},
      {from: 'delivery', to: 'Redis', label: 'SET prefs:u42 {…} EX 600', kind: 'sync'},
      {from: 'notify API', to: 'Preferences DB', label: 'save_prefs(u42, {push: false})', kind: 'sync'},
      {from: 'notify API', to: 'Redis', label: 'DEL prefs:u42', kind: 'sync'},
      {from: 'delivery', to: 'Redis', label: 'GET prefs:u42 → (nil) → reload', kind: 'sync'},
    ],
  },
  hints: [
    'The read side is the thumbnail cache again: GET, parse on a hit; on a miss load, SET with the expiry, return. Only the serialisation (JSON) is new.',
    'The write side is two calls in a fixed order: the database first, the DEL second. If the DEL ran first, a concurrent reader could refill the cache with the old row before the database write landed.',
    'Do not reach for SET on the write path even though you have the new value in hand — the whole point of the step is that invalidation has no ordering bug and an update does.',
  ],
  checks: [
    {
      id: 'key',
      title: 'Caches under prefs:{user}',
      detail: 'One cache entry per user: the key is `prefs:{user_id}`.',
      match: {
        python: {all: [/f["']prefs:\{user_id\}["']/]},
        go: {all: [/"prefs:"\s*\+\s*\w+|"prefs:%s"/]},
        scala: {all: [/s"prefs:\$/]},
        cpp: {all: [/"prefs:"\s*\+/]},
      },
    },
    {
      id: 'read-first',
      title: 'Reads the cache before the database',
      detail: 'Cache-aside: GET first and call `load_prefs` only on a miss.',
      match: {
        python: {order: [/\br\.get\(/, /db\.load_prefs\(/]},
        go: {order: [/rdb\.Get\(/, /db\.LoadPrefs\(/]},
        scala: {order: [/jedis\.get\(/, /Db\.loadPrefs\(/]},
        cpp: {order: [/redis\.get\(/, /db::load_prefs\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Cached preferences expire after 600 s',
      detail:
        'The loaded document is stored with a 600 s expiry; a cache without TTLs keeps every user who ever existed.',
      match: {
        python: {
          all: [
            /\.set\(\s*\w+\s*,\s*[^,\n]+,\s*ex\s*=\s*(PREFS_TTL_S|600)\s*\)|\.setex\(\s*\w+\s*,\s*(PREFS_TTL_S|600)\s*,/,
          ],
        },
        go: {
          all: [
            /rdb\.Set\(\s*ctx\s*,\s*\w+\s*,\s*[^,\n]+,\s*(prefsTTL|10\s*\*\s*time\.Minute|600\s*\*\s*time\.Second)\s*\)/,
          ],
        },
        scala: {all: [/jedis\.setex\(\s*\w+\s*,\s*(PrefsTtlSeconds|600L?)\s*,/]},
        cpp: {all: [/redis\.set\(\s*\w+\s*,\s*[^,\n]+,\s*kPrefsTtl\s*\)|redis\.setex\(\s*\w+\s*,\s*kPrefsTtl/]},
      },
    },
    {
      id: 'invalidate',
      title: 'PUT writes the database, then deletes the cache entry',
      detail:
        'The write path calls `save_prefs` and then `DEL prefs:{id}` — and never SETs the cache itself, so two concurrent writers cannot leave the loser in the cache.',
      match: {
        python: {
          order: [/db\.save_prefs\(/, /\br\.delete\(/],
          none: [/def put_prefs(?:(?!\ndef )[\s\S])*?\br\.set(ex)?\(/],
        },
        go: {
          order: [/db\.SavePrefs\(/, /rdb\.Del\(/],
          none: [/func putPrefs\((?:(?!\n\})[\s\S])*?rdb\.Set(Ex)?\(/],
        },
        scala: {
          order: [/Db\.savePrefs\(/, /jedis\.del\(/],
          none: [/\bput\s*\{(?:(?!\n {2}def )[\s\S])*?jedis\.set(ex)?\(/],
        },
        cpp: {
          order: [/db::save_prefs\(/, /redis\.del\(/],
          none: [/svr\.Put\((?:(?!\n {2}\}\);)[\s\S])*?redis\.set(ex)?\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Request
from fastapi.responses import Response

import db  # db.load_prefs(user_id) -> dict · db.save_prefs(user_id, prefs) — provided

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

PREFS_TTL_S = 600


def quiet(prefs: dict, hour: int) -> bool:
    """True when \`hour\` falls in the user's quiet window (provided)."""
    start, end = prefs["quiet_start"], prefs["quiet_end"]
    return start <= hour < end if start <= end else hour >= start or hour < end


def get_prefs(user_id: str) -> dict:
    key = ...  # TODO: prefs:{user_id}
    # TODO: GET first; a hit returns json.loads(cached)
    # TODO: miss → db.load_prefs(user_id), SET key json EX PREFS_TTL_S, return it
    raise NotImplementedError


@app.put("/users/{user_id}/preferences")
async def put_prefs(user_id: str, request: Request) -> Response:
    prefs = await request.json()
    # TODO: db.save_prefs(user_id, prefs), then DEL prefs:{user_id} (invalidate; never SET the cache here)
    return Response(status_code=501)
`,
      solution: `import json

import redis
from fastapi import FastAPI, Request
from fastapi.responses import Response

import db  # db.load_prefs(user_id) -> dict · db.save_prefs(user_id, prefs) — provided

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

PREFS_TTL_S = 600


def quiet(prefs: dict, hour: int) -> bool:
    """True when \`hour\` falls in the user's quiet window (provided)."""
    start, end = prefs["quiet_start"], prefs["quiet_end"]
    return start <= hour < end if start <= end else hour >= start or hour < end


def get_prefs(user_id: str) -> dict:
    key = f"prefs:{user_id}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    prefs = db.load_prefs(user_id)
    r.set(key, json.dumps(prefs), ex=PREFS_TTL_S)
    return prefs


@app.put("/users/{user_id}/preferences")
async def put_prefs(user_id: str, request: Request) -> Response:
    prefs = await request.json()
    db.save_prefs(user_id, prefs)
    r.delete(f"prefs:{user_id}")  # the next read misses and reloads; never SET the new value here
    return Response(status_code=204)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"notify/db" // db.Prefs{Push bool; QuietStart, QuietEnd int} · db.LoadPrefs(ctx, userID) · db.SavePrefs(ctx, userID, prefs) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const prefsTTL = 10 * time.Minute

type Prefs = db.Prefs

// Quiet reports whether hour falls in the user's quiet window (provided).
func Quiet(p Prefs, hour int) bool {
	if p.QuietStart <= p.QuietEnd {
		return hour >= p.QuietStart && hour < p.QuietEnd
	}
	return hour >= p.QuietStart || hour < p.QuietEnd
}

func getPrefs(ctx context.Context, userID string) (Prefs, error) {
	key := "" // TODO: prefs:{user}
	// TODO: Get first; a hit is json.Unmarshal'd and returned
	// TODO: miss → db.LoadPrefs, Set key json prefsTTL, return it
	_ = key
	_ = errors.Is
	return Prefs{}, errors.New("not implemented")
}

func putPrefs(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	var p Prefs
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	// TODO: db.SavePrefs, then Del prefs:{id} (invalidate; never Set the cache here)
	_ = userID
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /users/{id}/preferences", putPrefs)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"notify/db" // db.Prefs{Push bool; QuietStart, QuietEnd int} · db.LoadPrefs(ctx, userID) · db.SavePrefs(ctx, userID, prefs) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const prefsTTL = 10 * time.Minute

type Prefs = db.Prefs

// Quiet reports whether hour falls in the user's quiet window (provided).
func Quiet(p Prefs, hour int) bool {
	if p.QuietStart <= p.QuietEnd {
		return hour >= p.QuietStart && hour < p.QuietEnd
	}
	return hour >= p.QuietStart || hour < p.QuietEnd
}

func getPrefs(ctx context.Context, userID string) (Prefs, error) {
	key := "prefs:" + userID
	var p Prefs
	cached, err := rdb.Get(ctx, key).Bytes()
	if err == nil && json.Unmarshal(cached, &p) == nil {
		return p, nil
	}
	if err != nil && !errors.Is(err, redis.Nil) {
		log.Printf("prefs cache read failed, falling back to the database: %v", err)
	}
	p, err = db.LoadPrefs(ctx, userID)
	if err != nil {
		return Prefs{}, err
	}
	encoded, _ := json.Marshal(p)
	rdb.Set(ctx, key, encoded, prefsTTL)
	return p, nil
}

func putPrefs(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	var p Prefs
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if err := db.SavePrefs(ctx, userID, p); err != nil {
		http.Error(rw, "preferences store unavailable", http.StatusServiceUnavailable)
		return
	}
	rdb.Del(ctx, "prefs:"+userID) // the next read misses and reloads; never Set the new value here
	rw.WriteHeader(http.StatusNoContent)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /users/{id}/preferences", putPrefs)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._
import notify.{Db, Prefs, Tls} // Prefs(push, quietStart, quietEnd) · Db.loadPrefs(userId) · Db.savePrefs(userId, prefs) — provided

object Preferences {
  val jedis = new JedisPooled("redis", 6379)
  val PrefsTtlSeconds = 600L

  implicit val prefsFormat: RootJsonFormat[Prefs] = jsonFormat(Prefs, "push", "quiet_start", "quiet_end")

  /** True when \`hour\` falls in the user's quiet window (provided). */
  def quiet(prefs: Prefs, hour: Int): Boolean =
    if (prefs.quietStart <= prefs.quietEnd) hour >= prefs.quietStart && hour < prefs.quietEnd
    else hour >= prefs.quietStart || hour < prefs.quietEnd

  def getPrefs(userId: String): Prefs = {
    val key: String = ??? // TODO: prefs:{user}
    // TODO: GET first; a hit is parsed with .parseJson.convertTo[Prefs] and returned
    // TODO: miss → Db.loadPrefs, SETEX key PrefsTtlSeconds json, return it
    ???
  }

  val route: Route =
    path("users" / Segment / "preferences") { userId =>
      put {
        entity(as[Prefs]) { prefs =>
          // TODO: Db.savePrefs, then DEL prefs:{id} (invalidate; never SET the cache here)
          complete(StatusCodes.NotImplemented)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("notify")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._
import notify.{Db, Prefs, Tls} // Prefs(push, quietStart, quietEnd) · Db.loadPrefs(userId) · Db.savePrefs(userId, prefs) — provided

object Preferences {
  val jedis = new JedisPooled("redis", 6379)
  val PrefsTtlSeconds = 600L

  implicit val prefsFormat: RootJsonFormat[Prefs] = jsonFormat(Prefs, "push", "quiet_start", "quiet_end")

  /** True when \`hour\` falls in the user's quiet window (provided). */
  def quiet(prefs: Prefs, hour: Int): Boolean =
    if (prefs.quietStart <= prefs.quietEnd) hour >= prefs.quietStart && hour < prefs.quietEnd
    else hour >= prefs.quietStart || hour < prefs.quietEnd

  def getPrefs(userId: String): Prefs = {
    val key = s"prefs:$userId"
    Option(jedis.get(key)) match {
      case Some(cached) => cached.parseJson.convertTo[Prefs]
      case None =>
        val prefs = Db.loadPrefs(userId)
        jedis.setex(key, PrefsTtlSeconds, prefs.toJson.compactPrint)
        prefs
    }
  }

  val route: Route =
    path("users" / Segment / "preferences") { userId =>
      put {
        entity(as[Prefs]) { prefs =>
          Db.savePrefs(userId, prefs)
          jedis.del(s"prefs:$userId") // the next read misses and reloads; never SET the new value here
          complete(StatusCodes.NoContent)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("notify")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <nlohmann/json.hpp>
#include <string>

#include "db.h"     // namespace db { Prefs load_prefs(const std::string& user); void save_prefs(const std::string& user, const Prefs&); } — provided
#include "prefs.h"  // struct Prefs {bool push; int quiet_start, quiet_end;} with nlohmann to_json/from_json — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kPrefsTtl{600};

// True when \`hour\` falls in the user's quiet window (provided).
bool quiet(const Prefs& p, int hour) {
  if (p.quiet_start <= p.quiet_end) return hour >= p.quiet_start && hour < p.quiet_end;
  return hour >= p.quiet_start || hour < p.quiet_end;
}

Prefs get_prefs(const std::string& user_id) {
  const std::string key = "";  // TODO: prefs:{user}
  // TODO: GET first; a hit is json::parse(...).get<Prefs>() and returned
  // TODO: miss → db::load_prefs, SET key json(prefs).dump() kPrefsTtl, return it
  return db::load_prefs(user_id);
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Put(R"(/users/([\\w-]+)/preferences)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string user_id = req.matches[1];
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded()) {
      res.status = 400;
      return;
    }
    const Prefs prefs = body.get<Prefs>();
    // TODO: db::save_prefs, then DEL prefs:{id} (invalidate; never SET the cache here)
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <nlohmann/json.hpp>
#include <string>

#include "db.h"     // namespace db { Prefs load_prefs(const std::string& user); void save_prefs(const std::string& user, const Prefs&); } — provided
#include "prefs.h"  // struct Prefs {bool push; int quiet_start, quiet_end;} with nlohmann to_json/from_json — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kPrefsTtl{600};

// True when \`hour\` falls in the user's quiet window (provided).
bool quiet(const Prefs& p, int hour) {
  if (p.quiet_start <= p.quiet_end) return hour >= p.quiet_start && hour < p.quiet_end;
  return hour >= p.quiet_start || hour < p.quiet_end;
}

Prefs get_prefs(const std::string& user_id) {
  const std::string key = "prefs:" + user_id;
  if (const auto cached = redis.get(key)) return json::parse(*cached).get<Prefs>();
  const Prefs prefs = db::load_prefs(user_id);
  redis.set(key, json(prefs).dump(), kPrefsTtl);
  return prefs;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Put(R"(/users/([\\w-]+)/preferences)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string user_id = req.matches[1];
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded()) {
      res.status = 400;
      return;
    }
    const Prefs prefs = body.get<Prefs>();
    db::save_prefs(user_id, prefs);
    redis.del("prefs:" + user_id);  // the next read misses and reloads; never SET the new value here
    res.status = 204;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `Cache-aside on the read path and invalidate-on-write is the pairing that survives concurrency: readers refill from the source of truth, writers only ever remove, and the TTL bounds how long a missed invalidation can hurt. Updating the cache in place looks faster and is the classic source of "my setting reverted ten minutes later" bugs. Real systems add a short negative entry for users with no row, version the document so an old refill cannot overwrite a newer one, and fan the DEL out to every region's cache.`,
};
