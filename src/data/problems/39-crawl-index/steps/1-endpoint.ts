import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/crawl/targets: a target that passes robots and host policy',
  concept: 'http',
  file: 'api',
  focus: ['client', 'crawler', 'registry', 'robots'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it takes a URL, fetches it and
registers a target, so the demo crawls the one host it was pointed at. It trusts the caller with the
whole internet. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/crawl/targets\` with body
\`{"job_id": "nightly", "url": "https://blog.example.com/posts", "rate_per_minute": 30}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- Only \`http\` and \`https\` targets are accepted (**400** otherwise) — \`file://\`, \`ftp://\` and
  \`gopher://\` are how a crawler is pointed at something that is not a web page.
- The host must be on the \`ALLOWED_HOSTS\` allowlist and must not be an **internal address**
  (\`localhost\`, \`*.internal\`, \`*.local\`, loopback, private and link-local IP literals):
  **400**, and the rejection happens **before any fetch** — the target is refused, the network is
  never touched. The draft fetches whatever URL it is handed, which is how a crawler becomes the
  comfortable way into the cluster's metadata service.
- The host's **robots rules** are fetched before the target is accepted. If the URL's path is
  disallowed, answer **403** with the matching rule quoted in the body
  (\`disallowed by robots: /private\`). Rules are the \`Disallow\` prefixes; \`*\` means everything.
- The target is only enqueued **after** the policy and robots checks pass, and registration is
  **idempotent per \`(job_id, url)\`**: a replayed registration returns the original
  \`target_id\` instead of inserting a second copy. The draft inserts unconditionally, so a client
  retry doubles the frontier.

**Failure mode the checks target.** Fetching before validating is the SSRF hole: the draft resolves
whatever the caller sent, including \`http://169.254.169.254/latest/meta-data/\`. Skipping robots
makes the crawler a bad citizen on the first request. Inserting without a lookup means every retry
duplicates work the frontier then has to discover and deduplicate.`,
  sequence: {
    participants: ['Client', 'Crawl service', 'target registry', 'robots.txt'],
    messages: [
      {from: 'Client', to: 'Crawl service', label: 'POST /v1/crawl/targets · {job_id, url}', kind: 'sync'},
      {
        from: 'Crawl service',
        to: 'Crawl service',
        label: 'scheme · allowlist · internal address — before any fetch',
        kind: 'sync',
      },
      {from: 'Crawl service', to: 'target registry', label: 'find(job_id, url)', kind: 'sync'},
      {from: 'target registry', to: 'Crawl service', label: 'target / none', kind: 'reply'},
      {from: 'Crawl service', to: 'robots.txt', label: 'GET /robots.txt', kind: 'sync'},
      {from: 'robots.txt', to: 'Crawl service', label: 'Disallow rules', kind: 'reply'},
      {from: 'Crawl service', to: 'Crawl service', label: '403 + the quoted rule when disallowed', kind: 'sync'},
      {from: 'Crawl service', to: 'target registry', label: 'insert(job_id, url) once accepted', kind: 'async'},
      {from: 'Crawl service', to: 'Client', label: '200 {target_id, status}', kind: 'reply'},
    ],
  },
  hints: [
    'Order the guards by cost: tenant, scheme, host shape, allowlist, then the network. Parse the URL once and keep the parsed host and path — re-parsing the raw string in every guard is how a check and a fetch end up looking at different things.',
    'An internal address is more than `localhost`: check the `.internal`/`.local` suffixes, and parse IP literals so `10.x`, `172.16–31.x`, `192.168.x`, `127.x`, `169.254.x`, `::1`, `fc00::/7` and `fe80::/10` are all rejected. The allowlist does that for you too — a host that is not on it never gets fetched — but the explicit check is what the reviewer looks for.',
    'Register under `(job_id, url)`: look the target up first and return its stored id on a replay, then fetch robots, then insert. A `robots.txt` the host does not serve is not permission to crawl everything; treat an unreachable rules file as deny-all.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/crawl/targets',
      detail: 'Register the target route on `POST /v1/crawl/targets`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/crawl\/targets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/crawl\/targets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/crawl\/targets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"crawl"\s*\/\s*"targets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/crawl\/targets"/]},
      },
    },
    {
      id: 'host-policy',
      title: 'Validates the scheme and the host allowlist',
      detail:
        'Only `http` and `https` are accepted, the host must be on `ALLOWED_HOSTS`, and an internal host is rejected with **400**. The draft accepts any absolute URL and fetches it.',
      match: {
        python: {all: [/ALLOWED_SCHEMES/, /ALLOWED_HOSTS/, /is_internal_host\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_SCHEMES/, /ALLOWED_HOSTS/, /isInternalHost\(/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedSchemes/, /allowedHosts/, /isInternalHost\(/, /StatusBadRequest/]},
        scala: {all: [/AllowedSchemes/, /AllowedHosts/, /isInternalHost\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedSchemes/, /kAllowedHosts/, /isInternalHost\(/, /\b400\b/]},
      },
    },
    {
      id: 'reject-before-fetch',
      title: 'Refuses an internal address before any fetch',
      detail:
        'The internal-address guard is reached before the robots fetch, so a rejected target never triggers a network call. The draft fetches the caller’s URL first and asks questions later.',
      match: {
        python: {order: [/is_internal_host\(/, /fetch_robots\(/]},
        typescript: {order: [/isInternalHost\(/, /fetchRobots\(/]},
        go: {order: [/isInternalHost\(/, /fetchRobots\(/]},
        scala: {order: [/isInternalHost\(/, /fetchRobots\(/]},
        cpp: {order: [/isInternalHost\(/, /fetchRobots\(/]},
      },
    },
    {
      id: 'robots',
      title: 'Fetches robots rules and quotes the matching Disallow rule',
      detail:
        'The target’s robots rules are fetched before acceptance and a disallowed path is **403** with the rule quoted. The draft never reads `robots.txt` at all.',
      match: {
        python: {all: [/fetch_robots\(/, /robots/, /status_code\s*=\s*403/]},
        typescript: {all: [/fetchRobots\(/, /robots/, /code\(\s*403\s*\)/]},
        go: {all: [/fetchRobots\(/, /robots/, /StatusForbidden/]},
        scala: {all: [/fetchRobots\(/, /robots/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/fetchRobots\(/, /robots/, /\b403\b/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Registration is idempotent per (job_id, url)',
      detail:
        'The registry is looked up before the insert and a replay returns the stored `target_id`. The draft inserts unconditionally, so a retried registration doubles the frontier.',
      match: {
        python: {
          all: [/targets\.find\(/, /targets\.insert\(/, /target_id/],
          order: [/targets\.find\(/, /targets\.insert\(/],
        },
        typescript: {
          all: [/targets\.find\(/, /targets\.insert\(/, /target_id/],
          order: [/targets\.find\(/, /targets\.insert\(/],
        },
        go: {
          all: [/targets\.Find\(/, /targets\.Insert\(/, /target_id|TargetID/],
          order: [/targets\.Find\(/, /targets\.Insert\(/],
        },
        scala: {
          all: [/targets\.find\(/, /targets\.insert\(/, /target_id/],
          order: [/targets\.find\(/, /targets\.insert\(/],
        },
        cpp: {
          all: [/targets\.find\(/, /targets\.insert\(/, /target_id/],
          order: [/targets\.find\(/, /targets\.insert\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()


class TargetRequest(BaseModel):
    job_id: str
    url: str
    rate_per_minute: int = 30


class TargetStore:
    def insert(self, job_id: str, url: str) -> dict:
        """Register a new target; the frontier enqueues it exactly once."""
        raise NotImplementedError


targets = TargetStore()


def fetch_page(url: str) -> str:
    """Fetch a URL and return its body."""
    raise NotImplementedError


@app.post("/v1/crawl/targets")
def register(body: TargetRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft fetches any URL the caller sends - including http://169.254.169.254/ and
    # internal hostnames - skips robots.txt entirely, and inserts the same target twice so the
    # frontier doubles. Validate the scheme and host before any fetch, fetch the robots rules
    # before accepting the target, and return the original target id on a replay.
    fetch_page(body.url)
    target = targets.insert(body.job_id, body.url)
    return {"target_id": target["target_id"], "status": "accepted"}
`,
      solution: `import ipaddress
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

ALLOWED_SCHEMES = {"http", "https"}
ALLOWED_HOSTS = {"blog.example.com", "docs.example.com", "example.com"}
INTERNAL_SUFFIXES = (".internal", ".local", ".svc", ".cluster.local")
ROBOTS_TIMEOUT_S = 5.0


class TargetRequest(BaseModel):
    job_id: str
    url: str
    rate_per_minute: int = 30


class TargetStore:
    def find(self, job_id: str, url: str) -> dict | None:
        """The target already registered for (job_id, url), if any."""
        raise NotImplementedError

    def insert(self, job_id: str, url: str) -> dict:
        """Register a new target; the frontier enqueues it exactly once."""
        raise NotImplementedError


targets = TargetStore()


def is_internal_host(host: str) -> bool:
    if host == "localhost" or host.endswith(INTERNAL_SUFFIXES):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


def checked_url(raw: str) -> tuple[str, str, str]:
    """The host and path of a target that survives policy; raises 400 for anything else."""
    parts = urlsplit(raw)
    if parts.scheme not in ALLOWED_SCHEMES:
        raise HTTPException(status_code=400, detail="only http and https targets are accepted")
    host = (parts.hostname or "").lower()
    if host == "" or is_internal_host(host) or host not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail="host is not on the crawl allowlist")
    return host, parts.path or "/", raw


def fetch_robots(host: str) -> list[str]:
    """The Disallow rules the host publishes; an unreachable robots.txt denies everything."""
    response = httpx.get(f"https://{host}/robots.txt", timeout=ROBOTS_TIMEOUT_S)
    if response.status_code != 200:
        return ["*"]
    rules = []
    for line in response.text.splitlines():
        field, sep, value = line.partition(":")
        if sep and field.strip().lower() == "disallow":
            rules.append(value.strip())
    return rules


def robots_denied(rules: list[str], path: str) -> str | None:
    """The first Disallow rule that covers path, so the refusal can quote it."""
    for rule in rules:
        if rule in ("", "*"):
            continue
        if path.startswith(rule.rstrip("*")):
            return rule
    return None


@app.post("/v1/crawl/targets")
def register(body: TargetRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    host, path, url = checked_url(body.url)
    existing = targets.find(body.job_id, url)
    if existing is not None:
        return {"target_id": existing["target_id"], "status": "accepted"}
    denied = robots_denied(fetch_robots(host), path)
    if denied is not None:
        raise HTTPException(status_code=403, detail=f"disallowed by robots: {denied}")
    target = targets.insert(body.job_id, url)
    return {"target_id": target["target_id"], "status": "accepted"}
`,
    },
    typescript: {
      starter: `/** POST /v1/crawl/targets: a model-generated draft that fetches whatever it is sent. */
import Fastify from 'fastify';

export const app = Fastify();

interface TargetBody {
  job_id: string;
  url: string;
  rate_per_minute?: number;
}

interface Target {
  target_id: string;
  job_id: string;
  url: string;
}

export const targets = {
  async insert(jobId: string, url: string): Promise<Target> {
    void jobId;
    void url;
    throw new Error('TargetStore.insert is not implemented');
  },
};

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

app.post('/v1/crawl/targets', async (request, reply) => {
  // TODO: this draft fetches any URL the caller sends - including http://169.254.169.254/ and
  // internal hostnames - skips robots.txt entirely, and inserts the same target twice so the
  // frontier doubles. Validate the scheme and host before any fetch, fetch the robots rules
  // before accepting the target, and return the original target id on a replay.
  const body = request.body as TargetBody;
  await fetchPage(body.url);
  const target = await targets.insert(body.job_id, body.url);
  return reply.code(200).send({target_id: target.target_id, status: 'accepted'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/crawl/targets: validated, robots-checked and idempotent registration. */
import {isIP} from 'node:net';

import Fastify from 'fastify';

export const app = Fastify();

const ALLOWED_SCHEMES: Record<string, true> = {http: true, https: true};
const ALLOWED_HOSTS: Record<string, true> = {'blog.example.com': true, 'docs.example.com': true, 'example.com': true};
const INTERNAL_SUFFIXES = ['.internal', '.local', '.svc', '.cluster.local'];
const ROBOTS_TIMEOUT_MS = 5000;

interface TargetBody {
  job_id: string;
  url: string;
  rate_per_minute?: number;
}

interface Target {
  target_id: string;
  job_id: string;
  url: string;
}

export const targets = {
  async find(jobId: string, url: string): Promise<Target | null> {
    void jobId;
    void url;
    throw new Error('TargetStore.find is not implemented');
  },
  async insert(jobId: string, url: string): Promise<Target> {
    void jobId;
    void url;
    throw new Error('TargetStore.insert is not implemented');
  },
};

function isInternalHost(host: string): boolean {
  if (host === 'localhost' || INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) return host === '::1' || /^(fc|fd|fe80)/.test(host);
  return false;
}

async function fetchRobots(host: string): Promise<string[]> {
  const response = await fetch('https://' + host + '/robots.txt', {signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS)});
  if (response.status !== 200) return ['*'];
  return (await response.text())
    .split('\\n')
    .map(line => line.trim())
    .filter(line => line.toLowerCase().startsWith('disallow:'))
    .map(line => line.slice(line.indexOf(':') + 1).trim());
}

function robotsDenied(rules: string[], path: string): string | null {
  for (const rule of rules) {
    if (rule === '' || rule === '*') continue;
    if (path.startsWith(rule.replace(/\\*+$/, ''))) return rule;
  }
  return null;
}

app.post('/v1/crawl/targets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Partial<TargetBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.job_id !== 'string' || typeof body.url !== 'string')
    return reply.code(400).send({error: 'job_id and url are required'});
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return reply.code(400).send({error: 'url is not absolute'});
  }
  if (ALLOWED_SCHEMES[parsed.protocol.replace(':', '')] !== true)
    return reply.code(400).send({error: 'only http and https targets are accepted'});
  const host = parsed.hostname.toLowerCase();
  if (host === '' || isInternalHost(host) || ALLOWED_HOSTS[host] !== true)
    return reply.code(400).send({error: 'host is not on the crawl allowlist'});
  const existing = await targets.find(body.job_id, body.url);
  if (existing !== null) return reply.code(200).send({target_id: existing.target_id, status: 'accepted'});
  const denied = robotsDenied(await fetchRobots(host), parsed.pathname);
  if (denied !== null) return reply.code(403).send({error: 'disallowed by robots: ' + denied});
  const target = await targets.insert(body.job_id, body.url);
  return reply.code(200).send({target_id: target.target_id, status: 'accepted'});
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
)

type TargetRequest struct {
	JobID         string \`json:"job_id"\`
	URL           string \`json:"url"\`
	RatePerMinute int    \`json:"rate_per_minute"\`
}

type Target struct {
	TargetID string \`json:"target_id"\`
	JobID    string \`json:"job_id"\`
	URL      string \`json:"url"\`
}

type TargetStore struct{}

func (s *TargetStore) Insert(jobID, rawURL string) (*Target, error) {
	return &Target{TargetID: "t-1", JobID: jobID, URL: rawURL}, nil
}

var targets = &TargetStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func fetchPage(rawURL string) (int, error) {
	resp, err := http.Get(rawURL)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

func registerTarget(rw http.ResponseWriter, r *http.Request) {
	var body TargetRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft fetches any URL the caller sends - including http://169.254.169.254/ and
	// internal hostnames - skips robots.txt entirely, and inserts the same target twice so the
	// frontier doubles. Validate the scheme and host before any fetch, fetch the robots rules
	// before accepting the target, and return the original target id on a replay.
	if _, err := fetchPage(body.URL); err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "seed fetch failed"})
		return
	}
	target, err := targets.Insert(body.JobID, body.URL)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"target_id": target.TargetID, "status": "accepted"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/crawl/targets", registerTarget)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const robotsTimeout = 5 * time.Second

var allowedSchemes = map[string]bool{"http": true, "https": true}

var allowedHosts = map[string]bool{"blog.example.com": true, "docs.example.com": true, "example.com": true}

var internalSuffixes = []string{".internal", ".local", ".svc", ".cluster.local"}

type TargetRequest struct {
	JobID         string \`json:"job_id"\`
	URL           string \`json:"url"\`
	RatePerMinute int    \`json:"rate_per_minute"\`
}

type Target struct {
	TargetID string \`json:"target_id"\`
	JobID    string \`json:"job_id"\`
	URL      string \`json:"url"\`
}

type TargetStore struct{}

func (s *TargetStore) Find(jobID, rawURL string) (*Target, error) {
	return nil, nil
}

func (s *TargetStore) Insert(jobID, rawURL string) (*Target, error) {
	return &Target{TargetID: "t-1", JobID: jobID, URL: rawURL}, nil
}

var targets = &TargetStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func isInternalHost(host string) bool {
	if host == "localhost" {
		return true
	}
	for _, suffix := range internalSuffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
}

func checkedURL(rawURL string) (*url.URL, string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, "", errors.New("url is not absolute")
	}
	if !allowedSchemes[parsed.Scheme] {
		return nil, "", errors.New("only http and https targets are accepted")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" || isInternalHost(host) || !allowedHosts[host] {
		return nil, "", errors.New("host is not on the crawl allowlist")
	}
	return parsed, host, nil
}

func fetchRobots(host string) []string {
	client := &http.Client{Timeout: robotsTimeout}
	resp, err := client.Get("https://" + host + "/robots.txt")
	if err != nil {
		return []string{"*"}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return []string{"*"}
	}
	var rules []string
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "disallow:") {
			rules = append(rules, strings.TrimSpace(line[len("disallow:"):]))
		}
	}
	return rules
}

func robotsDenied(rules []string, path string) string {
	for _, rule := range rules {
		if rule == "" || rule == "*" {
			continue
		}
		if strings.HasPrefix(path, strings.TrimRight(rule, "*")) {
			return rule
		}
	}
	return ""
}

func registerTarget(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body TargetRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.JobID == "" || body.URL == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "job_id and url are required"})
		return
	}
	parsed, host, problem := checkedURL(body.URL)
	if problem != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": problem.Error()})
		return
	}
	existing, err := targets.Find(body.JobID, body.URL)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		writeJSON(rw, http.StatusOK, map[string]any{"target_id": existing.TargetID, "status": "accepted"})
		return
	}
	if denied := robotsDenied(fetchRobots(host), parsed.Path); denied != "" {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "disallowed by robots: " + denied})
		return
	}
	target, err := targets.Insert(body.JobID, body.URL)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"target_id": target.TargetID, "status": "accepted"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/crawl/targets", registerTarget)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TargetRequest(job_id: String, url: String, rate_per_minute: Int = 30)
final case class Target(target_id: String, job_id: String, url: String)

object CrawlApi {
  implicit val system: ActorSystem = ActorSystem("crawl-index")
  implicit val requestFormat: RootJsonFormat[TargetRequest] = jsonFormat3(TargetRequest)
  implicit val targetFormat: RootJsonFormat[Target] = jsonFormat3(Target)

  val targets = TargetStore.open()

  def fetchPage(url: String): String = {
    val source = scala.io.Source.fromURL(url, "UTF-8")
    try source.mkString
    finally source.close()
  }

  val route: Route =
    path("v1" / "crawl" / "targets") {
      post {
        headerValueByName("X-Tenant-Id") { _ =>
          entity(as[TargetRequest]) { body =>
            // TODO: this draft fetches any URL the caller sends - including
            // http://169.254.169.254/ and internal hostnames - skips robots.txt entirely, and
            // inserts the same target twice so the frontier doubles. Validate the scheme and host
            // before any fetch, fetch the robots rules before accepting the target, and return
            // the original target id on a replay.
            fetchPage(body.url)
            val target = targets.insert(body.job_id, body.url)
            complete(StatusCodes.OK, s"""{"target_id":"\${target.target_id}","status":"accepted"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.net.{InetAddress, URI}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TargetRequest(job_id: String, url: String, rate_per_minute: Int = 30)
final case class Target(target_id: String, job_id: String, url: String)

object CrawlApi {
  implicit val system: ActorSystem = ActorSystem("crawl-index")
  implicit val requestFormat: RootJsonFormat[TargetRequest] = jsonFormat3(TargetRequest)
  implicit val targetFormat: RootJsonFormat[Target] = jsonFormat3(Target)

  val AllowedSchemes = Set("http", "https")
  val AllowedHosts = Set("blog.example.com", "docs.example.com", "example.com")
  val InternalSuffixes = List(".internal", ".local", ".svc", ".cluster.local")

  val targets = TargetStore.open()

  def isInternalHost(host: String): Boolean =
    host == "localhost" ||
      InternalSuffixes.exists(host.endsWith) ||
      (try {
        val address = InetAddress.getByName(host)
        address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress
      } catch {
        case _: Exception => false
      })

  def checkedUrl(raw: String): Either[String, (String, String)] =
    try {
      val uri = new URI(raw)
      val scheme = Option(uri.getScheme).map(_.toLowerCase).getOrElse("")
      val host = Option(uri.getHost).map(_.toLowerCase).getOrElse("")
      val path = Option(uri.getPath).filter(_.nonEmpty).getOrElse("/")
      if (!AllowedSchemes.contains(scheme)) Left("only http and https targets are accepted")
      else if (host.isEmpty || isInternalHost(host) || !AllowedHosts.contains(host))
        Left("host is not on the crawl allowlist")
      else Right((host, path))
    } catch {
      case _: Exception => Left("url is not absolute")
    }

  def fetchRobots(host: String): List[String] = {
    val source =
      try scala.io.Source.fromURL(s"https://$host/robots.txt", "UTF-8")
      catch { case _: Exception => null }
    if (source == null) return List("*")
    try
      source.getLines().toList
        .map(_.trim)
        .filter(_.toLowerCase.startsWith("disallow:"))
        .map(_.drop("disallow:".length).trim)
    finally source.close()
  }

  def robotsDenied(rules: List[String], path: String): Option[String] =
    rules.filter(rule => rule.nonEmpty && rule != "*").find(rule => path.startsWith(rule.reverse.dropWhile(_ == '*').reverse))

  val route: Route =
    path("v1" / "crawl" / "targets") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[TargetRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              checkedUrl(body.url) match {
                case Left(problem) =>
                  complete(StatusCodes.BadRequest, s"""{"error":"$problem"}""")
                case Right((host, path)) =>
                  targets.find(body.job_id, body.url) match {
                    case Some(existing) =>
                      complete(StatusCodes.OK, s"""{"target_id":"\${existing.target_id}","status":"accepted"}""")
                    case None =>
                      robotsDenied(fetchRobots(host), path) match {
                        case Some(rule) =>
                          complete(
                            StatusCodes.Forbidden,
                            s"""{"error":"disallowed by robots: $rule"}"""
                          )
                        case None =>
                          val target = targets.insert(body.job_id, body.url)
                          complete(StatusCodes.OK, s"""{"target_id":"\${target.target_id}","status":"accepted"}""")
                      }
                  }
              }
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct Target {
  std::string target_id;
  std::string job_id;
  std::string url;
};

struct TargetStore {
  Target insert(const std::string& jobId, const std::string& rawUrl);
};

TargetStore targets;

std::string fetchPage(const std::string& rawUrl) {
  const auto pos = rawUrl.find("://");
  const auto hostEnd = rawUrl.find('/', pos + 3);
  httplib::Client client(rawUrl.substr(0, hostEnd));
  const auto response = client.Get(rawUrl.substr(hostEnd));
  return response ? response->body : std::string();
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/crawl/targets", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("url")) {
      res.status = 400;
      res.set_content(R"({"error":"job_id and url are required"})", "application/json");
      return;
    }
    // TODO: this draft fetches any URL the caller sends - including http://169.254.169.254/ and
    // internal hostnames - skips robots.txt entirely, and inserts the same target twice so the
    // frontier doubles. Validate the scheme and host before any fetch, fetch the robots rules
    // before accepting the target, and return the original target id on a replay.
    const auto rawUrl = body["url"].get<std::string>();
    fetchPage(rawUrl);
    const auto target = targets.insert(body.value("job_id", std::string()), rawUrl);
    res.status = 200;
    res.set_content(json{{"target_id", target.target_id}, {"status", "accepted"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::set<std::string> kAllowedSchemes = {"http", "https"};
const std::set<std::string> kAllowedHosts = {"blog.example.com", "docs.example.com", "example.com"};
const std::vector<std::string> kInternalSuffixes = {".internal", ".local", ".svc", ".cluster.local"};

struct Target {
  std::string target_id;
  std::string job_id;
  std::string url;
};

struct TargetStore {
  std::optional<Target> find(const std::string& jobId, const std::string& rawUrl);
  Target insert(const std::string& jobId, const std::string& rawUrl);
};

TargetStore targets;

struct ParsedUrl {
  std::string scheme;
  std::string host;
  std::string path;
  bool ok = false;
};

ParsedUrl parseUrl(const std::string& raw) {
  ParsedUrl parsed;
  const auto schemeEnd = raw.find("://");
  if (schemeEnd == std::string::npos) return parsed;
  parsed.scheme = raw.substr(0, schemeEnd);
  const auto hostStart = schemeEnd + 3;
  const auto pathStart = raw.find('/', hostStart);
  parsed.host = raw.substr(hostStart, pathStart == std::string::npos ? std::string::npos : pathStart - hostStart);
  parsed.path = pathStart == std::string::npos ? "/" : raw.substr(pathStart);
  for (auto& c : parsed.host) c = static_cast<char>(::tolower(c));
  parsed.ok = !parsed.host.empty();
  return parsed;
}

bool isInternalHost(const std::string& host) {
  if (host == "localhost") return true;
  for (const auto& suffix : kInternalSuffixes) {
    if (host.size() >= suffix.size() && host.compare(host.size() - suffix.size(), suffix.size(), suffix) == 0)
      return true;
  }
  if (host == "::1" || host.rfind("fc", 0) == 0 || host.rfind("fd", 0) == 0 || host.rfind("fe80", 0) == 0)
    return true;
  if (host.rfind("10.", 0) == 0 || host.rfind("127.", 0) == 0 || host.rfind("192.168.", 0) == 0 ||
      host.rfind("169.254.", 0) == 0)
    return true;
  if (host.rfind("172.", 0) == 0) {
    const int second = std::atoi(host.substr(4, host.find('.', 4) - 4).c_str());
    return second >= 16 && second <= 31;
  }
  return false;
}

std::string fetchRobots(const std::string& host) {
  httplib::Client client("https://" + host);
  client.set_connection_timeout(5, 0);
  const auto response = client.Get("/robots.txt");
  if (!response || response->status != 200) return "*";
  std::string rules;
  std::size_t pos = 0;
  while (pos <= response->body.size()) {
    const auto end = response->body.find('\\n', pos);
    auto line = response->body.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
    const auto colon = line.find(':');
    if (colon != std::string::npos) {
      auto field = line.substr(0, colon);
      for (auto& c : field) c = static_cast<char>(::tolower(c));
      if (field == "disallow") rules += "\\n" + line.substr(colon + 1);
    }
    if (end == std::string::npos) break;
    pos = end + 1;
  }
  return rules;
}

std::string robotsDenied(const std::string& rules, const std::string& path) {
  std::size_t pos = 0;
  while (pos <= rules.size()) {
    const auto end = rules.find('\\n', pos);
    auto rule = rules.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
    while (!rule.empty() && (rule.front() == ' ' || rule.front() == '\\t' || rule.front() == '\\r')) rule.erase(rule.begin());
    while (!rule.empty() && rule.back() == '*') rule.pop_back();
    if (!rule.empty() && rule != "*" && path.rfind(rule, 0) == 0) return rule;
    if (end == std::string::npos) break;
    pos = end + 1;
  }
  return "";
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/crawl/targets", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("url") || !body["url"].is_string() || !body.contains("job_id")) {
      res.status = 400;
      res.set_content(R"({"error":"job_id and url are required"})", "application/json");
      return;
    }
    const auto rawUrl = body["url"].get<std::string>();
    const auto jobId = body["job_id"].get<std::string>();
    const auto parsed = parseUrl(rawUrl);
    if (!parsed.ok) {
      res.status = 400;
      res.set_content(R"({"error":"url is not absolute"})", "application/json");
      return;
    }
    if (kAllowedSchemes.count(parsed.scheme) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"only http and https targets are accepted"})", "application/json");
      return;
    }
    if (isInternalHost(parsed.host) || kAllowedHosts.count(parsed.host) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"host is not on the crawl allowlist"})", "application/json");
      return;
    }
    if (const auto existing = targets.find(jobId, rawUrl)) {
      res.status = 200;
      res.set_content(json{{"target_id", existing->target_id}, {"status", "accepted"}}.dump(), "application/json");
      return;
    }
    const auto denied = robotsDenied(fetchRobots(parsed.host), parsed.path);
    if (!denied.empty()) {
      res.status = 403;
      res.set_content(json{{"error", "disallowed by robots: " + denied}}.dump(), "application/json");
      return;
    }
    const auto target = targets.insert(jobId, rawUrl);
    res.status = 200;
    res.set_content(json{{"target_id", target.target_id}, {"status", "accepted"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated registration endpoint at the trust boundary. The draft reads fine because the demo points it at one cooperating host and never retries. Three defects are being checked: the fetch happens before any policy decision (so an internal address reaches the cluster network), \`robots.txt\` is never consulted (so the crawl is impolite from the first request), and registration is not keyed by target (so every client retry doubles the frontier). Real crawlers also normalise the URL before keying it, keep a per-host rules cache with a TTL, and record the rejection reason on the target so an operator can explain why a URL was never fetched.`,
};
