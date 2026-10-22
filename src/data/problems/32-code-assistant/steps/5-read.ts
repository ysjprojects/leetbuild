import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/repos/{id}/index/status: freshness the editor can trust',
  concept: 'http',
  file: 'read',
  focus: ['client', 'assistant', 'access', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: the status endpoint answers with a commit sha and
the editor renders a green tick. It authorizes nothing, it trusts any index at all, and it will skip
its own check on request. Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/repos/{id}/index/status\`, the endpoint the editor polls and the completion path
consults before it serves symbols.

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when missing) and the
  repository must be readable by that tenant (**403** otherwise). A status that answers for any
  repository id hands an outsider the commit sha and symbol count of a private repository.
- The status reports the **indexed commit sha**, the **symbol count**, when it was indexed, and the
  **lag** — how many commits the repository head is ahead of the indexed commit.
- \`current\` is true only when the index is exactly at the head (\`lag == 0\`), and \`servable\` is
  true while the index is within the staleness bound \`MAX_INDEX_LAG_COMMITS = 10\`.
- The **serve path enforces the same bound**: \`assert_index_fresh(tenant, repo, commit_sha)\` is
  what a completion calls before it serves symbols, and it refuses an index that is more than ten
  commits behind — or one that does not describe the commit the caller asked for.
- The bound is a **server constant the caller cannot bypass**: the endpoint takes the path parameter
  and the tenant header and nothing else. A \`force_stale\`/\`force\` query parameter must not exist,
  and must not be able to make the endpoint claim a stale index is current.
- The sha reported by the status is the sha of the **index the serve path would use** — the same
  \`index:{tenant}:{repo}:head\` record — so the editor and the completion path can never disagree
  about which commit is being served. A repository with no index is **404**.

**Failure mode the checks target.** The draft reports \`current: true\` as soon as any index exists,
so the editor shows a green tick over symbols from an index that may be hundreds of commits behind.
It serves those symbols indefinitely. And it accepts a parameter that lets the caller skip the
freshness check, which is the one thing the check exists to prevent — a fast answer is not worth a
suggestion built from code that no longer exists.`,
  sequence: {
    participants: ['Editor', 'Code Assistant', 'Git server'],
    messages: [
      {from: 'Editor', to: 'Code Assistant', label: 'GET /v1/repos/acme/api/index/status · X-Tenant-Id', kind: 'sync'},
      {from: 'Code Assistant', to: 'Code Assistant', label: 'can_read(tenant, repo) → 403', kind: 'sync'},
      {from: 'Code Assistant', to: 'Code Assistant', label: 'GET index:acme:api:head · nil → 404', kind: 'sync'},
      {from: 'Code Assistant', to: 'Git server', label: 'commits_behind(repo, indexed_sha)', kind: 'sync'},
      {from: 'Git server', to: 'Code Assistant', label: 'lag vs the repository head', kind: 'reply'},
      {
        from: 'Code Assistant',
        to: 'Code Assistant',
        label: 'lag > MAX_INDEX_LAG_COMMITS → servable: false',
        kind: 'sync',
      },
      {from: 'Code Assistant', to: 'Editor', label: '200 {commit_sha, symbols, lag, current, servable}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route-and-bound',
      title: 'Registers the status route with a named staleness bound',
      detail:
        'The status route is registered on `GET /v1/repos/{id}/index/status` and the staleness bound is a named constant, `MAX_INDEX_LAG_COMMITS = 10`. The draft has no bound at all, so nothing can be measured against the head.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/repos\/\{id\}\/index\/status["']/, /MAX_INDEX_LAG_COMMITS\s*=\s*10/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/repos\/:id\/index\/status['"]/, /MAX_INDEX_LAG_COMMITS\s*=\s*10/]},
        go: {
          all: [/HandleFunc\(\s*"GET \/v1\/repos\/\{id\}\/index\/status"/, /maxIndexLagCommits\s*=\s*10/],
        },
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"repos"\s*\/\s*Segment\s*\/\s*"index"\s*\/\s*"status"\s*\)/,
            /MaxIndexLagCommits\s*=\s*10/,
          ],
        },
        cpp: {all: [/svr\.Get\(/, /v1\/repos\/.*index\/status/, /kMaxIndexLagCommits\s*=\s*10/]},
      },
    },
    {
      id: 'serve-guard',
      title: 'Enforces the bound on the serve path',
      detail:
        '`assert_index_fresh` is the guard a completion calls before serving symbols, and it compares the lag with `MAX_INDEX_LAG_COMMITS`. The draft has no serve-path guard, so the staleness is only ever a number in a report.',
      match: {
        python: {all: [/def assert_index_fresh\(/, /MAX_INDEX_LAG_COMMITS/]},
        typescript: {all: [/function assertIndexFresh\(/, /MAX_INDEX_LAG_COMMITS/]},
        go: {all: [/func assertIndexFresh\(/, /maxIndexLagCommits/]},
        scala: {all: [/def assertIndexFresh\(/, /MaxIndexLagCommits/]},
        cpp: {all: [/bool assert_index_fresh\(/, /kMaxIndexLagCommits/]},
      },
    },
    {
      id: 'no-force',
      title: 'The caller cannot force a stale index',
      detail:
        'The endpoint reads the path parameter and the tenant header only; there is no `force_stale`/`force` parameter that could skip the freshness check. The draft accepts one and reports the stale index as current when it is present.',
      match: {
        python: {all: [/MAX_INDEX_LAG_COMMITS/], none: [/force/]},
        typescript: {all: [/MAX_INDEX_LAG_COMMITS/], none: [/force/]},
        go: {all: [/maxIndexLagCommits/], none: [/force/]},
        scala: {all: [/MaxIndexLagCommits/], none: [/force/]},
        cpp: {all: [/kMaxIndexLagCommits/], none: [/force/]},
      },
    },
    {
      id: 'lag-vs-head',
      title: 'Computes the lag against the repository head',
      detail:
        'The lag comes from the git log (`commits_behind`) and `current` is true only at `lag == 0`, with `servable` following the bound. The draft reports every existing index as current without ever comparing it with the head.',
      match: {
        python: {all: [/commits_behind\(/, /"current"/]},
        typescript: {all: [/commitsBehind\(/, /current:/]},
        go: {all: [/CommitsBehind\(/, /"current"/]},
        scala: {all: [/commits_behind\(/, /current\s*=\s*lag == 0/]},
        cpp: {all: [/commits_behind\(/, /"current"/]},
      },
    },
    {
      id: 'reported-sha',
      title: 'Reports the sha of the index the serve path uses',
      detail:
        'The reported sha comes from the same `index:{tenant}:{repo}:head` record `assert_index_fresh` reads, so the editor and the completion path cannot disagree about which commit is served. The draft reads an index record keyed by repository alone.',
      match: {
        python: {all: [/head_key\(tenant, repo/, /head\["commit_sha"\]/]},
        typescript: {all: [/headKey\(tenant, repo/, /head\.commit_sha/]},
        go: {all: [/headKey\(tenant, repo/, /head\.CommitSHA/]},
        scala: {all: [/headKey\(tenant, repo/, /head\.commit_sha/]},
        cpp: {all: [/head_key\(tenant, repo/, /head->commit_sha/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/repos/{id}/index/status")
def read_status(
    id: str,
    tenant: str = Header(alias="X-Tenant-Id"),
    force_stale: int = 0,
) -> JSONResponse:
    # TODO: this draft reports every index as current as long as one exists, keeps serving symbols
    # from an index that is hundreds of commits behind, and lets ?force_stale=1 skip the check.
    raw = r.get(f"index:{id}")
    if raw is None:
        return JSONResponse({"repo_id": id, "current": False}, status_code=404)
    index = json.loads(raw)
    return JSONResponse(
        {
            "repo_id": id,
            "commit_sha": index["commit_sha"],
            "symbols": index["symbols"],
            "current": True,
            "forced": bool(force_stale),
        },
        status_code=200,
    )
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_INDEX_LAG_COMMITS = 10
STATUS_TTL_S = 30


class RepoAccess:
    def can_read(self, tenant: str, repo: str) -> bool:
        """Whether the tenant may read the repository."""
        raise NotImplementedError


class GitLog:
    def commits_behind(self, repo: str, indexed_sha: str) -> int:
        """How many commits the repository head is ahead of the indexed commit."""
        raise NotImplementedError


access = RepoAccess()
git = GitLog()


def head_key(tenant: str, repo: str) -> str:
    """The commit the index service currently serves for this repository."""
    return f"index:{tenant}:{repo}:head"


def read_head(tenant: str, repo: str) -> dict:
    raw = r.get(head_key(tenant, repo))
    if raw is None:
        raise HTTPException(status_code=404, detail="repository has no index")
    return json.loads(raw)


def assert_index_fresh(tenant: str, repo: str, commit_sha: str) -> dict:
    """The guard a completion calls: an index more than ten commits behind is never served."""
    head = read_head(tenant, repo)
    if head["commit_sha"] != commit_sha:
        raise HTTPException(status_code=409, detail="index does not describe the requested commit")
    if git.commits_behind(repo, head["commit_sha"]) > MAX_INDEX_LAG_COMMITS:
        raise HTTPException(status_code=409, detail="index is too far behind the repository head")
    return head


@app.get("/v1/repos/{id}/index/status")
def read_status(id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if not access.can_read(tenant, id):
        raise HTTPException(status_code=403, detail="repository is not readable by this tenant")
    head = read_head(tenant, id)
    lag = git.commits_behind(id, head["commit_sha"])
    body = {
        "repo_id": id,
        "commit_sha": head["commit_sha"],
        "symbols": head["symbols"],
        "indexed_at": head["indexed_at"],
        "lag": lag,
        "current": lag == 0,
        "servable": lag <= MAX_INDEX_LAG_COMMITS,
    }
    r.set(f"status:{tenant}:{id}:{head['commit_sha']}", json.dumps(body), ex=STATUS_TTL_S)
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/repos/:id/index/status: a model-generated draft that calls every index current. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface IndexRecord {
  commit_sha: string;
  symbols: number;
}

app.get('/v1/repos/:id/index/status', async (request, reply) => {
  // TODO: this draft reports every index as current as long as one exists, keeps serving symbols
  // from an index that is hundreds of commits behind, and lets ?force_stale=1 skip the check.
  const {id} = request.params as {id: string};
  const forceStale = (request.query as {force_stale?: string}).force_stale === '1';
  const raw = await r.get('index:' + id);
  if (raw === null) return reply.code(404).send({repo_id: id, current: false});
  const index = JSON.parse(raw) as IndexRecord;
  return reply.code(200).send({
    repo_id: id,
    commit_sha: index.commit_sha,
    symbols: index.symbols,
    current: true,
    forced: forceStale,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/repos/:id/index/status: the freshness the editor and the serve path both read. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {access} from './access';
import {git} from './git';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_INDEX_LAG_COMMITS = 10;
const STATUS_TTL_S = 30;

interface Head {
  commit_sha: string;
  symbols: number;
  indexed_at: string;
}

function headKey(tenant: string, repo: string): string {
  return 'index:' + tenant + ':' + repo + ':head';
}

async function readHead(tenant: string, repo: string): Promise<Head | null> {
  const raw = await r.get(headKey(tenant, repo));
  return raw === null ? null : (JSON.parse(raw) as Head);
}

export async function assertIndexFresh(tenant: string, repo: string, commitSha: string): Promise<Head> {
  const head = await readHead(tenant, repo);
  if (head === null) throw new Error('repository has no index');
  if (head.commit_sha !== commitSha) throw new Error('index does not describe the requested commit');
  const lag = await git.commitsBehind(repo, head.commit_sha);
  if (lag > MAX_INDEX_LAG_COMMITS) throw new Error('index is too far behind the repository head');
  return head;
}

app.get('/v1/repos/:id/index/status', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  if (!(await access.canRead(tenant, id)))
    return reply.code(403).send({error: 'repository is not readable by this tenant'});
  const head = await readHead(tenant, id);
  if (head === null) return reply.code(404).send({error: 'repository has no index'});
  const lag = await git.commitsBehind(id, head.commit_sha);
  const body = {
    repo_id: id,
    commit_sha: head.commit_sha,
    symbols: head.symbols,
    indexed_at: head.indexed_at,
    lag,
    current: lag === 0,
    servable: lag <= MAX_INDEX_LAG_COMMITS,
  };
  await r.set('status:' + tenant + ':' + id + ':' + head.commit_sha, JSON.stringify(body), 'EX', STATUS_TTL_S);
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type Head struct {
	CommitSHA string \`json:"commit_sha"\`
	Symbols   int    \`json:"symbols"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func repoStatus(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft reports every index as current as long as one exists, keeps serving symbols
	// from an index that is hundreds of commits behind, and lets ?force_stale=1 skip the check.
	id := r.PathValue("id")
	if r.URL.Query().Get("force_stale") == "1" {
		writeJSON(rw, http.StatusOK, map[string]any{"repo_id": id, "current": true, "forced": true})
		return
	}
	raw, err := rdb.Get(r.Context(), "index:"+id).Result()
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]any{"repo_id": id, "current": false})
		return
	}
	var head Head
	_ = json.Unmarshal([]byte(raw), &head)
	writeJSON(rw, http.StatusOK, map[string]any{
		"repo_id":    id,
		"commit_sha": head.CommitSHA,
		"symbols":    head.Symbols,
		"current":    true,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/repos/{id}/index/status", repoStatus)
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

	"github.com/redis/go-redis/v9"
)

const (
	maxIndexLagCommits = 10
	statusTTLS         = 30
)

var rdb *redis.Client

type Head struct {
	CommitSHA string \`json:"commit_sha"\`
	Symbols   int    \`json:"symbols"\`
	IndexedAt string \`json:"indexed_at"\`
}

type RepoAccess struct{}

func (a *RepoAccess) CanRead(ctx context.Context, tenant, repo string) (bool, error) {
	return false, nil
}

var access = &RepoAccess{}

type GitLog struct{}

func (g *GitLog) CommitsBehind(ctx context.Context, repo, indexedSHA string) (int, error) {
	return 0, nil
}

var git = &GitLog{}

func headKey(tenant, repo string) string {
	return "index:" + tenant + ":" + repo + ":head"
}

func readHead(ctx context.Context, tenant, repo string) (*Head, error) {
	raw, err := rdb.Get(ctx, headKey(tenant, repo)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, errors.New("repository has no index")
	}
	if err != nil {
		return nil, err
	}
	var head Head
	if err := json.Unmarshal([]byte(raw), &head); err != nil {
		return nil, err
	}
	return &head, nil
}

// assertIndexFresh is the guard a completion calls: an index too far behind the head is never served.
func assertIndexFresh(ctx context.Context, tenant, repo, commitSHA string) (*Head, error) {
	head, err := readHead(ctx, tenant, repo)
	if err != nil {
		return nil, err
	}
	if head.CommitSHA != commitSHA {
		return nil, errors.New("index does not describe the requested commit")
	}
	lag, err := git.CommitsBehind(ctx, repo, head.CommitSHA)
	if err != nil {
		return nil, err
	}
	if lag > maxIndexLagCommits {
		return nil, errors.New("index is too far behind the repository head")
	}
	return head, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func repoStatus(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	id := r.PathValue("id")
	allowed, err := access.CanRead(r.Context(), tenant, id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !allowed {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "repository is not readable by this tenant"})
		return
	}
	head, err := readHead(r.Context(), tenant, id)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "repository has no index"})
		return
	}
	lag, err := git.CommitsBehind(r.Context(), id, head.CommitSHA)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"repo_id":    id,
		"commit_sha": head.CommitSHA,
		"symbols":    head.Symbols,
		"indexed_at": head.IndexedAt,
		"lag":        lag,
		"current":    lag == 0,
		"servable":   lag <= maxIndexLagCommits,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/repos/{id}/index/status", repoStatus)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import spray.json._

final case class Head(commit_sha: String, symbols: Int)

object StatusApi {
  implicit val system: ActorSystem = ActorSystem("code-assistant")
  implicit val headFormat: RootJsonFormat[Head] = jsonFormat2(Head)

  val r = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "repos" / Segment / "index" / "status") { id =>
      get {
        parameter("force_stale".?) { forced =>
          // TODO: this draft reports every index as current as long as one exists, keeps serving
          // symbols from an index that is hundreds of commits behind, and lets ?force_stale=1 skip
          // the check.
          Option(r.get(s"index:$id")) match {
            case None =>
              complete(StatusCodes.NotFound, s"""{"repo_id":"$id","current":false}""")
            case Some(raw) =>
              val head = raw.parseJson.convertTo[Head]
              complete(
                StatusCodes.OK,
                s"""{"repo_id":"$id","commit_sha":"\${head.commit_sha}","symbols":\${head.symbols},"current":true,"forced":\${forced.isDefined}}"""
              )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import spray.json._

final case class Head(commit_sha: String, symbols: Int, indexed_at: String)
final case class IndexStatus(
    repo_id: String,
    commit_sha: String,
    symbols: Int,
    indexed_at: String,
    lag: Int,
    current: Boolean,
    servable: Boolean
)

object RepoAccess {
  def can_read(tenant: String, repo: String): Boolean = ???
}

object GitLog {
  def commits_behind(repo: String, indexedSha: String): Int = ???
}

object StatusApi {
  implicit val system: ActorSystem = ActorSystem("code-assistant")
  implicit val headFormat: RootJsonFormat[Head] = jsonFormat3(Head)
  implicit val statusFormat: RootJsonFormat[IndexStatus] = jsonFormat7(IndexStatus)

  val MaxIndexLagCommits = 10
  val access = RepoAccess
  val git = GitLog
  val r = new Jedis("redis", 6379)

  def headKey(tenant: String, repo: String): String = s"index:$tenant:$repo:head"

  def readHead(tenant: String, repo: String): Option[Head] =
    Option(r.get(headKey(tenant, repo))).map(_.parseJson.convertTo[Head])

  /** The guard a completion calls: an index more than ten commits behind the head is never served. */
  def assertIndexFresh(tenant: String, repo: String, commitSha: String): Either[String, Head] =
    readHead(tenant, repo) match {
      case None => Left("repository has no index")
      case Some(head) =>
        if (head.commit_sha != commitSha) Left("index does not describe the requested commit")
        else {
          val lag = git.commits_behind(repo, head.commit_sha)
          if (lag > MaxIndexLagCommits) Left("index is too far behind the repository head") else Right(head)
        }
    }

  val route: Route =
    path("v1" / "repos" / Segment / "index" / "status") { id =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else if (!access.can_read(tenantOpt.get, id)) {
            complete(StatusCodes.Forbidden, """{"error":"repository is not readable by this tenant"}""")
          } else {
            val tenant = tenantOpt.get
            readHead(tenant, id) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"repository has no index"}""")
              case Some(head) =>
                val lag = git.commits_behind(id, head.commit_sha)
                val status = IndexStatus(
                  repo_id = id,
                  commit_sha = head.commit_sha,
                  symbols = head.symbols,
                  indexed_at = head.indexed_at,
                  lag = lag,
                  current = lag == 0,
                  servable = lag <= MaxIndexLagCommits
                )
                complete(StatusCodes.OK, status.toJson.compactPrint)
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

struct Head {
  std::string commit_sha;
  int symbols = 0;
};

void from_json(const json& in, Head& head) {
  head.commit_sha = in.value("commit_sha", std::string());
  head.symbols = in.value("symbols", 0);
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/repos/([^/]+)/index/status)", [&redis](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports every index as current as long as one exists, keeps serving symbols
    // from an index that is hundreds of commits behind, and lets ?force_stale=1 skip the check.
    const auto id = req.matches[1].str();
    if (req.has_param("force_stale")) {
      res.status = 200;
      res.set_content(
          json{{"repo_id", id}, {"current", true}, {"forced", true}}.dump(), "application/json");
      return;
    }
    auto raw = redis.get("index:" + id);
    if (!raw) {
      res.status = 404;
      res.set_content(json{{"repo_id", id}, {"current", false}}.dump(), "application/json");
      return;
    }
    const auto head = json::parse(*raw, nullptr, false).get<Head>();
    res.status = 200;
    res.set_content(json{{"repo_id", id},
                         {"commit_sha", head.commit_sha},
                         {"symbols", head.symbols},
                         {"current", true}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxIndexLagCommits = 10;
constexpr long long kStatusTTLS = 30;

struct Head {
  std::string commit_sha;
  int symbols = 0;
  std::string indexed_at;
};

void to_json(json& out, const Head& head) {
  out = json{{"commit_sha", head.commit_sha}, {"symbols", head.symbols}, {"indexed_at", head.indexed_at}};
}

void from_json(const json& in, Head& head) {
  head.commit_sha = in.value("commit_sha", std::string());
  head.symbols = in.value("symbols", 0);
  head.indexed_at = in.value("indexed_at", std::string());
}

bool access_can_read(const std::string& tenant, const std::string& repo);
int commits_behind(const std::string& repo, const std::string& indexedSha);

std::string head_key(const std::string& tenant, const std::string& repo) {
  return "index:" + tenant + ":" + repo + ":head";
}

std::optional<Head> read_head(sw::redis::Redis& redis, const std::string& tenant, const std::string& repo) {
  auto raw = redis.get(head_key(tenant, repo));
  if (!raw) return std::nullopt;
  const auto parsed = json::parse(*raw, nullptr, false);
  if (!parsed.is_object()) return std::nullopt;
  return parsed.get<Head>();
}

/** The guard a completion calls: an index more than kMaxIndexLagCommits behind the head is refused. */
bool assert_index_fresh(sw::redis::Redis& redis, const std::string& tenant, const std::string& repo,
                        const std::string& commitSha) {
  const auto head = read_head(redis, tenant, repo);
  if (!head || head->commit_sha != commitSha) return false;
  return commits_behind(repo, head->commit_sha) <= kMaxIndexLagCommits;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/repos/([^/]+)/index/status)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto id = req.matches[1].str();
    if (!access_can_read(tenant, id)) {
      res.status = 403;
      res.set_content(R"({"error":"repository is not readable by this tenant"})", "application/json");
      return;
    }
    const auto head = read_head(redis, tenant, id);
    if (!head) {
      res.status = 404;
      res.set_content(R"({"error":"repository has no index"})", "application/json");
      return;
    }
    const int lag = commits_behind(id, head->commit_sha);
    const json body = {
        {"repo_id", id},
        {"commit_sha", head->commit_sha},
        {"symbols", head->symbols},
        {"indexed_at", head->indexed_at},
        {"lag", lag},
        {"current", lag == 0},
        {"servable", lag <= kMaxIndexLagCommits},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Report what is served, not what would be nice: read the `index:{tenant}:{repo}:head` record the serve path reads, and compute the lag against the repository head with `commits_behind`. `current` is `lag == 0`; `servable` is the bound; a repository with no head record is a `404`, not a green tick.',
    'The bound has to exist on the serve path too. `assert_index_fresh(tenant, repo, commit_sha)` is the function a completion calls before it serves symbols — it takes the saw and the bound and refuses both a mismatched commit and an index more than ten commits behind, so the status is a report of a rule rather than the rule itself.',
    'Do not accept a parameter that changes the answer: a `force`/`force_stale` query argument is the caller choosing to be lied to, and once it exists it will be used by a client that wants the fast path. The endpoint reads the path parameter and the tenant header only, and the constant lives in the service.',
  ],
  debrief: `The interview question is what makes a freshness signal trustworthy: it has to measure the head, it has to be the same measurement the serve path uses, and it must not have an off switch. The draft answers the first two loosely and fails the third outright. The lag against the head is the only honest definition of "current" — an index that exists is not an index that is current, and one commit behind is already a suggestion made from code that no longer exists. Sharing the head record and the guard between the status endpoint and the completion path is what keeps the editor's green tick and the served symbols from ever disagreeing. And a caller-supplied bypass is how a correctness rule silently becomes an option: real platforms gate the equivalent behaviour on an operator flag with an audit trail, or better, do not offer it. Real assistants add a background re-index trigger when the lag passes a threshold, report the lag as a metric so degraded indexing is visible before a developer notices the suggestions are stale, and serve the freshest commit that is inside the bound instead of refusing outright when they can.`,
};
