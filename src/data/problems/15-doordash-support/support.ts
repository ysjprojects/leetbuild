/**
 * Hand-written support modules the support-assistant steps import but no step builds — the
 * `assistant` package: deterministic embeddings (`embed`), chunking (`chunk`), the knowledge base
 * (`kb`), the prompt format (`prompt`), the stand-in model and judge the harness serves (`model`),
 * the database handle and schema (`db`) and the addresses and limits everything agrees on
 * (`config`). The Python and TypeScript versions compute the same numbers from the same text, so a
 * nearest neighbour or a judge score is the same in both runtimes.
 */

const ARTICLES: {id: string; title: string; body: string}[] = [
  {
    id: 'pay',
    title: 'When and how Dashers are paid',
    body: 'Dasher earnings for a week are paid out every Monday by direct deposit and usually arrive within two to three business days, depending on the bank. Fast Pay lets a Dasher cash out once per day for a small fee, as long as the account has been active for two weeks and at least twenty-five deliveries have been completed. Earnings from a delivery appear in the app as soon as the order is marked delivered. If a payout is missing after five business days, check the bank details on file before contacting support.',
  },
  {
    id: 'tips',
    title: 'Tips and how they reach the Dasher',
    body: 'Customers can tip when they order or after the delivery, and Dashers keep one hundred percent of every tip. A tip added after delivery shows up in the earnings breakdown within a few hours, under the delivery it belongs to. Tips are included in the weekly payout and in Fast Pay. Base pay and promotions never replace a tip; they are added on top of it.',
  },
  {
    id: 'undeliverable',
    title: 'Customer unavailable or order cannot be delivered',
    body: 'When a customer does not answer at the door, the Dasher should call and text them through the app and then start the ten-minute timer. If the timer runs out, the app allows the order to be marked as undeliverable and the Dasher is still paid in full for the delivery. Food that cannot be delivered may be kept or disposed of; it should never be returned to the store. Deliveries marked undeliverable do not affect the completion rate.',
  },
  {
    id: 'login',
    title: 'Trouble signing in to the Dasher app',
    body: 'If the Dasher app will not sign in, first update it to the latest version and check that the phone has a data connection. Use the Forgot Password link to reset a password; the reset email can take a few minutes and may land in spam. An account locked after too many attempts unlocks on its own after thirty minutes. Two-factor codes are sent by text message to the number on the account, so an old phone number must be updated before signing in again.',
  },
  {
    id: 'scheduling',
    title: 'Scheduling a dash and Dash Now',
    body: 'Dashers can schedule time slots up to six days ahead in the Schedule tab, and slots open at three in the afternoon local time each day. When a zone is busy enough it shows Dash Now, which lets a Dasher start without a scheduled slot. A scheduled dash that is not started within thirty minutes of its start time is released to other Dashers. Scheduled time can be extended from the app while dashing as long as the zone still has room.',
  },
  {
    id: 'ratings',
    title: 'Customer ratings and completion rate',
    body: 'The customer rating is the average of the last one hundred ratings from customers, and the completion rate is the share of accepted deliveries that were completed over the last one hundred accepted. Declining an offer before accepting it does not affect the completion rate; unassigning after accepting does. A completion rate below eighty percent or a customer rating below 4.2 can lead to deactivation after a warning. Ratings older than the last hundred deliveries fall away on their own.',
  },
  {
    id: 'deactivation',
    title: 'Appealing a deactivation',
    body: 'A deactivated Dasher receives an email naming the policy that applied and a link to the appeal form. Appeals are reviewed by a person within about a week, and the decision is sent by email. Deactivations for low completion rate or low customer rating can be appealed once; deactivations for fraud or safety violations are reviewed case by case. Supporting evidence such as screenshots or delivery photos can be attached to the appeal form.',
  },
  {
    id: 'red-card',
    title: 'The Red Card and declined payments',
    body: 'The Red Card is only used for orders the app marks as Shop and Pay or Pay with Red Card; it is never used for a Dasher\u2019s own purchases. If the card is declined at checkout, confirm that the items in the cart match the order and that the total is within the amount shown in the app, then try again. A card that is still declined should be reported through the Dasher app so the order can be reassigned or paid another way. The Dasher is paid for the time spent even when the order is cancelled at checkout.',
  },
  {
    id: 'vehicle',
    title: 'Vehicles, insurance and what the Dasher needs to carry',
    body: 'Dashers can deliver by car, scooter, bicycle or on foot depending on the market, and the vehicle type can be changed in the app before a dash starts. Dashers who drive must keep their own auto insurance as required by their state; occupational accident insurance covers medical costs for injuries during an active delivery at no cost to the Dasher. An insulated bag is required for restaurant deliveries and can be ordered from the Dasher store.',
  },
  {
    id: 'referrals',
    title: 'Referral bonuses',
    body: 'A Dasher can refer a friend from the Refer tab, and both receive the bonus once the new Dasher completes the required number of deliveries within the stated window, usually thirty days. The bonus amount and the delivery requirement depend on the market and are shown on the referral page before the invitation is sent. Referral bonuses are paid with the regular weekly payout and are not eligible for Fast Pay.',
  },
];

const articlesPy = ARTICLES.map(
  a => `    {"id": ${JSON.stringify(a.id)}, "title": ${JSON.stringify(a.title)}, "body": ${JSON.stringify(a.body)}},`,
).join('\n');
const articlesTs = ARTICLES.map(
  a => `  {id: ${JSON.stringify(a.id)}, title: ${JSON.stringify(a.title)}, body: ${JSON.stringify(a.body)}},`,
).join('\n');

export const supportModules: Record<string, string> = {
  'assistant/__init__.py': '',
  'assistant/config.py': `"""Addresses, topics and limits every step of the assistant agrees on."""
# The stand-in model server (served by the harness) at two addresses, and the LLM judge.
LLM_LARGE = "llm-large:50051"
LLM_SMALL = "llm-small:50051"
JUDGE = "judge:50051"
# Kafka: one record per answered turn, keyed by session; the offline judge's consumer group.
TOPIC = "support-conversations"
GROUP = "quality-judge"
# Redis
HISTORY_TTL_S = 86400
CACHE_TTL_S = 3600
RATE_LIMIT_PER_MINUTE = 20
# Retrieval and generation
TOP_K = 4
MAX_TOKENS = 120
DEADLINE_S = 2.0
MIN_SIMILARITY = 0.3
HANDOFF_TEXT = "I've passed this to a support agent, who will follow up with you shortly."
`,
  'assistant/embed.py': `"""
Deterministic text embeddings for the course: a TF-IDF vector over the knowledge base's vocabulary
(each word a dimension, weighted by how rare it is across the KB's chunks; words the KB never saw
share a hashed band at the end), L2-normalised, 512 dimensions. Not a language model — a stand-in
with the properties retrieval relies on: the same text always gives the same vector, texts sharing
rare words land close together (cosine), and function words count for nothing. \`to_pgvector\` writes
a vector the way pgvector reads it: "[0.1,0.2,...]".
"""
import math
import re

from . import chunk as _chunk
from . import kb as _kb

DIM = 512
_WORD = re.compile(r"[a-z0-9]+")
# Function words carry no topic; without them a question's vector points at its subject, as a real embedding's would.
STOP_WORDS = frozenset(
    "a an and are as at be been but by can could did do does for from get got had has have he her his how i if in is it its me my no not of on or our she so that the their them they this to up us was we were what when where which who will with would you your".split()
)


def tokenize(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in STOP_WORDS]


def count_tokens(text: str) -> int:
    return len(tokenize(text))


def _fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# The vocabulary and document frequencies come from the KB's chunks, so every process computes the same vector.
_CHUNKS = [c for a in _kb.ARTICLES for c in _chunk.chunk(a["body"])]
_DF: dict[str, int] = {}
for _text in _CHUNKS:
    for _w in set(tokenize(_text)):
        _DF[_w] = _DF.get(_w, 0) + 1
VOCAB = sorted(_DF)
_INDEX = {w: i for i, w in enumerate(VOCAB)}
_N = len(_CHUNKS)


def idf(word: str) -> float:
    """log(1 + N/df): a word in every chunk weighs little, a word in one weighs most; an unseen word most of all."""
    return math.log(1 + _N / _DF.get(word, 0.5))


def _slot(word: str) -> int:
    i = _INDEX.get(word)
    return i if i is not None else len(VOCAB) + _fnv1a(word) % (DIM - len(VOCAB))


def embed(text: str) -> list[float]:
    v = [0.0] * DIM
    for tok in tokenize(text):
        v[_slot(tok)] += idf(tok)
    norm = math.sqrt(sum(x * x for x in v))
    if norm == 0:
        return v
    return [round(x / norm, 6) for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def to_pgvector(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def from_pgvector(s: str) -> list[float]:
    return [float(x) for x in s.strip("[]").split(",") if x]
`,
  'assistant/chunk.py': `"""Fixed-size word windows with overlap: the chunking every step and the harness agree on."""

CHUNK_WORDS = 48
OVERLAP_WORDS = 12


def chunk(text: str, size: int = CHUNK_WORDS, overlap: int = OVERLAP_WORDS) -> list[str]:
    words = text.split()
    if not words:
        return []
    step = size - overlap
    out = []
    start = 0
    while True:
        out.append(" ".join(words[start : start + size]))
        if start + size >= len(words):
            break
        start += step
    return out
`,
  'assistant/kb.py': `"""The support knowledge base: ten short articles. Chunk ids are "<article>-<position>"."""

ARTICLES: list[dict] = [
${articlesPy}
]


def article(article_id: str) -> dict | None:
    for a in ARTICLES:
        if a["id"] == article_id:
            return a
    return None
`,
  'assistant/prompt.py': `"""
The one prompt format: instructions, the retrieved chunks as "[kb:<id>] <text>" lines, the
conversation so far, then the question. The stand-in model reads chunk ids from these lines, which
is what lets a check tell a grounded answer from an invented one.
"""

INSTRUCTIONS = (
    "You are a Dasher support assistant. Answer only from the context below and cite the chunks you "
    "use as [kb:<id>]. If the context does not answer the question, say so."
)


def build_prompt(question: str, chunks: list[dict], history: list[dict] | None = None) -> str:
    lines = [INSTRUCTIONS, "", "Context:"]
    for c in chunks:
        lines.append(f"[kb:{c['id']}] {c['text']}")
    lines.append("")
    lines.append("History:")
    for turn in history or []:
        lines.append(f"{turn['role']}: {turn['text']}")
    lines.append("")
    lines.append(f"Question: {question}")
    lines.append("Answer:")
    return "\\n".join(lines)


def cited_ids(answer: str) -> list[str]:
    """Chunk ids an answer cites, in order, without duplicates."""
    import re

    out: list[str] = []
    for m in re.finditer(r"\\[kb:([^\\]]+)\\]", answer):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out
`,
  'assistant/model.py': `"""
The stand-in for the model server and the LLM judge. The harness serves these over gRPC (Llm at
llm-large:50051 / llm-small:50051, Judge at judge:50051); the learner's code never calls them
directly. Deterministic on purpose: the course grades what the system around a model does — grounds
it, bounds it, times it out, judges it, escalates — never the prose.

complete(prompt, max_tokens, mode):
  "faithful"     cites the first two context chunks and answers with the first sentence of the top one
  "hallucinate"  invents a policy and cites a chunk that was never retrieved ([kb:policy-404])
  "verbose"      the faithful answer followed by filler, so max_tokens has to cut it
  With no context chunks in the prompt the model says the documentation does not cover it (no citation).
"""
import re

_CHUNK_LINE = re.compile(r"^\\[kb:([^\\]]+)\\]\\s*(.*)$", re.MULTILINE)
_CITE = re.compile(r"\\[kb:([^\\]]+)\\]")
_RISKY = re.compile(r"guarantee|promise|lawsuit|legal action", re.IGNORECASE)

NO_CONTEXT_TEXT = "The documentation available to me does not cover this; a support agent can help."


def _first_sentence(text: str) -> str:
    m = re.search(r"[^.!?]*[.!?]", text)
    return (m.group(0) if m else text).strip()


def tokens(text: str) -> list[str]:
    """The text as the model streams it: words, each but the last carrying its trailing space."""
    words = text.split()
    return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]


def truncate(text: str, max_tokens: int) -> str:
    words = text.split()
    return " ".join(words[:max_tokens]) if max_tokens > 0 else ""


def complete(prompt: str, max_tokens: int, mode: str = "faithful") -> str:
    chunks = _CHUNK_LINE.findall(prompt)
    if mode == "hallucinate":
        text = "Your issue will be resolved within 7 days, guaranteed [kb:policy-404]."
    elif not chunks:
        text = NO_CONTEXT_TEXT
    else:
        cites = "".join(f"[kb:{cid}]" for cid, _ in chunks[:2])
        text = f"Based on {cites}: {_first_sentence(chunks[0][1])}"
        if mode == "verbose":
            text += " " + " ".join(["Additionally, please note that this may vary by market and over time."] * 40)
    return truncate(text, max_tokens)


def evaluate(question: str, answer: str, context_ids: list[str]) -> dict:
    """The judge's rubric: groundedness (citations within the context), coherence (length), compliance (no promises)."""
    cited = _CITE.findall(answer)
    if not cited:
        groundedness = 0.0
    else:
        groundedness = sum(1 for c in cited if c in context_ids) / len(cited)
    words = len(answer.split())
    coherence = 1.0 if 3 <= words <= 160 else 0.4
    compliance = 0.0 if _RISKY.search(answer) else 1.0
    return {
        "groundedness": round(groundedness, 3),
        "coherence": coherence,
        "compliance": compliance,
        "pass": groundedness >= 0.8 and coherence >= 0.8 and compliance >= 0.8,
    }
`,
  'assistant/db.py': `"""
The assistant's Postgres (PGlite with pgvector): \`await db.execute(sql, params)\` for one statement,
\`async with db.transaction() as cur:\` for several; %s placeholders; dict rows. SCHEMA is what the
harness applies before a check.

Tables:
    kb_chunks      (id text primary key, article text, position int, text text, embedding vector(512))
    quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
                    primary key (session_id, turn))
"""
from leetbuild.db import DB as db

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE kb_chunks (
  id text PRIMARY KEY,
  article text NOT NULL,
  position int NOT NULL,
  text text NOT NULL,
  embedding vector(512) NOT NULL
);
CREATE TABLE quality_scores (
  session_id text NOT NULL,
  turn int NOT NULL,
  groundedness real NOT NULL,
  coherence real NOT NULL,
  compliance real NOT NULL,
  pass boolean NOT NULL,
  PRIMARY KEY (session_id, turn)
);
"""

__all__ = ["db", "SCHEMA"]
`,
};

export const supportModulesTs: Record<string, string> = {
  'assistant/config.ts': `/** Addresses, topics and limits every step of the assistant agrees on. */
// The stand-in model server (served by the harness) at two addresses, and the LLM judge.
export const LLM_LARGE = 'llm-large:50051';
export const LLM_SMALL = 'llm-small:50051';
export const JUDGE = 'judge:50051';
// Kafka: one record per answered turn, keyed by session; the offline judge's consumer group.
export const TOPIC = 'support-conversations';
export const GROUP = 'quality-judge';
// Redis
export const HISTORY_TTL_S = 86400;
export const CACHE_TTL_S = 3600;
export const RATE_LIMIT_PER_MINUTE = 20;
// Retrieval and generation
export const TOP_K = 4;
export const MAX_TOKENS = 120;
export const DEADLINE_S = 2.0;
export const MIN_SIMILARITY = 0.3;
export const HANDOFF_TEXT = "I've passed this to a support agent, who will follow up with you shortly.";
`,
  'assistant/embed.ts': `/**
 * Deterministic text embeddings for the course: a TF-IDF vector over the knowledge base's vocabulary
 * (each word a dimension, weighted by how rare it is across the KB's chunks; words the KB never saw
 * share a hashed band at the end), L2-normalised, 512 dimensions. Not a language model — a stand-in
 * with the properties retrieval relies on: the same text always gives the same vector, texts sharing
 * rare words land close together (cosine), and function words count for nothing. \`toPgvector\` writes
 * a vector the way pgvector reads it: "[0.1,0.2,...]". The same numbers as the Python module.
 */
import {chunk} from './chunk';
import {ARTICLES} from './kb';

export const DIM = 512;

/** Function words carry no topic; without them a question's vector points at its subject, as a real embedding's would. */
export const STOP_WORDS = new Set(
  'a an and are as at be been but by can could did do does for from get got had has have he her his how i if in is it its me my no not of on or our she so that the their them they this to up us was we were what when where which who will with would you your'.split(
    ' ',
  ),
);

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !STOP_WORDS.has(w));

export const countTokens = (text: string): number => tokenize(text).length;

const encoder = new TextEncoder();

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

// The vocabulary and document frequencies come from the KB's chunks, so every process computes the same vector.
const CHUNKS = ARTICLES.flatMap(a => chunk(a.body));
const DF = new Map<string, number>();
for (const text of CHUNKS) for (const w of new Set(tokenize(text))) DF.set(w, (DF.get(w) ?? 0) + 1);
export const VOCAB = [...DF.keys()].sort();
const INDEX = new Map(VOCAB.map((w, i) => [w, i]));
const N = CHUNKS.length;

/** log(1 + N/df): a word in every chunk weighs little, a word in one weighs most; an unseen word most of all. */
export const idf = (word: string): number => Math.log(1 + N / (DF.get(word) ?? 0.5));

const slot = (word: string): number => INDEX.get(word) ?? VOCAB.length + (fnv1a(word) % (DIM - VOCAB.length));

export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of tokenize(text)) v[slot(tok)] += idf(tok);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map(x => Math.round((x / norm) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const toPgvector = (v: number[]): string => '[' + v.map(x => x.toFixed(6)).join(',') + ']';

export const fromPgvector = (s: string): number[] =>
  s
    .replace(/^\\[|\\]$/g, '')
    .split(',')
    .filter(x => x !== '')
    .map(Number);
`,
  'assistant/chunk.ts': `/** Fixed-size word windows with overlap: the chunking every step and the harness agree on. */
export const CHUNK_WORDS = 48;
export const OVERLAP_WORDS = 12;

export function chunk(text: string, size = CHUNK_WORDS, overlap = OVERLAP_WORDS): string[] {
  const words = text.split(/\\s+/).filter(w => w !== '');
  if (words.length === 0) return [];
  const step = size - overlap;
  const out: string[] = [];
  let start = 0;
  for (;;) {
    out.push(words.slice(start, start + size).join(' '));
    if (start + size >= words.length) break;
    start += step;
  }
  return out;
}
`,
  'assistant/kb.ts': `/** The support knowledge base: ten short articles. Chunk ids are "<article>-<position>". */
export interface Article {
  id: string;
  title: string;
  body: string;
}

export const ARTICLES: Article[] = [
${articlesTs}
];

export const article = (id: string): Article | undefined => ARTICLES.find(a => a.id === id);
`,
  'assistant/prompt.ts': `/**
 * The one prompt format: instructions, the retrieved chunks as "[kb:<id>] <text>" lines, the
 * conversation so far, then the question. The stand-in model reads chunk ids from these lines, which
 * is what lets a check tell a grounded answer from an invented one.
 */
export interface Chunk {
  id: string;
  text: string;
  score?: number;
}

export interface Turn {
  role: 'dasher' | 'assistant';
  text: string;
}

export const INSTRUCTIONS =
  'You are a Dasher support assistant. Answer only from the context below and cite the chunks you ' +
  'use as [kb:<id>]. If the context does not answer the question, say so.';

export function buildPrompt(question: string, chunks: Chunk[], history: Turn[] = []): string {
  const lines = [INSTRUCTIONS, '', 'Context:'];
  for (const c of chunks) lines.push(\`[kb:\${c.id}] \${c.text}\`);
  lines.push('', 'History:');
  for (const turn of history) lines.push(\`\${turn.role}: \${turn.text}\`);
  lines.push('', \`Question: \${question}\`, 'Answer:');
  return lines.join('\\n');
}

/** Chunk ids an answer cites, in order, without duplicates. */
export function citedIds(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\\[kb:([^\\]]+)\\]/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
`,
  'assistant/model.ts': `/**
 * The stand-in for the model server and the LLM judge. The harness serves these over gRPC (Llm at
 * llm-large:50051 / llm-small:50051, Judge at judge:50051); the learner's code never calls them
 * directly. Deterministic on purpose: the course grades what the system around a model does — grounds
 * it, bounds it, times it out, judges it, escalates — never the prose.
 *
 * complete(prompt, maxTokens, mode):
 *   'faithful'     cites the first two context chunks and answers with the first sentence of the top one
 *   'hallucinate'  invents a policy and cites a chunk that was never retrieved ([kb:policy-404])
 *   'verbose'      the faithful answer followed by filler, so maxTokens has to cut it
 *   With no context chunks in the prompt the model says the documentation does not cover it (no citation).
 */
export type Mode = 'faithful' | 'hallucinate' | 'verbose';

export const NO_CONTEXT_TEXT = 'The documentation available to me does not cover this; a support agent can help.';

const firstSentence = (text: string): string => (/[^.!?]*[.!?]/.exec(text)?.[0] ?? text).trim();

/** The text as the model streams it: words, each but the last carrying its trailing space. */
export function tokens(text: string): string[] {
  const words = text.split(/\\s+/).filter(w => w !== '');
  return words.map((w, i) => (i < words.length - 1 ? w + ' ' : w));
}

export function truncate(text: string, maxTokens: number): string {
  const words = text.split(/\\s+/).filter(w => w !== '');
  return maxTokens > 0 ? words.slice(0, maxTokens).join(' ') : '';
}

export function complete(prompt: string, maxTokens: number, mode: Mode = 'faithful'): string {
  const chunks = [...prompt.matchAll(/^\\[kb:([^\\]]+)\\]\\s*(.*)$/gm)].map(m => [m[1], m[2]] as const);
  let text: string;
  if (mode === 'hallucinate') text = 'Your issue will be resolved within 7 days, guaranteed [kb:policy-404].';
  else if (chunks.length === 0) text = NO_CONTEXT_TEXT;
  else {
    const cites = chunks
      .slice(0, 2)
      .map(([id]) => \`[kb:\${id}]\`)
      .join('');
    text = \`Based on \${cites}: \${firstSentence(chunks[0][1])}\`;
    if (mode === 'verbose')
      text += ' ' + Array(40).fill('Additionally, please note that this may vary by market and over time.').join(' ');
  }
  return truncate(text, maxTokens);
}

export interface Scores {
  groundedness: number;
  coherence: number;
  compliance: number;
  pass: boolean;
}

/** The judge's rubric: groundedness (citations within the context), coherence (length), compliance (no promises). */
export function evaluate(question: string, answer: string, contextIds: string[]): Scores {
  const cited = [...answer.matchAll(/\\[kb:([^\\]]+)\\]/g)].map(m => m[1]);
  const groundedness =
    cited.length === 0 ? 0 : Math.round((cited.filter(c => contextIds.includes(c)).length / cited.length) * 1000) / 1000;
  const words = answer.split(/\\s+/).filter(w => w !== '').length;
  const coherence = words >= 3 && words <= 160 ? 1 : 0.4;
  const compliance = /guarantee|promise|lawsuit|legal action/i.test(answer) ? 0 : 1;
  return {groundedness, coherence, compliance, pass: groundedness >= 0.8 && coherence >= 0.8 && compliance >= 0.8};
}
`,
  'assistant/db.ts': `/**
 * The assistant's Postgres (PGlite with pgvector): \`await pool.query(sql, [params])\` runs one statement
 * ($1… placeholders) and returns \`{rows, rowCount}\`; \`const client = await pool.connect()\` checks the
 * connection out for a transaction (BEGIN … COMMIT on the client, then \`client.release()\`). SCHEMA is
 * what the harness applies before a check.
 *
 * Tables:
 *     kb_chunks      (id text primary key, article text, position int, text text, embedding vector(512))
 *     quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
 *                     primary key (session_id, turn))
 */
import {Pool} from 'pg';

export const pool = new Pool({connectionString: 'postgres://assistant@db/assistant'});

export const SCHEMA = \`
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE kb_chunks (
  id text PRIMARY KEY,
  article text NOT NULL,
  position int NOT NULL,
  text text NOT NULL,
  embedding vector(512) NOT NULL
);
CREATE TABLE quality_scores (
  session_id text NOT NULL,
  turn int NOT NULL,
  groundedness real NOT NULL,
  coherence real NOT NULL,
  compliance real NOT NULL,
  pass boolean NOT NULL,
  PRIMARY KEY (session_id, turn)
);
\`;
`,
};
