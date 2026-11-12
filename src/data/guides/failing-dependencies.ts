import type {Source} from '@/lib/types';

/**
 * The failure-mode guide "When a dependency fails": what a service answers when the call it depends
 * on cannot succeed. Rendered at `/guides/failing-dependencies`.
 */
export const guide = `# The failure mode

Every service in these courses leans on something it does not control: a model behind gRPC, a pricing
service, an identity vendor, three index shards, an evaluator. Sooner or later the call fails. It
times out, it answers \`UNAVAILABLE\`, the whole fleet behind it is down for an hour. The failure mode
is not the outage. It is what the code **answers** while the outage lasts.

Here is the smallest instance, a scorer that decides whether a payment goes through:

\`\`\`python
def score(tx):
    try:
        reply = model.Score(tx, timeout=0.3)
        return {"score": reply.score, "band": band_of(reply.score)}
    except grpc.RpcError:
        return {"score": 0.0, "band": "approve"}
\`\`\`

With the model healthy, every test passes. With the model down, every payment is scored as perfectly
safe and approved, and nothing in the response says so. The \`except\` branch did not handle the failure;
it **invented an answer** and gave it the same shape as a real one. Downstream, a dashboard shows the
fraud rate falling during the outage, which is the opposite of what happened.

Every branch that runs when a dependency fails has to answer one question: _what will the caller do
with this?_ There are only a few honest answers:

- **A fallback that says it is one**: a cheaper method (rules, a popularity order, an extract), marked
  as a fallback and kept out of any decision that acts.
- **A degraded answer**: less than the full answer, but nothing false (no caption, unscored, unattributed).
- **No answer**: fail closed. No verdict means no promotion, no grant, no approval.
- **A person**: the item goes to a review queue with the reason it is there.
- **Last-good data**: what the dependency said recently, inside a stated bound on staleness.

And one thing never happens: the failure is not **remembered** as if it were the dependency's answer.

# How it shows up

The courses hide this mode in their dependency steps. The starters work against a healthy stand-in; the
flaws appear only once the stand-in is made to fail. A few of them:

- [Fraud Scoring, step 3](/fraud-scoring/3-dependency): an outage turns into a confident verdict, and
  the verdict is the one that lets money move.
- [AI Cost Meter, step 3](/cost-meter/3-dependency): a failed pricing call still produces a price, and
  the service holds on to it longer than anyone intended.
- [Prompt Registry, step 3](/prompt-registry/3-dependency): an evaluator that cannot answer is read as
  an evaluator that approved, and the answer is kept for a day.
- [KYC Verification, step 3](/kyc-verification/3-dependency): during a vendor outage the approval rate
  goes **up**.
- [Vector Search Service, step 3](/vector-search/3-dependency): a shard that does not answer looks
  exactly like a shard with no matches, and the response still claims to be complete.
- [Shadow Evaluation, step 3](/shadow-eval/3-dependency): a call whose answer nobody uses can still
  fail the request a user is waiting on.
- [Model Router, step 3](/model-router/3-model-call): every replica keeps hammering a model that has
  been failing for a minute, each discovering the outage on its own.
- [Autocomplete, step 3](/autocomplete-service/3-dependency): the answer given during an outage outlives
  the outage.

The symptoms rhyme. Metrics improve during an incident (fewer rejections, more approvals, lower costs).
A count of "results" does not drop when a dependency is down. Users see stale or empty answers long after
the dependency recovered. And the logs say \`200\` for requests that never reached the thing they depend on.

# The mechanism

## The failure branch is shaped like success

Code that calls a dependency has two paths and one return type. The happy path fills the type from the
reply; the failure path has to fill it with _something_, and the easiest something is a default:
\`0.0\`, \`[]\`, \`"approve"\`, \`FALLBACK_RATE\`, the active model. Defaults are chosen for convenience,
not meaning, and a default in a field that drives a decision is a decision.

Three habits make it worse:

1. **Catching everything.** \`except Exception\` or \`except grpc.RpcError\` folds a hang, an outage, a
   refusal (\`INVALID_ARGUMENT\`, a content-policy block) and a bug into one branch. They need different
   answers: a refusal is the dependency's real verdict about _this_ input; an outage says nothing about it.
2. **No marker.** The response carries no field that tells a fallback from a real answer, so nothing
   downstream (a band, a cache, an event, a metric) can treat it differently.
3. **Memory.** The value from the failure branch flows into the same cache write as a real answer and is
   served for the cache's whole TTL.

## The outage everyone discovers separately

Without a breaker, every request pays the full deadline to learn that the dependency is down, and every
retry adds load to a service that is already drowning. A breaker remembers the outage so the next
thousand requests do not have to rediscover it. It has three states:

| State | Calls the dependency? | Moves to | When |
| --- | --- | --- | --- |
| Closed | yes, every request | Open | failures in the window reach the threshold |
| Open | no, answers at once without calling | Half-open | the open period (say 30 s) has passed |
| Half-open | one probe, everyone else as if open | Closed, or Open again | the probe succeeds, or it fails |

A breaker kept in process memory is one breaker per replica: twenty replicas each pay five failures
before tripping, and each probes on its own schedule. In these courses the breaker lives in **Redis**, so
every replica shares one count and one open flag:

:::sequence
{
  "participants": ["replica A", "replica B", "Redis", "model"],
  "messages": [
    {"from": "replica A", "to": "Redis", "label": "GET circuit:model → (nil): closed", "kind": "sync"},
    {"from": "replica A", "to": "model", "label": "Score · deadline 300 ms", "kind": "sync"},
    {"from": "model", "to": "replica A", "label": "UNAVAILABLE", "kind": "reply"},
    {"from": "replica A", "to": "Redis", "label": "INCR fails:model → 5 (window 30 s)", "kind": "sync"},
    {"from": "replica A", "to": "Redis", "label": "SET circuit:model open EX 30", "kind": "sync"},
    {"from": "replica B", "to": "Redis", "label": "GET circuit:model → open: skip the call, answer the fallback", "kind": "sync"},
    {"from": "replica B", "to": "Redis", "label": "t = 30 s · circuit:model expired · SET probe:model 1 NX EX 5 → OK", "kind": "sync"},
    {"from": "replica B", "to": "model", "label": "one probe", "kind": "sync"},
    {"from": "model", "to": "replica B", "label": "OK: DEL fails:model, closed again", "kind": "reply"}
  ]
}
:::

A minimal shared breaker:

\`\`\`python
def breaker_open(dep):
    return r.get(f"circuit:{dep}") == "open"

def record_failure(dep):
    key = f"fails:{dep}"
    n = r.incr(key)
    if n == 1:
        r.expire(key, WINDOW_S)            # the count lives one window
    if n >= THRESHOLD:
        r.set(f"circuit:{dep}", "open", ex=OPEN_S)

def record_success(dep):
    r.delete(f"fails:{dep}")
\`\`\`

Two choices decide whether it is right.

**What counts as a failure.** \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say the dependency is unwell.
\`INVALID_ARGUMENT\`, \`NOT_FOUND\` or a policy refusal say the dependency is fine and the _input_ is not; a
breaker that counts them opens because one tenant sends bad requests, and takes the dependency away from
everyone. The same classification decides retries (see
[deadlines and retries](/guides/deadlines-and-retries)).

**Who probes.** When the open period ends, every replica sees "closed" at the same instant. Without a gate,
all of them call at once, which is the load spike the breaker existed to prevent. One \`SET … NX\` with a
short expiry elects a single prober; the rest keep answering as if open until the probe settles it. The
\`INCR\` then \`EXPIRE\` pair is two commands, so a crash between them leaves a counter that never expires;
a script or a pipeline closes that gap (see [atomic state](/guides/atomic-state)).

:::details A count, a rate, or a sliding window?
The snippet trips on a **count** of failures inside a fixed window. It is simple and good enough when
traffic is steady, but five failures mean very different things at 10 requests a minute and at 10 000.
Production breakers (Hystrix, resilience4j, Envoy's outlier detection) usually trip on a **failure rate**
over a minimum number of calls in a sliding window, so a quiet dependency is not tripped by two bad calls
and a busy one is not kept closed by a flood of successes hiding a 30% error rate. Whatever the rule, the
check is the same: injected failures open it, the open state skips the call, and the open period ends
with exactly one probe.
:::

:::quiz
Q: A breaker counts every \`grpc.RpcError\` as a failure. What goes wrong?
- [ ] Nothing: an error is an error
- [x] One caller sending invalid input can open the breaker and cut every caller off from a healthy dependency
- [ ] The breaker never opens, because refusals are not errors
- [ ] The probe in the half-open state always fails
> A refusal (\`INVALID_ARGUMENT\`, \`NOT_FOUND\`, a policy block) is the dependency working correctly. Only the statuses that describe the dependency's health (\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`) belong in the count; the rest are answers to that one request.
:::

# The fix

The fix is a decision per dependency, made ahead of time: when this call cannot succeed, which honest
answer does the caller get? The answer depends on what the result is used for.

## Fallbacks that say so, and never act

A fallback is a second method for the same question: a keyword ruleset instead of a classifier, the
popularity order instead of a ranking model, the extractive lead instead of a summary, a regex scan
instead of a detector. It is useful only if everything downstream can tell it apart:

\`\`\`python
def score(tx):
    if not breaker_open("model"):
        try:
            reply = model.Score(tx, timeout=0.3)
            record_success("model")
            return {"score": reply.score, "band": band_of(reply.score), "fallback": False}
        except grpc.RpcError as e:
            if e.code() not in RETRYABLE:
                raise                      # a refusal is an answer, not an outage
            record_failure("model")
    verdict = rules.score(tx)
    band = band_of(verdict.score)
    if band == "approve":
        band = "review"                    # a fallback never lands in a band that acts
    return {"score": verdict.score, "band": band, "fallback": True, "reason": "model unavailable"}
\`\`\`

The marker is the point: it lets the band logic cap the fallback, lets the event stream carry it, lets the
read path count fallbacks separately, and lets an alert fire when the fallback share rises. The cap is the
other half. A cheaper method is weaker evidence, so it can **block** or **queue**, but it should not take
the one action that a mistake makes expensive (approving a payment, labelling content safe, merging two
entities).

The [Amazon Builders' Library](https://builder.aws.com/content/3EuS9Sakq7L3VLQIF3qzfMfke1Y/avoiding-fallback-in-distributed-systems)
argues the opposite case well: fallbacks are rarely exercised, hard to test and can amplify an outage
(their 2001 cache fallback sent the whole website's load to one database). Take that seriously. A fallback
must be cheap, local and tested by injecting the outage, or it should not exist.

## Degraded, not wrong

When there is no second method, answer less instead of answering wrong. A caption the vision model could
not write is **no caption, marked degraded**, with the asset queued for a backfill; it is not an empty
caption that looks like a deliberate one. A rerank batch that failed is **unscored**, not scored \`0.0\`. A
feedback event whose model lookup failed is **unattributed**, not attributed to whichever model is active
now. The test of a degraded answer: could a consumer reading it draw a false conclusion? \`score: 0.0\`
can; \`score: null, degraded: true\` cannot.

:::quiz
Q: The reranker times out on one batch of 64 candidates. Which answer is degraded rather than wrong?
- [ ] Give those 64 a score of 0.0 so they sort last
- [ ] Give them the average score of the other batches
- [x] Return them marked unscored, below the scored ones, and say how many were unscored
- [ ] Retry until the batch succeeds, however long it takes
> A zero and an average are both numbers the model never produced; a consumer cannot tell them from real scores. Marking the batch unscored keeps the order useful and the response honest, and a count lets the caller decide whether that is good enough.
:::

## Failing closed, failing open

Some answers gate an action: promote this prompt, grant this capacity, approve this applicant, merge these
two records, let this prompt through to the model. For a gate, "no answer" has to mean **no**:

| The gate | No verdict means | Why |
| --- | --- | --- |
| Eval before a promotion | the version stays pending, the pointer does not move | shipping an unevaluated version is the risk the gate exists for |
| Capacity confirmation | no grant | a grant on a full pool oversells it |
| Identity vendor check | manual review, marked degraded | only the vendor's own APPROVED approves |
| Entity match score | the pair is parked for review | a wrong merge is hard to undo |
| Prompt-injection detector | blocked, unless the tenant chose fail open | the detector is the control |

Failing open is right when the dependency is **advisory** and blocking costs more than the risk it
covers: a shadow call, an enrichment, a spelling suggestion, a recommendation. Even then it is an explicit,
named choice (a \`fail_open\` setting a tenant turns on), logged when it is used, never the accidental
result of an \`except\` that returns the permissive default.

:::details Why "retry until the deadline" is not failing closed
A gate that polls the evaluator for 30 seconds and then promotes anyway has not failed closed; it has
failed open slowly. The same is true of a loop that treats an \`RpcError\` as a pass after enough attempts.
Failing closed means the state after the failure is the state before the request: the pointer where it
was, the version pending, the item in a queue, and an answer to the caller that says so (a \`503\`, or a
\`pending\` status they can poll).
:::

## Never remember a failure

A cache stores answers, and a fallback is not the dependency's answer. Cache only what came back from a
successful call:

\`\`\`python
def suggestions(prefix):
    hit = cache.get(key(prefix))
    if hit is not None:
        return hit
    try:
        result = suggester.Suggest(prefix, timeout=0.15)
    except grpc.RpcError:
        return {"items": popular_for(prefix), "fallback": True, "version": FALLBACK_VERSION}
    cache.set(key(prefix), result, ex=TTL_S)   # only the real answer is remembered
    return result
\`\`\`

A cached fallback is an outage that outlives the outage: the dependency recovers in a minute and users keep
getting the fallback for the cache's TTL. The same applies to a negative result produced by a failure: a
pricing call that failed is not "this model has no price", and a verdict that never came is not a failed
verdict. Memory also includes events and ledgers: a cost written with a made-up rate, or a summary event
that claims the model wrote an extract, is a remembered failure too.

## Last-good data, with a bound

Some data changes rarely and is safer stale than absent: a pricing table, a feature vector, the last
approved price. Keeping the last good copy is a fallback, so it follows the same rules, plus one more:
**a bound on how stale it may be**.

\`\`\`python
def rates():
    try:
        table = pricing.GetRates(timeout=0.2)
        r.set("rates:last_good", encode(table, fetched_at=now()))
        return table, False
    except grpc.RpcError:
        last = decode(r.get("rates:last_good"))
        if last is None or now() - last.fetched_at > MAX_STALE_S:
            raise PricingUnavailable()          # too old to trust: fail, do not guess
        return last.table, True                  # stale, and the caller is told
\`\`\`

Without the bound, a pricing service that is down for a week bills a week at last week's prices without a
word. With it, the staleness is a number someone chose and a flag the response carries. The bound has to
be checked against when the data was **fetched**, not when it was last read, or every read keeps it fresh.

:::quiz
Q: The pricing service fails and the meter prices from its last good table. Which detail matters most?
- [ ] The last good table is kept in process memory for speed
- [x] The table carries when it was fetched, and past the bound the meter stops pricing instead of guessing
- [ ] The fallback rate is the most expensive model's rate, to be safe
- [ ] The failure is cached for a minute so the service can recover
> Last-good data is only honest while it is fresh enough. A fetch timestamp and a bound turn "stale forever" into "stale for at most an hour, flagged", and a cached failure would keep pricing broken after the service recovers.
:::

## Quorum and partial results, reported

A scatter-gather (index shards, regional replicas, several handlers) can lose one part and still answer.
Whether it should is a rule, not an accident: a **quorum** (two of three shards) below which the request
fails, and above which the response says what it is made of:

\`\`\`json
{"hits": [...], "partial": true, "answered": 2, "required": 2, "missing": ["shard-2"]}
\`\`\`

The flaw is treating a missing part as an empty one. A shard that timed out and a shard with no matches
both contribute zero hits; only the first makes the response partial. The same goes for a backfill whose
partition failed (report it missing, not empty) and a form whose handler failed (partial until every
handler took it).

## A side path never fails the request

Shadow traffic, enrichment, analytics, a CRM sync, a receipt signer: work the request triggers but does not
need for its answer. Its failures must stay on its side of the line:

- its own short deadline, and usually one attempt (a shadow is a sample; a missed sample costs nothing);
- its exceptions caught at the boundary, counted (\`dropped\`), never re-raised into the request;
- often off the request path entirely: a background task, or an outbox that a worker drains later;
- a breaker, so a failing candidate stops costing anything at all.

The counter is not optional. A shadow evaluation that silently drops half its samples compares the two
models on a biased half.

## Routing to people

When the automated answer is unavailable and the decision matters, the honest fallback is a person: a
review queue entry that names **why** it is there (\`classifier unavailable\`, \`vendor timeout\`, \`below
the confidence floor\`). The queue is a degraded mode with a cost, so it needs the same visibility as a
breaker: its depth, the share of items that arrived because of an outage, and an alert when that share
rises.

:::details Trade-offs in one place
Every honest answer costs something. A fallback adds code that runs rarely and must be tested on purpose.
Failing closed turns a dependency's outage into your outage for that feature. Last-good data is a promise
about freshness someone has to choose. A quorum answers less than everything. Routing to people moves load
onto humans exactly when the system is struggling. The alternative, a confident wrong answer, costs nothing
during the outage and everything afterwards, when the approvals, the bills and the merged records have to
be found and undone.
:::

# Proving it

The starters pass against a healthy stand-in, so the proof has to make the stand-in fail on purpose and
check the **outcome**, not the code's shape:

| Inject | Expect |
| --- | --- |
| \`UNAVAILABLE\` on every call | the labelled fallback (or degraded, or no answer), never the band that acts |
| a hang past the deadline | the call cut at the deadline, the same answer as an outage |
| \`INVALID_ARGUMENT\` or a refusal | a terminal answer after one call, the breaker count unchanged |
| five failures, then a sixth request | the sixth never reaches the dependency |
| recovery, then the same request | the real answer, not a cached fallback |
| one shard down of three | a partial response that names the missing shard |
| two shards down of three | a failure, not a thin answer |
| a failing side path | the main response unchanged, the drop counted |

Breakers and staleness bounds are about time, and real sleeps make tests slow and flaky. Read the time
through one function and drive it in the test, the same way the Redis expiries are driven:

\`\`\`python
def test_breaker_opens_then_probes_once(dep, clock):
    dep.fail_with(UNAVAILABLE)
    for _ in range(5):
        score(TX)
    calls = dep.calls
    assert score(TX)["fallback"] is True and dep.calls == calls      # open: no call made

    clock.advance(31)                                                 # past the open period
    dep.heal()
    assert score(TX)["fallback"] is False                             # the probe gets the real answer
    assert dep.calls == calls + 1                                     # and it was one call
    score(TX)
    assert dep.calls == calls + 2                                     # closed: calls flow again
\`\`\`

Run the "never remembered" check the same way: fail, then heal, then ask again, and assert the second answer
is the dependency's. And run the breaker check with **two** clients against one Redis: the second client's
first request after the first one tripped it must skip the call, which is the observable difference between
a shared breaker and a per-process one.
`;

export const sources: Source[] = [
  {
    title: 'Circuit Breaker',
    url: 'https://martinfowler.com/bliki/CircuitBreaker.html',
    by: 'Martin Fowler',
    date: '2014-03-06',
    kind: 'post',
    venue: 'martinfowler.com',
    takes:
      'The closed, open and half-open states, a trial call after a reset timeout, and the warning that not every error should trip the breaker.',
  },
  {
    title: 'Circuit Breaker pattern',
    url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker',
    kind: 'docs',
    venue: 'Azure Architecture Center',
    takes:
      'Half-open as a limited number of trial requests, breaker state shared by many concurrent instances, and different thresholds for different kinds of failure.',
  },
  {
    title: 'Avoiding fallback in distributed systems',
    url: 'https://builder.aws.com/content/3EuS9Sakq7L3VLQIF3qzfMfke1Y/avoiding-fallback-in-distributed-systems',
    by: 'Jacob Gabrielson',
    date: '2019-12-05',
    kind: 'post',
    venue: "Amazon Builders' Library",
    takes:
      'Why rarely exercised fallbacks are latent bugs that can widen an outage, and why a fallback must be tested by injecting the failure or not exist.',
  },
  {
    title: 'Addressing Cascading Failures',
    url: 'https://sre.google/sre-book/addressing-cascading-failures/',
    by: 'Mike Ulrich',
    date: '2016-04',
    kind: 'docs',
    venue: 'Site Reliability Engineering (Google)',
    takes:
      'Serving degraded results instead of failing, how retries against an overloaded backend feed a cascade, and that the code path you never use is the one that does not work.',
  },
];
