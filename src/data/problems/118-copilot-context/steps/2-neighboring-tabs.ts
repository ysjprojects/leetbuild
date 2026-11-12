import type {Step} from '@/lib/types';

export const neighboringTabsStep: Step = {
  id: 'neighboring-tabs',
  title: 'Neighboring tabs: per-session snippets, a low bar, one round trip',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'tab_snippets',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter implements the two functions the endpoint calls:
\`remember_tabs(session, tabs)\` writes each open tab's text to Redis under \`tabs:{path}\` with
\`SET\`, and \`pick_snippets(session, paths, prefix)\` reads the tabs back with one \`GET\` per path
and keeps a tab when the cursor line appears in it verbatim. The demo shows context from other files.
It hides four flaws.

**Failure mode the checks target.** A key without the session hands one developer's file to
another; a key without a TTL keeps every closed tab until Redis evicts something it needed; a
verbatim match includes nothing on most keystrokes; one round trip per open tab eats the keystroke
budget.

- Store each tab under \`tabs:{session}:{path}\` with a **600 s** TTL (\`TAB_TTL_S\`), refreshed on
  each write.
- Score every **500-character** window (\`SNIPPET_CHARS\`, stride 250) of a tab against the
  identifiers (\`[A-Za-z_][A-Za-z0-9_]*\`) of the last **60 lines** (\`CURSOR_WINDOW_LINES\`) of the
  prefix with \`jaccard(a, b) = |a ∩ b| / |a ∪ b|\`; a tab offers its best window.
- Keep windows scoring at least \`MIN_SNIPPET_SCORE = 0.05\`; when none does, keep the best one if it
  shares any identifier. At most **4** (\`MAX_SNIPPETS\`), best first.
- Read a session's tabs with one \`MGET\`.`,
  sequence: {
    participants: ['completiond', 'Redis'],
    messages: [
      {from: 'completiond', to: 'Redis', label: 'SET tabs:{session}:{path} EX 600 · pipelined', kind: 'sync'},
      {from: 'completiond', to: 'Redis', label: 'MGET tabs:{session}:{path} …', kind: 'sync'},
      {from: 'Redis', to: 'completiond', label: 'tab texts', kind: 'reply'},
      {
        from: 'completiond',
        to: 'completiond',
        label: 'jaccard(last 60 lines, 500-char windows) ≥ 0.05 · best 4',
        kind: 'sync',
      },
    ],
  },
  hints: [
    "A developer sees a stranger's helper in ghost text, another sees nothing from the file in the next tab, Redis memory climbs all week, and latency grows with the number of open tabs.",
    'The key is `tabs:{path}` with no session and no expiry; inclusion needs the cursor line verbatim in the tab, which almost never happens; the read loop sends one `GET` per path.',
    'Write `tabs:{session}:{path}` with `ex=TAB_TTL_S`; score each 500-character window by `jaccard` over identifiers of the last 60 lines, keep scores ≥ 0.05 or else the best; read with one `mget`.',
  ],
  checks: [
    {
      id: 'session-key',
      title: 'Keys tabs by session and path',
      detail:
        "The key is `tabs:{session}:{path}`: two developers with the same file open keep two entries, and each one's snippets come from their own. The starter keys by path alone, so the last writer's text is everyone's context.",
      match: {
        python: {all: [/tabs:\{session\}:\{path\}/]},
        typescript: {all: [/tabs:\$\{session\}:\$\{path\}/]},
        go: {all: [/"tabs:"\s*\+\s*session\s*\+\s*":"\s*\+\s*path|"tabs:%s:%s",\s*session,\s*path/]},
        scala: {all: [/tabs:\$session:\$path|tabs:\$\{session\}:\$\{path\}/]},
        cpp: {all: [/"tabs:"\s*\+\s*session\s*\+\s*":"\s*\+\s*path/]},
      },
    },
    {
      id: 'ttl',
      title: 'Tab entries expire after 600 s',
      detail:
        "Every tab is written with `TAB_TTL_S = 600` as its expiry, refreshed on each write, so a closed tab leaves Redis ten minutes after the editor last sent it. The starter's `SET` has no expiry.",
      match: {
        python: {all: [/TAB_TTL_S\s*=\s*600/, /ex\s*=\s*TAB_TTL_S/]},
        typescript: {all: [/TAB_TTL_S\s*=\s*600/, /['"]EX['"],\s*TAB_TTL_S/]},
        go: {all: [/tabTTL\s*=\s*600\s*\*\s*time\.Second/, /\.Set\(.*tabTTL\)/]},
        scala: {all: [/TabTtlS\s*=\s*600/, /\.setex\(/]},
        cpp: {all: [/kTabTtlS\s*=\s*600/, /std::chrono::seconds\(kTabTtlS\)/]},
      },
    },
    {
      id: 'similarity',
      title: 'Scores snippets by Jaccard with a very low bar',
      detail:
        'Each tab offers its best 500-character window by `jaccard` against the identifiers of the last `CURSOR_WINDOW_LINES` lines; windows at `MIN_SNIPPET_SCORE = 0.05` or above are kept best first, at most 4, and the best one is kept even below the bar. The starter needs the cursor line verbatim.',
      match: {
        python: {
          all: [/MIN_SNIPPET_SCORE\s*=\s*0\.05/, /CURSOR_WINDOW_LINES\s*=\s*60/, /len\(\s*\w+\s*&\s*\w+\s*\)/],
          none: [/cursor_line\s+in\s+text/],
        },
        typescript: {
          all: [/MIN_SNIPPET_SCORE\s*=\s*0\.05/, /CURSOR_WINDOW_LINES\s*=\s*60/, /slice\(\s*-CURSOR_WINDOW_LINES\s*\)/],
          none: [/text\.includes\(\s*cursorLine\s*\)/],
        },
        go: {
          all: [/minSnippetScore\s*=\s*0\.05/, /cursorWindowLines\s*=\s*60/],
          none: [/strings\.Contains\(\s*text,\s*cursorLine\s*\)/],
        },
        scala: {
          all: [/MinSnippetScore\s*=\s*0\.05/, /CursorWindowLines\s*=\s*60/, /takeRight\(\s*CursorWindowLines\s*\)/],
          none: [/text\.contains\(\s*cursorLine\s*\)/],
        },
        cpp: {
          all: [/kMinSnippetScore\s*=\s*0\.05/, /kCursorWindowLines\s*=\s*60/],
          none: [/text->find\(\s*cursor_line\s*\)/],
        },
      },
    },
    {
      id: 'batched-read',
      title: 'Reads every tab in one MGET',
      detail:
        "All of a session's tabs are fetched with one `MGET`, one round trip whatever the number of open tabs. The starter sends a `GET` per open tab on every keystroke.",
      match: {
        python: {all: [/\.mget\(/], none: [/\br\.get\(/]},
        typescript: {all: [/\.mget\(/], none: [/redis\.get\(/]},
        go: {all: [/\.MGet\(/], none: [/rdb\.Get\(/]},
        scala: {all: [/\.mget\(/], none: [/jedis\.get\(/]},
        cpp: {all: [/\.mget\(/], none: [/redis\(\)\.get\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SNIPPET_CHARS = 500
MAX_SNIPPETS = 4


def remember_tabs(session: str, tabs: list[tuple[str, str]]) -> None:
    """Store each (path, text) the editor has open."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for path, text in tabs:
        r.set(f"tabs:{path}", text)


def pick_snippets(session: str, paths: list[str], prefix: str) -> list[str]:
    """Snippets from the session's other open tabs that look like the code at the cursor."""
    cursor_line = prefix.rsplit("\\n", 1)[-1].strip()
    picked: list[str] = []
    for path in paths:
        text = r.get(f"tabs:{path}")
        if text is None:
            continue
        if cursor_line != "" and cursor_line in text:
            start = text.index(cursor_line)
            picked.append(text[start : start + SNIPPET_CHARS])
    return picked[:MAX_SNIPPETS]
`,
      solution: `import re

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TAB_TTL_S = 600
SNIPPET_CHARS = 500
CURSOR_WINDOW_LINES = 60
MIN_SNIPPET_SCORE = 0.05
MAX_SNIPPETS = 4
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def tabs_key(session: str, path: str) -> str:
    return f"tabs:{session}:{path}"


def remember_tabs(session: str, tabs: list[tuple[str, str]]) -> None:
    """Store each (path, text) the editor has open, one pipelined round trip."""
    pipe = r.pipeline(transaction=False)
    for path, text in tabs:
        pipe.set(tabs_key(session, path), text, ex=TAB_TTL_S)
    pipe.execute()


def identifiers(text: str) -> set[str]:
    return set(IDENTIFIER.findall(text))


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def best_window(text: str, cursor: set[str]) -> tuple[float, str]:
    """The SNIPPET_CHARS-wide window of a tab that shares the most identifiers with the cursor."""
    best_score, best_chunk = 0.0, ""
    for start in range(0, max(len(text), 1), SNIPPET_CHARS // 2):
        chunk = text[start : start + SNIPPET_CHARS]
        score = jaccard(identifiers(chunk), cursor)
        if score > best_score:
            best_score, best_chunk = score, chunk
    return best_score, best_chunk


def pick_snippets(session: str, paths: list[str], prefix: str) -> list[str]:
    """Snippets from the session's other open tabs that look like the code at the cursor, best first."""
    if not paths:
        return []
    cursor = identifiers("\\n".join(prefix.split("\\n")[-CURSOR_WINDOW_LINES:]))
    texts = r.mget([tabs_key(session, path) for path in paths])
    scored = [best_window(text, cursor) for text in texts if text is not None]
    scored = sorted((s for s in scored if s[0] > 0), key=lambda s: s[0], reverse=True)
    picked = [chunk for score, chunk in scored if score >= MIN_SNIPPET_SCORE]
    if not picked and scored:
        picked = [scored[0][1]]  # a weak best match still beats no context
    return picked[:MAX_SNIPPETS]
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SNIPPET_CHARS = 500;
export const MAX_SNIPPETS = 4;

export interface Tab {
  path: string;
  text: string;
}

/** Store each tab the editor has open. */
export async function rememberTabs(session: string, tabs: Tab[]): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const tab of tabs) await redis.set(\`tabs:\${tab.path}\`, tab.text);
}

/** Snippets from the session's other open tabs that look like the code at the cursor. */
export async function pickSnippets(session: string, paths: string[], prefix: string): Promise<string[]> {
  const cursorLine = prefix.slice(prefix.lastIndexOf('\\n') + 1).trim();
  const picked: string[] = [];
  for (const path of paths) {
    const text = await redis.get(\`tabs:\${path}\`);
    if (text === null) continue;
    if (cursorLine !== '' && text.includes(cursorLine)) {
      const start = text.indexOf(cursorLine);
      picked.push(text.slice(start, start + SNIPPET_CHARS));
    }
  }
  return picked.slice(0, MAX_SNIPPETS);
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TAB_TTL_S = 600;
export const SNIPPET_CHARS = 500;
export const CURSOR_WINDOW_LINES = 60;
export const MIN_SNIPPET_SCORE = 0.05;
export const MAX_SNIPPETS = 4;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

export interface Tab {
  path: string;
  text: string;
}

export const tabsKey = (session: string, path: string): string => \`tabs:\${session}:\${path}\`;

/** Store each tab the editor has open, one pipelined round trip. */
export async function rememberTabs(session: string, tabs: Tab[]): Promise<void> {
  const pipe = redis.pipeline();
  for (const tab of tabs) pipe.set(tabsKey(session, tab.path), tab.text, 'EX', TAB_TTL_S);
  await pipe.exec();
}

export const identifiers = (text: string): Set<string> => new Set(text.match(IDENTIFIER) ?? []);

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The SNIPPET_CHARS-wide window of a tab that shares the most identifiers with the cursor. */
export function bestWindow(text: string, cursor: Set<string>): [number, string] {
  let best: [number, string] = [0, ''];
  for (let start = 0; start < Math.max(text.length, 1); start += SNIPPET_CHARS / 2) {
    const chunk = text.slice(start, start + SNIPPET_CHARS);
    const score = jaccard(identifiers(chunk), cursor);
    if (score > best[0]) best = [score, chunk];
  }
  return best;
}

/** Snippets from the session's other open tabs that look like the code at the cursor, best first. */
export async function pickSnippets(session: string, paths: string[], prefix: string): Promise<string[]> {
  if (paths.length === 0) return [];
  const cursor = identifiers(prefix.split('\\n').slice(-CURSOR_WINDOW_LINES).join('\\n'));
  const texts = await redis.mget(paths.map(path => tabsKey(session, path)));
  const scored = texts
    .filter((text): text is string => text !== null)
    .map(text => bestWindow(text, cursor))
    .filter(([score]) => score > 0)
    .sort((a, b) => b[0] - a[0]);
  let picked = scored.filter(([score]) => score >= MIN_SNIPPET_SCORE).map(([, chunk]) => chunk);
  if (picked.length === 0 && scored.length > 0) picked = [scored[0][1]]; // a weak best match still beats no context
  return picked.slice(0, MAX_SNIPPETS);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"
)

const (
	snippetChars = 500
	maxSnippets  = 4
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Tab is one tab the editor has open.
type Tab struct {
	Path string \`json:"path"\`
	Text string \`json:"text"\`
}

// rememberTabs stores each tab the editor has open.
func rememberTabs(ctx context.Context, session string, tabs []Tab) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for _, tab := range tabs {
		if err := rdb.Set(ctx, "tabs:"+tab.Path, tab.Text, 0).Err(); err != nil {
			return err
		}
	}
	return nil
}

// pickSnippets is the session's other open tabs that look like the code at the cursor.
func pickSnippets(ctx context.Context, session string, paths []string, prefix string) ([]string, error) {
	cursorLine := strings.TrimSpace(prefix[strings.LastIndex(prefix, "\\n")+1:])
	picked := []string{}
	for _, path := range paths {
		text, err := rdb.Get(ctx, "tabs:"+path).Result()
		if err == redis.Nil {
			continue
		}
		if err != nil {
			return nil, err
		}
		if cursorLine != "" && strings.Contains(text, cursorLine) {
			start := strings.Index(text, cursorLine)
			end := start + snippetChars
			if end > len(text) {
				end = len(text)
			}
			picked = append(picked, text[start:end])
		}
	}
	if len(picked) > maxSnippets {
		picked = picked[:maxSnippets]
	}
	return picked, nil
}
`,
      solution: `package main

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	tabTTL            = 600 * time.Second
	snippetChars      = 500
	cursorWindowLines = 60
	minSnippetScore   = 0.05
	maxSnippets       = 4
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var identifier = regexp.MustCompile(\`[A-Za-z_][A-Za-z0-9_]*\`)

// Tab is one tab the editor has open.
type Tab struct {
	Path string \`json:"path"\`
	Text string \`json:"text"\`
}

func tabsKey(session, path string) string { return "tabs:" + session + ":" + path }

// rememberTabs stores each tab the editor has open, one pipelined round trip.
func rememberTabs(ctx context.Context, session string, tabs []Tab) error {
	if len(tabs) == 0 {
		return nil
	}
	pipe := rdb.Pipeline()
	for _, tab := range tabs {
		pipe.Set(ctx, tabsKey(session, tab.Path), tab.Text, tabTTL)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func identifiers(text string) map[string]bool {
	out := map[string]bool{}
	for _, id := range identifier.FindAllString(text, -1) {
		out[id] = true
	}
	return out
}

func jaccard(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	shared := 0
	for id := range a {
		if b[id] {
			shared++
		}
	}
	return float64(shared) / float64(len(a)+len(b)-shared)
}

// bestWindow is the snippetChars-wide window of a tab that shares the most identifiers with the cursor.
func bestWindow(text string, cursor map[string]bool) (float64, string) {
	bestScore, bestChunk := 0.0, ""
	for start := 0; start == 0 || start < len(text); start += snippetChars / 2 {
		end := start + snippetChars
		if end > len(text) {
			end = len(text)
		}
		chunk := text[start:end]
		if score := jaccard(identifiers(chunk), cursor); score > bestScore {
			bestScore, bestChunk = score, chunk
		}
	}
	return bestScore, bestChunk
}

type window struct {
	score float64
	chunk string
}

// pickSnippets is the session's other open tabs that look like the code at the cursor, best first.
func pickSnippets(ctx context.Context, session string, paths []string, prefix string) ([]string, error) {
	if len(paths) == 0 {
		return []string{}, nil
	}
	lines := strings.Split(prefix, "\\n")
	if len(lines) > cursorWindowLines {
		lines = lines[len(lines)-cursorWindowLines:]
	}
	cursor := identifiers(strings.Join(lines, "\\n"))
	keys := make([]string, len(paths))
	for i, path := range paths {
		keys[i] = tabsKey(session, path)
	}
	texts, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	scored := []window{}
	for _, value := range texts {
		text, ok := value.(string)
		if !ok {
			continue
		}
		if score, chunk := bestWindow(text, cursor); score > 0 {
			scored = append(scored, window{score, chunk})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].score > scored[j].score })
	picked := []string{}
	for _, w := range scored {
		if w.score >= minSnippetScore {
			picked = append(picked, w.chunk)
		}
	}
	if len(picked) == 0 && len(scored) > 0 {
		picked = []string{scored[0].chunk} // a weak best match still beats no context
	}
	if len(picked) > maxSnippets {
		picked = picked[:maxSnippets]
	}
	return picked, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object TabSnippets {
  final case class Tab(path: String, text: String)

  val SnippetChars = 500
  val MaxSnippets = 4

  val jedis = new JedisPooled("redis", 6379)

  /** Store each tab the editor has open. */
  def rememberTabs(session: String, tabs: Seq[Tab]): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tabs.foreach(tab => jedis.set(s"tabs:\${tab.path}", tab.text))
  }

  /** The session's other open tabs that look like the code at the cursor. */
  def pickSnippets(session: String, paths: Seq[String], prefix: String): Seq[String] = {
    val cursorLine = prefix.substring(prefix.lastIndexOf('\\n') + 1).trim
    val picked = paths.flatMap { path =>
      Option(jedis.get(s"tabs:$path")).collect {
        case text if cursorLine.nonEmpty && text.contains(cursorLine) =>
          val start = text.indexOf(cursorLine)
          text.slice(start, start + SnippetChars)
      }
    }
    picked.take(MaxSnippets)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object TabSnippets {
  final case class Tab(path: String, text: String)

  val TabTtlS = 600L
  val SnippetChars = 500
  val CursorWindowLines = 60
  val MinSnippetScore = 0.05
  val MaxSnippets = 4
  private val Identifier = "[A-Za-z_][A-Za-z0-9_]*".r

  val jedis = new JedisPooled("redis", 6379)

  def tabsKey(session: String, path: String): String = s"tabs:$session:$path"

  /** Store each tab the editor has open, one pipelined round trip. */
  def rememberTabs(session: String, tabs: Seq[Tab]): Unit = {
    val pipe = jedis.pipelined()
    tabs.foreach(tab => pipe.setex(tabsKey(session, tab.path), TabTtlS, tab.text))
    pipe.sync()
  }

  def identifiers(text: String): Set[String] = Identifier.findAllIn(text).toSet

  def jaccard(a: Set[String], b: Set[String]): Double =
    if (a.isEmpty || b.isEmpty) 0.0 else (a & b).size.toDouble / (a | b).size

  /** The SnippetChars-wide window of a tab that shares the most identifiers with the cursor. */
  def bestWindow(text: String, cursor: Set[String]): (Double, String) =
    (0 until math.max(text.length, 1) by SnippetChars / 2)
      .map(start => text.slice(start, start + SnippetChars))
      .foldLeft((0.0, "")) { case (best, chunk) =>
        val score = jaccard(identifiers(chunk), cursor)
        if (score > best._1) (score, chunk) else best
      }

  /** The session's other open tabs that look like the code at the cursor, best first. */
  def pickSnippets(session: String, paths: Seq[String], prefix: String): Seq[String] =
    if (paths.isEmpty) Seq.empty
    else {
      val cursor = identifiers(prefix.split("\\n", -1).takeRight(CursorWindowLines).mkString("\\n"))
      val texts = jedis.mget(paths.map(tabsKey(session, _)): _*).asScala.toSeq
      val scored = texts.flatMap(Option(_)).map(bestWindow(_, cursor)).filter(_._1 > 0).sortBy(-_._1)
      val picked = scored.filter(_._1 >= MinSnippetScore).map(_._2)
      (if (picked.isEmpty) scored.take(1).map(_._2) else picked).take(MaxSnippets) // a weak best match still beats no context
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <vector>

constexpr std::size_t kSnippetChars = 500;
constexpr std::size_t kMaxSnippets = 4;

// One tab the editor has open.
struct Tab {
  std::string path;
  std::string text;
};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store each tab the editor has open.
void rememberTabs(const std::string& session, const std::vector<Tab>& tabs) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const Tab& tab : tabs) redis().set("tabs:" + tab.path, tab.text);
}

// The session's other open tabs that look like the code at the cursor.
std::vector<std::string> pickSnippets(const std::string& session, const std::vector<std::string>& paths, const std::string& prefix) {
  const std::size_t nl = prefix.rfind('\\n');
  std::string cursor_line = nl == std::string::npos ? prefix : prefix.substr(nl + 1);
  cursor_line.erase(0, cursor_line.find_first_not_of(' '));
  std::vector<std::string> picked;
  for (const std::string& path : paths) {
    const auto text = redis().get("tabs:" + path);
    if (!text || cursor_line.empty()) continue;
    const std::size_t at = text->find(cursor_line);
    if (at != std::string::npos) picked.push_back(text->substr(at, kSnippetChars));
  }
  if (picked.size() > kMaxSnippets) picked.resize(kMaxSnippets);
  return picked;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iterator>
#include <set>
#include <string>
#include <utility>
#include <vector>

constexpr long long kTabTtlS = 600;
constexpr std::size_t kSnippetChars = 500;
constexpr std::size_t kCursorWindowLines = 60;
constexpr double kMinSnippetScore = 0.05;
constexpr std::size_t kMaxSnippets = 4;

// One tab the editor has open.
struct Tab {
  std::string path;
  std::string text;
};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string tabsKey(const std::string& session, const std::string& path) { return "tabs:" + session + ":" + path; }

// Store each tab the editor has open, one pipelined round trip.
void rememberTabs(const std::string& session, const std::vector<Tab>& tabs) {
  if (tabs.empty()) return;
  auto pipe = redis().pipeline();
  for (const Tab& tab : tabs) pipe.set(tabsKey(session, tab.path), tab.text, std::chrono::seconds(kTabTtlS));
  pipe.exec();
}

// The identifiers of a text: [A-Za-z_][A-Za-z0-9_]*.
std::set<std::string> identifiers(const std::string& text) {
  std::set<std::string> out;
  std::size_t i = 0;
  while (i < text.size()) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (!std::isalpha(c) && c != '_') {
      i++;
      continue;
    }
    std::size_t j = i + 1;
    while (j < text.size() && (std::isalnum(static_cast<unsigned char>(text[j])) || text[j] == '_')) j++;
    out.insert(text.substr(i, j - i));
    i = j;
  }
  return out;
}

double jaccard(const std::set<std::string>& a, const std::set<std::string>& b) {
  if (a.empty() || b.empty()) return 0;
  std::size_t shared = 0;
  for (const std::string& id : a) shared += b.count(id);
  return static_cast<double>(shared) / static_cast<double>(a.size() + b.size() - shared);
}

// The kSnippetChars-wide window of a tab that shares the most identifiers with the cursor.
std::pair<double, std::string> bestWindow(const std::string& text, const std::set<std::string>& cursor) {
  std::pair<double, std::string> best{0.0, ""};
  for (std::size_t start = 0; start == 0 || start < text.size(); start += kSnippetChars / 2) {
    const std::string chunk = text.substr(start, kSnippetChars);
    const double score = jaccard(identifiers(chunk), cursor);
    if (score > best.first) best = {score, chunk};
  }
  return best;
}

// The session's other open tabs that look like the code at the cursor, best first.
std::vector<std::string> pickSnippets(const std::string& session, const std::vector<std::string>& paths, const std::string& prefix) {
  if (paths.empty()) return {};
  std::vector<std::string> lines;
  for (std::size_t start = 0;;) {
    const std::size_t nl = prefix.find('\\n', start);
    lines.push_back(prefix.substr(start, nl == std::string::npos ? std::string::npos : nl - start));
    if (nl == std::string::npos) break;
    start = nl + 1;
  }
  std::string window;
  for (std::size_t i = lines.size() > kCursorWindowLines ? lines.size() - kCursorWindowLines : 0; i < lines.size(); i++)
    window += lines[i] + "\\n";
  const std::set<std::string> cursor = identifiers(window);
  std::vector<std::string> keys;
  for (const std::string& path : paths) keys.push_back(tabsKey(session, path));
  std::vector<sw::redis::OptionalString> texts;
  redis().mget(keys.begin(), keys.end(), std::back_inserter(texts));
  std::vector<std::pair<double, std::string>> scored;
  for (const auto& text : texts) {
    if (!text) continue;
    auto best = bestWindow(*text, cursor);
    if (best.first > 0) scored.push_back(std::move(best));
  }
  std::stable_sort(scored.begin(), scored.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  std::vector<std::string> picked;
  for (const auto& [score, chunk] : scored)
    if (score >= kMinSnippetScore) picked.push_back(chunk);
  if (picked.empty() && !scored.empty()) picked.push_back(scored.front().second);  // a weak best match still beats no context
  if (picked.size() > kMaxSnippets) picked.resize(kMaxSnippets);
  return picked;
}
`,
    },
  },
  harness: {
    python: `from leetbuild.metrics import METRICS

OLD = "\\n".join(f"legacy_total_{i} = legacy_sum(report_rows, legacy_col_{i})" for i in range(40))
BLOCK = "def load_user(conn, user_id):\\n    cursor = conn.cursor()\\n    cursor.execute(USER_QUERY, (user_id,))\\n    row = cursor.fetchone()\\n    return User.from_row(row)\\n"
PREFIX = OLD + "\\n" + "\\n".join((BLOCK * 12).split("\\n")[:59]) + "\\n    user = User.from_"
POOL = "import psycopg\\n\\ndef open_conn(dsn):\\n    conn = psycopg.connect(dsn, autocommit=True)\\n    cursor = conn.cursor()\\n    cursor.execute(\\"SET statement_timeout = 500\\")\\n    return conn\\n"
USER = (
    "\\n".join(f"# models filler line {i} lorem ipsum dolor" for i in range(20))
    + "\\nfrom dataclasses import dataclass\\n\\n@dataclass\\nclass User:\\n    user_id: int\\n    email: str\\n\\n    @classmethod\\n    def from_row(cls, row):\\n        return cls(user_id=row[0], email=row[1])\\n"
    + "\\n".join(f"# models2 filler line {i} lorem ipsum dolor" for i in range(20))
)
NOTES = "Release notes: the cursor blinks faster now. Contributors thanked: alice bob carol dave erin frank grace heidi ivan judy mallory niaj olivia peggy rupert sybil trent victor walter"
LEGACY = "\\n".join(f"legacy_total_{i} = legacy_sum(report_rows, legacy_col_{i})" for i in range(12))


def _variant(k):
    """The pool module with k unrelated names added: each one lowers its score a little."""
    return POOL + "".join(f"extra_name_{k}_{j} = None\\n" for j in range(k))


def check_session_key(ctx):
    m = ctx.load("tab_snippets")
    m.remember_tabs("s-ada", [("db/conn.py", POOL)])
    m.remember_tabs("s-bob", [("db/conn.py", POOL + "BOB_ONLY = 'session b'\\n")])
    keys = sorted(ctx.redis.keys("tabs:*"))
    assert keys == ["tabs:s-ada:db/conn.py", "tabs:s-bob:db/conn.py"], f"two sessions with db/conn.py open left the keys {keys}: the key is tabs:{{session}}:{{path}}"
    picked = m.pick_snippets("s-ada", ["db/conn.py"], PREFIX)
    assert all("BOB_ONLY" not in s for s in picked), f"session s-ada was handed s-bob's file: {picked}"
    assert picked == [POOL], f"session s-ada's own db/conn.py must come back as its snippet, got {picked}"


def check_ttl(ctx):
    m = ctx.load("tab_snippets")
    m.remember_tabs("s-ada", [("db/conn.py", POOL), ("models/user.py", USER)])
    keys = ctx.redis.keys("tabs:*")
    assert len(keys) == 2, f"two open tabs left the keys {keys}"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 590 <= ttl <= 600, f"{key} has TTL {ttl}: every tab is written with a 600 s expiry"
    ctx.clock.advance(300)
    m.remember_tabs("s-ada", [("db/conn.py", POOL)])
    conn = [k for k in ctx.redis.keys("tabs:*") if k.endswith("db/conn.py")]
    assert conn and ctx.redis.ttl(conn[0]) >= 590, f"a tab sent again must have its 600 s expiry refreshed, TTL is {ctx.redis.ttl(conn[0]) if conn else None}"
    ctx.clock.advance(301)
    left = ctx.redis.keys("tabs:*")
    assert left == conn, f"601 s after its last write models/user.py must be gone, and db/conn.py (written 301 s ago) kept; Redis holds {left}"


def check_similarity(ctx):
    m = ctx.load("tab_snippets")
    tabs = [("docs/notes.py", NOTES), ("models/user.py", USER), ("db/pool.py", POOL), ("legacy/report.py", LEGACY)]
    m.remember_tabs("s-ada", tabs + [(f"lib/pool_{k}.py", _variant(k)) for k in range(6)])
    alone = m.pick_snippets("s-ada", ["docs/notes.py"], PREFIX)
    assert alone == [NOTES], f"docs/notes.py shares one identifier with the cursor (score 0.02): with nothing above 0.05 the best match is still included, got {alone}"
    mixed = m.pick_snippets("s-ada", ["legacy/report.py", "docs/notes.py", "models/user.py", "db/pool.py"], PREFIX)
    assert not any("legacy_sum" in s for s in mixed), "legacy/report.py matches only the first 40 lines of the prefix: score the last 60 lines (CURSOR_WINDOW_LINES)"
    assert NOTES not in mixed, "docs/notes.py scores below 0.05 and two tabs score above it: the best-match fallback is only for when nothing reaches the bar"
    assert len(mixed) == 2 and mixed[0] == POOL, f"db/pool.py (0.22) then models/user.py (0.19) expected, best first; got {mixed}"
    assert "def from_row" in mixed[1] and len(mixed[1]) <= 500, f"models/user.py must offer its best 500-character window (the one with from_row), got {mixed[1]!r}"
    many = m.pick_snippets("s-ada", [f"lib/pool_{k}.py" for k in (5, 2, 0, 4, 1, 3)], PREFIX)
    assert many == [_variant(k) for k in range(4)], f"six matching tabs must give the 4 best, best first (lib/pool_0 … lib/pool_3), got {len(many)} snippets"


def check_batched_read(ctx):
    m = ctx.load("tab_snippets")
    paths = [f"src/f{k}.py" for k in range(8)]
    m.remember_tabs("s-ada", [(path, POOL) for path in paths])
    before = METRICS.redis_trips
    picked = m.pick_snippets("s-ada", paths, PREFIX)
    trips = METRICS.redis_trips - before
    assert trips == 1, f"pick_snippets made {trips} round trips for 8 open tabs: read them with one MGET"
    assert len(picked) == 4, f"eight matching tabs must give 4 snippets, got {len(picked)}"
`,
    typescript: `const lines = (n: number, f: (i: number) => string): string[] => Array.from({length: n}, (_, i) => f(i));
const OLD = lines(40, i => \`legacy_total_\${i} = legacy_sum(report_rows, legacy_col_\${i})\`).join('\\n');
const BLOCK = 'def load_user(conn, user_id):\\n    cursor = conn.cursor()\\n    cursor.execute(USER_QUERY, (user_id,))\\n    row = cursor.fetchone()\\n    return User.from_row(row)\\n';
const PREFIX = OLD + '\\n' + BLOCK.repeat(12).split('\\n').slice(0, 59).join('\\n') + '\\n    user = User.from_';
const POOL = 'import psycopg\\n\\ndef open_conn(dsn):\\n    conn = psycopg.connect(dsn, autocommit=True)\\n    cursor = conn.cursor()\\n    cursor.execute("SET statement_timeout = 500")\\n    return conn\\n';
const USER =
  lines(20, i => \`# models filler line \${i} lorem ipsum dolor\`).join('\\n') +
  '\\nfrom dataclasses import dataclass\\n\\n@dataclass\\nclass User:\\n    user_id: int\\n    email: str\\n\\n    @classmethod\\n    def from_row(cls, row):\\n        return cls(user_id=row[0], email=row[1])\\n' +
  lines(20, i => \`# models2 filler line \${i} lorem ipsum dolor\`).join('\\n');
const NOTES = 'Release notes: the cursor blinks faster now. Contributors thanked: alice bob carol dave erin frank grace heidi ivan judy mallory niaj olivia peggy rupert sybil trent victor walter';
const LEGACY = lines(12, i => \`legacy_total_\${i} = legacy_sum(report_rows, legacy_col_\${i})\`).join('\\n');
/** The pool module with k unrelated names added: each one lowers its score a little. */
const variant = (k: number): string => POOL + lines(k, j => \`extra_name_\${k}_\${j} = None\\n\`).join('');

export async function check_session_key(ctx) {
  const m = ctx.load('tab_snippets');
  await m.rememberTabs('s-ada', [{path: 'db/conn.py', text: POOL}]);
  await m.rememberTabs('s-bob', [{path: 'db/conn.py', text: POOL + "BOB_ONLY = 'session b'\\n"}]);
  const keys = ctx.redis.keys('tabs:*').sort();
  assert.deepEqual(keys, ['tabs:s-ada:db/conn.py', 'tabs:s-bob:db/conn.py'], \`two sessions with db/conn.py open left the keys \${JSON.stringify(keys)}: the key is tabs:{session}:{path}\`);
  const picked = await m.pickSnippets('s-ada', ['db/conn.py'], PREFIX);
  assert(picked.every(s => !s.includes('BOB_ONLY')), \`session s-ada was handed s-bob's file: \${JSON.stringify(picked)}\`);
  assert.deepEqual(picked, [POOL], \`session s-ada's own db/conn.py must come back as its snippet, got \${JSON.stringify(picked)}\`);
}

export async function check_ttl(ctx) {
  const m = ctx.load('tab_snippets');
  await m.rememberTabs('s-ada', [{path: 'db/conn.py', text: POOL}, {path: 'models/user.py', text: USER}]);
  const keys = ctx.redis.keys('tabs:*');
  assert.equal(keys.length, 2, \`two open tabs left the keys \${JSON.stringify(keys)}\`);
  for (const key of keys) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl >= 590 && ttl <= 600, \`\${key} has TTL \${ttl}: every tab is written with a 600 s expiry\`);
  }
  ctx.clock.advance(300);
  await m.rememberTabs('s-ada', [{path: 'db/conn.py', text: POOL}]);
  const conn = ctx.redis.keys('tabs:*').filter(k => k.endsWith('db/conn.py'));
  assert(conn.length === 1 && ctx.redis.ttl(conn[0]) >= 590, \`a tab sent again must have its 600 s expiry refreshed, TTL is \${conn.length ? ctx.redis.ttl(conn[0]) : null}\`);
  ctx.clock.advance(301);
  const left = ctx.redis.keys('tabs:*');
  assert.deepEqual(left, conn, \`601 s after its last write models/user.py must be gone, and db/conn.py (written 301 s ago) kept; Redis holds \${JSON.stringify(left)}\`);
}

export async function check_similarity(ctx) {
  const m = ctx.load('tab_snippets');
  const tabs = [
    {path: 'docs/notes.py', text: NOTES},
    {path: 'models/user.py', text: USER},
    {path: 'db/pool.py', text: POOL},
    {path: 'legacy/report.py', text: LEGACY},
    ...lines(6, k => k).map((_, k) => ({path: \`lib/pool_\${k}.py\`, text: variant(k)})),
  ];
  await m.rememberTabs('s-ada', tabs);
  const alone = await m.pickSnippets('s-ada', ['docs/notes.py'], PREFIX);
  assert.deepEqual(alone, [NOTES], \`docs/notes.py shares one identifier with the cursor (score 0.02): with nothing above 0.05 the best match is still included, got \${JSON.stringify(alone)}\`);
  const mixed = await m.pickSnippets('s-ada', ['legacy/report.py', 'docs/notes.py', 'models/user.py', 'db/pool.py'], PREFIX);
  assert(!mixed.some(s => s.includes('legacy_sum')), 'legacy/report.py matches only the first 40 lines of the prefix: score the last 60 lines (CURSOR_WINDOW_LINES)');
  assert(!mixed.includes(NOTES), 'docs/notes.py scores below 0.05 and two tabs score above it: the best-match fallback is only for when nothing reaches the bar');
  assert(mixed.length === 2 && mixed[0] === POOL, \`db/pool.py (0.22) then models/user.py (0.19) expected, best first; got \${JSON.stringify(mixed)}\`);
  assert(mixed[1].includes('def from_row') && mixed[1].length <= 500, \`models/user.py must offer its best 500-character window (the one with from_row), got \${JSON.stringify(mixed[1])}\`);
  const many = await m.pickSnippets('s-ada', [5, 2, 0, 4, 1, 3].map(k => \`lib/pool_\${k}.py\`), PREFIX);
  assert.deepEqual(many, [0, 1, 2, 3].map(variant), \`six matching tabs must give the 4 best, best first (lib/pool_0 … lib/pool_3), got \${many.length} snippets\`);
}

export async function check_batched_read(ctx) {
  const m = ctx.load('tab_snippets');
  const paths = lines(8, k => \`src/f\${k}.py\`);
  await m.rememberTabs('s-ada', paths.map(path => ({path, text: POOL})));
  const before = ctx.redisRoundTrips().length;
  const picked = await m.pickSnippets('s-ada', paths, PREFIX);
  const trips = ctx.redisRoundTrips().slice(before);
  assert(trips.length === 1 && trips[0][0] === 'MGET', \`pickSnippets made \${trips.length} round trips for 8 open tabs (\${JSON.stringify(trips)}): read them with one MGET\`);
  assert.equal(picked.length, 4, \`eight matching tabs must give 4 snippets, got \${picked.length}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"leetbuild/harness"
)

func tabsLines(n int, line func(i int) string) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = line(i)
	}
	return out
}

var (
	tabsOld    = strings.Join(tabsLines(40, func(i int) string { return fmt.Sprintf("legacy_total_%d = legacy_sum(report_rows, legacy_col_%d)", i, i) }), "\\n")
	tabsBlock  = "def load_user(conn, user_id):\\n    cursor = conn.cursor()\\n    cursor.execute(USER_QUERY, (user_id,))\\n    row = cursor.fetchone()\\n    return User.from_row(row)\\n"
	tabsPrefix = tabsOld + "\\n" + strings.Join(strings.Split(strings.Repeat(tabsBlock, 12), "\\n")[:59], "\\n") + "\\n    user = User.from_"
	tabsPool   = "import psycopg\\n\\ndef open_conn(dsn):\\n    conn = psycopg.connect(dsn, autocommit=True)\\n    cursor = conn.cursor()\\n    cursor.execute(\\"SET statement_timeout = 500\\")\\n    return conn\\n"
	tabsUser   = strings.Join(tabsLines(20, func(i int) string { return fmt.Sprintf("# models filler line %d lorem ipsum dolor", i) }), "\\n") +
		"\\nfrom dataclasses import dataclass\\n\\n@dataclass\\nclass User:\\n    user_id: int\\n    email: str\\n\\n    @classmethod\\n    def from_row(cls, row):\\n        return cls(user_id=row[0], email=row[1])\\n" +
		strings.Join(tabsLines(20, func(i int) string { return fmt.Sprintf("# models2 filler line %d lorem ipsum dolor", i) }), "\\n")
	tabsNotes  = "Release notes: the cursor blinks faster now. Contributors thanked: alice bob carol dave erin frank grace heidi ivan judy mallory niaj olivia peggy rupert sybil trent victor walter"
	tabsLegacy = strings.Join(tabsLines(12, func(i int) string { return fmt.Sprintf("legacy_total_%d = legacy_sum(report_rows, legacy_col_%d)", i, i) }), "\\n")
)

// tabsVariant is the pool module with k unrelated names added: each one lowers its score a little.
func tabsVariant(k int) string {
	return tabsPool + strings.Join(tabsLines(k, func(j int) string { return fmt.Sprintf("extra_name_%d_%d = None\\n", k, j) }), "")
}

func tabsRemember(ctx *harness.Ctx, session string, open []Tab) {
	ctx.NoError(rememberTabs(context.Background(), session, open), "rememberTabs(%s)", session)
}

func tabsPick(ctx *harness.Ctx, session string, paths []string) []string {
	picked, err := pickSnippets(context.Background(), session, paths, tabsPrefix)
	ctx.NoError(err, "pickSnippets(%s)", session)
	return picked
}

func CheckSessionKey(ctx *harness.Ctx) {
	tabsRemember(ctx, "s-ada", []Tab{{"db/conn.py", tabsPool}})
	tabsRemember(ctx, "s-bob", []Tab{{"db/conn.py", tabsPool + "BOB_ONLY = 'session b'\\n"}})
	keys := ctx.Redis.Keys("tabs:*")
	ctx.Equal(keys, []string{"tabs:s-ada:db/conn.py", "tabs:s-bob:db/conn.py"}, "two sessions with db/conn.py open: the key is tabs:{session}:{path}; the keys")
	picked := tabsPick(ctx, "s-ada", []string{"db/conn.py"})
	for _, s := range picked {
		ctx.Assert(!strings.Contains(s, "BOB_ONLY"), "session s-ada was handed s-bob's file: %q", s)
	}
	ctx.Equal(picked, []string{tabsPool}, "session s-ada's own db/conn.py must come back as its snippet")
}

func CheckTtl(ctx *harness.Ctx) {
	tabsRemember(ctx, "s-ada", []Tab{{"db/conn.py", tabsPool}, {"models/user.py", tabsUser}})
	keys := ctx.Redis.Keys("tabs:*")
	ctx.Equal(len(keys), 2, "two open tabs left the keys %v; keys", keys)
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 590 && ttl <= 600, "%s has TTL %d: every tab is written with a 600 s expiry", key, ttl)
	}
	ctx.Clock.Advance(300)
	tabsRemember(ctx, "s-ada", []Tab{{"db/conn.py", tabsPool}})
	conn := []string{}
	for _, key := range ctx.Redis.Keys("tabs:*") {
		if strings.HasSuffix(key, "db/conn.py") {
			conn = append(conn, key)
		}
	}
	ctx.Assert(len(conn) == 1 && ctx.Redis.TTL(conn[0]) >= 590, "a tab sent again must have its 600 s expiry refreshed (%v)", conn)
	ctx.Clock.Advance(301)
	ctx.Equal(ctx.Redis.Keys("tabs:*"), conn, "601 s after its last write models/user.py must be gone, and db/conn.py (written 301 s ago) kept; the keys")
}

func CheckSimilarity(ctx *harness.Ctx) {
	open := []Tab{{"docs/notes.py", tabsNotes}, {"models/user.py", tabsUser}, {"db/pool.py", tabsPool}, {"legacy/report.py", tabsLegacy}}
	for k := 0; k < 6; k++ {
		open = append(open, Tab{fmt.Sprintf("lib/pool_%d.py", k), tabsVariant(k)})
	}
	tabsRemember(ctx, "s-ada", open)
	alone := tabsPick(ctx, "s-ada", []string{"docs/notes.py"})
	ctx.Equal(alone, []string{tabsNotes}, "docs/notes.py shares one identifier with the cursor (score 0.02): with nothing above 0.05 the best match is still included")
	mixed := tabsPick(ctx, "s-ada", []string{"legacy/report.py", "docs/notes.py", "models/user.py", "db/pool.py"})
	for _, s := range mixed {
		ctx.Assert(!strings.Contains(s, "legacy_sum"), "legacy/report.py matches only the first 40 lines of the prefix: score the last 60 lines (cursorWindowLines)")
		ctx.Assert(s != tabsNotes, "docs/notes.py scores below 0.05 and two tabs score above it: the best-match fallback is only for when nothing reaches the bar")
	}
	ctx.Assert(len(mixed) == 2 && mixed[0] == tabsPool, "db/pool.py (0.22) then models/user.py (0.19) expected, best first; got %d snippets %q", len(mixed), mixed)
	ctx.Assert(strings.Contains(mixed[1], "def from_row") && len(mixed[1]) <= 500, "models/user.py must offer its best 500-character window (the one with from_row), got %q", mixed[1])
	paths := []string{}
	for _, k := range []int{5, 2, 0, 4, 1, 3} {
		paths = append(paths, fmt.Sprintf("lib/pool_%d.py", k))
	}
	many := tabsPick(ctx, "s-ada", paths)
	ctx.Equal(many, []string{tabsVariant(0), tabsVariant(1), tabsVariant(2), tabsVariant(3)}, "six matching tabs must give the 4 best, best first (lib/pool_0 … lib/pool_3)")
}

func CheckBatchedRead(ctx *harness.Ctx) {
	paths := tabsLines(8, func(k int) string { return fmt.Sprintf("src/f%d.py", k) })
	open := []Tab{}
	for _, path := range paths {
		open = append(open, Tab{path, tabsPool})
	}
	tabsRemember(ctx, "s-ada", open)
	before := len(ctx.Redis.RoundTrips())
	picked := tabsPick(ctx, "s-ada", paths)
	trips := ctx.Redis.RoundTrips()[before:]
	ctx.Assert(len(trips) == 1 && trips[0][0] == "MGET", "pickSnippets made %d round trips for 8 open tabs (%v): read them with one MGET", len(trips), trips)
	ctx.Equal(len(picked), 4, "eight matching tabs must give 4 snippets; snippets")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

namespace {

std::string tabsJoin(const std::vector<std::string>& lines, const std::string& sep) {
  std::string out;
  for (std::size_t i = 0; i < lines.size(); i++) out += (i == 0 ? "" : sep) + lines[i];
  return out;
}

std::string tabsLegacyLines(int n) {
  std::vector<std::string> lines;
  for (int i = 0; i < n; i++)
    lines.push_back("legacy_total_" + std::to_string(i) + " = legacy_sum(report_rows, legacy_col_" + std::to_string(i) + ")");
  return tabsJoin(lines, "\\n");
}

std::string tabsFiller(const std::string& tag) {
  std::vector<std::string> lines;
  for (int i = 0; i < 20; i++) lines.push_back("# " + tag + " filler line " + std::to_string(i) + " lorem ipsum dolor");
  return tabsJoin(lines, "\\n");
}

std::string tabsPrefix() {
  const std::string block =
      "def load_user(conn, user_id):\\n    cursor = conn.cursor()\\n    cursor.execute(USER_QUERY, (user_id,))\\n    row = cursor.fetchone()\\n    return User.from_row(row)\\n";
  std::string repeated;
  for (int i = 0; i < 12; i++) repeated += block;
  std::vector<std::string> lines;
  std::size_t start = 0;
  while (lines.size() < 59) {
    const std::size_t nl = repeated.find('\\n', start);
    lines.push_back(repeated.substr(start, nl - start));
    start = nl + 1;
  }
  return tabsLegacyLines(40) + "\\n" + tabsJoin(lines, "\\n") + "\\n    user = User.from_";
}

const std::string kTabsPool =
    "import psycopg\\n\\ndef open_conn(dsn):\\n    conn = psycopg.connect(dsn, autocommit=True)\\n    cursor = conn.cursor()\\n    cursor.execute(\\"SET statement_timeout = 500\\")\\n    return conn\\n";
const std::string kTabsNotes =
    "Release notes: the cursor blinks faster now. Contributors thanked: alice bob carol dave erin frank grace heidi ivan judy mallory niaj olivia peggy rupert sybil trent victor walter";

std::string tabsUser() {
  return tabsFiller("models") +
         "\\nfrom dataclasses import dataclass\\n\\n@dataclass\\nclass User:\\n    user_id: int\\n    email: str\\n\\n    @classmethod\\n    def from_row(cls, row):\\n        return cls(user_id=row[0], email=row[1])\\n" +
         tabsFiller("models2");
}

// The pool module with k unrelated names added: each one lowers its score a little.
std::string tabsVariant(int k) {
  std::string out = kTabsPool;
  for (int j = 0; j < k; j++) out += "extra_name_" + std::to_string(k) + "_" + std::to_string(j) + " = None\\n";
  return out;
}

}  // namespace

void CheckSessionKey(harness::Ctx& ctx) {
  rememberTabs("s-ada", {{"db/conn.py", kTabsPool}});
  rememberTabs("s-bob", {{"db/conn.py", kTabsPool + "BOB_ONLY = 'session b'\\n"}});
  ctx.Equal(ctx.Redis.Keys("tabs:*"), {"tabs:s-ada:db/conn.py", "tabs:s-bob:db/conn.py"},
            "two sessions with db/conn.py open: the key is tabs:{session}:{path}; the keys");
  const auto picked = pickSnippets("s-ada", {"db/conn.py"}, tabsPrefix());
  for (const auto& s : picked) ctx.Assert(s.find("BOB_ONLY") == std::string::npos, "session s-ada was handed s-bob's file: %q", s);
  ctx.Equal(picked, {kTabsPool}, "session s-ada's own db/conn.py must come back as its snippet");
}

void CheckTtl(harness::Ctx& ctx) {
  rememberTabs("s-ada", {{"db/conn.py", kTabsPool}, {"models/user.py", tabsUser()}});
  const auto keys = ctx.Redis.Keys("tabs:*");
  ctx.Equal(keys.size(), 2, "two open tabs left the keys %v; keys", keys);
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl >= 590 && ttl <= 600, "%s has TTL %d: every tab is written with a 600 s expiry", key, ttl);
  }
  ctx.Clock.Advance(300);
  rememberTabs("s-ada", {{"db/conn.py", kTabsPool}});
  std::vector<std::string> conn;
  for (const auto& key : ctx.Redis.Keys("tabs:*"))
    if (key.size() >= 10 && key.compare(key.size() - 10, 10, "db/conn.py") == 0) conn.push_back(key);
  ctx.Assert(conn.size() == 1 && ctx.Redis.TTL(conn[0]) >= 590, "a tab sent again must have its 600 s expiry refreshed (%v)", conn);
  ctx.Clock.Advance(301);
  ctx.Equal(ctx.Redis.Keys("tabs:*"), conn, "601 s after its last write models/user.py must be gone, and db/conn.py (written 301 s ago) kept; the keys");
}

void CheckSimilarity(harness::Ctx& ctx) {
  std::vector<Tab> open = {{"docs/notes.py", kTabsNotes}, {"models/user.py", tabsUser()}, {"db/pool.py", kTabsPool}, {"legacy/report.py", tabsLegacyLines(12)}};
  for (int k = 0; k < 6; k++) open.push_back({"lib/pool_" + std::to_string(k) + ".py", tabsVariant(k)});
  rememberTabs("s-ada", open);
  const std::string prefix = tabsPrefix();
  ctx.Equal(pickSnippets("s-ada", {"docs/notes.py"}, prefix), {kTabsNotes},
            "docs/notes.py shares one identifier with the cursor (score 0.02): with nothing above 0.05 the best match is still included");
  const auto mixed = pickSnippets("s-ada", {"legacy/report.py", "docs/notes.py", "models/user.py", "db/pool.py"}, prefix);
  for (const auto& s : mixed) {
    ctx.Assert(s.find("legacy_sum") == std::string::npos, "legacy/report.py matches only the first 40 lines of the prefix: score the last 60 lines (kCursorWindowLines)");
    ctx.Assert(s != kTabsNotes, "docs/notes.py scores below 0.05 and two tabs score above it: the best-match fallback is only for when nothing reaches the bar");
  }
  ctx.Assert(mixed.size() == 2 && mixed[0] == kTabsPool, "db/pool.py (0.22) then models/user.py (0.19) expected, best first; got %d snippets", mixed.size());
  ctx.Assert(mixed[1].find("def from_row") != std::string::npos && mixed[1].size() <= 500, "models/user.py must offer its best 500-character window (the one with from_row), got %q", mixed[1]);
  std::vector<std::string> paths;
  for (int k : {5, 2, 0, 4, 1, 3}) paths.push_back("lib/pool_" + std::to_string(k) + ".py");
  ctx.Equal(pickSnippets("s-ada", paths, prefix), {tabsVariant(0), tabsVariant(1), tabsVariant(2), tabsVariant(3)},
            "six matching tabs must give the 4 best, best first (lib/pool_0 … lib/pool_3)");
}

void CheckBatchedRead(harness::Ctx& ctx) {
  std::vector<std::string> paths;
  std::vector<Tab> open;
  for (int k = 0; k < 8; k++) {
    paths.push_back("src/f" + std::to_string(k) + ".py");
    open.push_back({paths.back(), kTabsPool});
  }
  rememberTabs("s-ada", open);
  const std::size_t before = ctx.Redis.RoundTrips().size();
  const auto picked = pickSnippets("s-ada", paths, tabsPrefix());
  const auto all = ctx.Redis.RoundTrips();
  const std::vector<std::vector<std::string>> trips(all.begin() + static_cast<long>(before), all.end());
  ctx.Assert(trips.size() == 1 && !trips[0].empty() && trips[0][0] == "MGET", "pickSnippets made %d round trips for 8 open tabs (%v): read them with one MGET", trips.size(), trips);
  ctx.Equal(picked.size(), 4, "eight matching tabs must give 4 snippets; snippets");
}
`,
  },
  debrief: `The key carries the session because the cache holds other people's source code: a key shared across sessions is a cross-tenant read waiting for a common file name. The TTL is the cache's only cleanup, since the editor never reports a closed tab. The bar is low on purpose: GitHub measured that a weak best match beats no context, so the expensive mistake is including nothing. Scoring only the last 60 lines keeps the match about the code being written now. One \`MGET\` turns the read into one round trip whatever the number of tabs. Copilot runs this matching in the editor, where the tabs already are; a server-side cache would also cap the bytes stored per session.`,
};
