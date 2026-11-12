import type {Source} from '@/lib/types';

/**
 * The failure-mode guide for deadlines and retries: what a call to a dependency may cost, which
 * failures earn another attempt, and what a timeout does and does not tell the caller.
 */
export const guide = `# The failure mode

A service calls a dependency over gRPC: a model server, a payment processor, a mail relay, a shard
writer. The starter works against a healthy dependency, and every flaw in this family hides in the
lines that run only when the dependency is not healthy. They come in four shapes:

- **No deadline.** The call waits as long as the dependency takes. gRPC sets no deadline by default,
  so a server that accepted the connection and then stopped answering holds the caller's thread, its
  connection and its lock for ever.
- **The wrong failures retried.** A loop that retries "on any error" asks again after
  \`INVALID_ARGUMENT\` and \`PERMISSION_DENIED\`, which will fail the same way every time, and after a
  content refusal, which is an answer, not a failure.
- **Retries without a shape.** No bound on the attempts, no wait between them, or the same fixed wait
  on every client, so a dependency that is briefly down meets every caller again at the same instant.
- **A timeout treated as a failure.** The caller gave up waiting; it does not know whether the effect
  happened. Resending with a fresh id, or marking the work failed, turns one refund into two, or a
  sent email into a "failed" one that is sent again.

The minimal instance is six lines that look careful:

\`\`\`python
def refund(refund_id: str, amount: int) -> str:
    for _ in range(5):
        try:
            return psp.Refund(RefundRequest(amount=amount), metadata=(("idempotency-key", str(uuid4())),)).psp_ref
        except grpc.RpcError:
            time.sleep(0.2)
    raise RefundFailed(refund_id)
\`\`\`

It retries, it is bounded, it even sends an idempotency key. It also has no deadline (a hung PSP holds
the worker), retries a refusal five times, waits the same 200 ms on every client, mints a new key per
attempt (so the PSP cannot tell a retry from a second refund), and raises \`RefundFailed\` after a
timeout whose refund may well have gone through.

# How it shows up in the courses

Nearly every debugging course has a step where the service calls something over gRPC, and the checks
there drive the dependency into the states a demo never reaches. A few to start with:

- [Realtime Bidding, step 3](/realtime-bidding/3-dependency): an auction has 100 ms in all, and the
  starter spends it on calls that do not know that, retrying one of them inside the budget.
- [Distillation Pipeline, step 3](/distillation-pipeline/3-dependency): a loop that keeps calling the
  teacher until something usable comes back, which is exactly how a hung or refusing teacher takes a
  whole shard down.
- [Job Queue, step 3](/job-queue/3-dependency): the worker's call has to finish before its claim on
  the job expires, a permanent failure is still retried, and the retry is scheduled for right now.
- [Log Indexer, step 3](/log-indexer/3-dependency): a sleep-and-retry loop around a bulk write that
  retries a mapping conflict and gives every attempt a fresh batch id.
- [Voice Agent, step 3](/voice-agent/3-dependency): a streaming \`Synthesize\` that, on a dropped
  stream, starts the answer again from the first word while the caller is listening.
- [Refund Service, step 3](/refund-service/3-dependency): a PSP call with no deadline and a fresh
  key, which marks a lost answer as a rejected refund.
- [Email Delivery, step 3](/email-delivery/3-dependency): a relay call whose timeout is resent, so
  the customer gets the email twice, and whose dead address is asked three times.

The symptom is always the same shape: the service is fine in the demo and wrong (slow, duplicated or
dishonest) only while the dependency is hung, flapping or refusing. The practice list at the end of
this page has every step that drills it.

# The mechanism: what a deadline and a status code tell you

## A deadline belongs to the call

A deadline is a point in time past which the caller will not wait. Set on the call (not as a timer
around it), it travels to the server in the \`grpc-timeout\` header, so the server can stop work
nobody is waiting for; the client gives up with \`DEADLINE_EXCEEDED\` the moment it passes. The four
course languages set it like this:

\`\`\`python
# grpcio: a timeout in seconds per call; the status is on the RpcError
try:
    reply = stub.Embed(req, timeout=2.0)
except grpc.RpcError as e:
    if e.code() == grpc.StatusCode.UNAVAILABLE: ...
\`\`\`

\`\`\`ts
// @grpc/grpc-js: an absolute deadline in the call options; err.code is a status number
import {status} from '@grpc/grpc-js';
client.embed(req, new Metadata(), {deadline: Date.now() + 2000}, (err, reply) => {
  if (err?.code === status.UNAVAILABLE) { /* ... */ }
});
\`\`\`

\`\`\`go
// grpc-go: the deadline lives in the context; status.Code reads the code from any error
ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
defer cancel()
reply, err := client.Embed(ctx, req)
if status.Code(err) == codes.Unavailable { /* ... */ }
\`\`\`

\`\`\`cpp
// grpc++: one ClientContext per attempt (a context cannot be reused), deadline set on it
grpc::ClientContext ctx;
ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(2));
grpc::Status s = stub->Embed(&ctx, req, &reply);
if (s.error_code() == grpc::StatusCode::UNAVAILABLE) { /* ... */ }
\`\`\`

## Per attempt, and inside one overall budget

There are two clocks. **The attempt deadline** bounds one call: "the model server gets 800 ms".
**The overall budget** bounds the whole operation, retries and waits included: "this auction has
100 ms", "this HTTP request times out in 2 s". A retry loop that resets a fresh 800 ms deadline on
each of three attempts spends 2.4 s plus its backoff; if the caller upstream gave up at 1 s, the last
two attempts are work for nobody.

So each attempt's deadline is the smaller of its own cap and what is left of the budget, and a retry
that cannot fit in what is left is not started. When the service is itself serving a gRPC call, the
budget is the caller's deadline: **deadline propagation**. grpc-go carries it in the request's
\`ctx\` automatically; in grpcio the server reads \`context.time_remaining()\`; in grpc-js
\`call.getDeadline()\`; in grpc++ \`grpc::ClientContext::FromServerContext(server_ctx)\` copies it to
the outgoing call. gRPC turns the deadline into a remaining timeout on the wire, so clock skew between
hosts does not stretch it.

:::widget deadline-retry {"base": 100, "deadline": 2000, "attempts": 4}

## Which statuses earn another attempt

A status code says whether the next attempt can go differently:

| Status | What happened | Retry? |
| --- | --- | --- |
| \`UNAVAILABLE\` | the server is restarting, the connection dropped, the load balancer had no backend | yes, with backoff: transient by definition |
| \`DEADLINE_EXCEEDED\` | the attempt ran out of time; the effect may or may not have happened | only if the operation is idempotent and the budget has room; for an effect, reconcile first |
| \`RESOURCE_EXHAUSTED\` | a quota or a full pool | not straight away: back off much longer, or treat as terminal when the pool is the answer |
| \`INVALID_ARGUMENT\`, \`FAILED_PRECONDITION\`, \`OUT_OF_RANGE\` | the request is wrong, or the system is in the wrong state | never: the same request fails the same way |
| \`PERMISSION_DENIED\`, \`UNAUTHENTICATED\` | this caller may not do this | never: retrying a refused token is how accounts get locked |
| \`NOT_FOUND\`, \`ALREADY_EXISTS\` | an answer about the data | never: it is an outcome to record |
| a content refusal (\`OK\` with a refusal, or the service's own code) | the model or provider declined | never: it is an answer, and asking again is asking for a different one |

Courses name their retryable set in the check titles ("Retries only UNAVAILABLE and
DEADLINE_EXCEEDED", "Only UNAVAILABLE is retried"), and they differ on purpose: a call whose effect
cannot be checked afterwards does not retry \`DEADLINE_EXCEEDED\` at all.

:::quiz
Q: A judge model answers \`INVALID_ARGUMENT\` for a record whose prompt is over its context window. The client retries it twice with backoff. What does that cost?
- [ ] Nothing: the third attempt may land on a server with a bigger window
- [x] Three calls and two waits for an answer that was already final; the record should be reported as invalid after one call
- [ ] It is correct, because a retry policy should be uniform across statuses
> \`INVALID_ARGUMENT\` describes the request, not the server's health. Every attempt fails the same way, so the retries only add latency and load. The terminal statuses are recorded as outcomes after exactly one call.
:::

## Bounded, backed off, jittered

Retries are borrowed capacity: each one asks the dependency for more work at the moment it is least
able to do it. Three rules keep them from becoming the outage:

- **A bound.** A fixed number of attempts (two or three is typical), never \`while True\`, and never
  past the overall budget.
- **Exponential backoff.** Wait \`base * 2^n\` before attempt \`n + 1\` (100 ms, 200 ms, 400 ms),
  capped, so a dependency that needs a few seconds to come back is not hit every 50 ms meanwhile.
- **Jitter.** Pick the wait at random between zero and that bound ("full jitter"). Without it, a
  thousand clients that failed together retry together, in synchronised waves.

Retries also **multiply across layers**. If five services in a call chain each try three times, one
failing database sees up to \`3^5 = 243\` attempts per user request. Retry in one layer (usually the
one closest to the failing dependency), and let the others fail fast. A process-wide retry budget (a
token bucket of retries, or a cap on the retry ratio) and a circuit breaker stop the herd when the
dependency is down for longer than a blip.

:::details Why "the same fixed sleep" is not backoff
\`time.sleep(0.2)\` between attempts is a pause, not backoff: it neither grows nor varies. Under a
real outage every client sleeps the same 200 ms and comes back in step, which is a retry storm with
a metronome. Growth spreads the attempts out over time; randomness spreads the clients out from one
another. A step that asks for "1 s, 2 s, 4 s" waits is asking for the growth; jitter is added on top
in production, and in the course harness the virtual clock records the waits so the check can read
them.
:::

## One id on every attempt

A retry is the same request sent again, so it carries the same identity: the idempotency key, the
batch id, the message id, the effect id. The receiver dedupes by it, which is what makes a retry of a
write safe at all. Minting the id inside the loop (\`uuid4()\` per attempt, \`{message_id}-{attempt}\`)
defeats that: each attempt looks like a new request, and an attempt that landed before its answer was
lost is applied again. Derive the id once, from the thing being done (the refund, the batch, the
message, the \`(account, window)\` close), before the first attempt.

:::quiz
Q: A bulk write's first attempt reaches the shard, which indexes the batch, and then the reply is lost to \`UNAVAILABLE\`. The retry sends a new batch id. What does the index hold?
- [ ] The batch once: the shard compares the records
- [x] The batch twice: the shard has no way to tell the retry from a second batch
- [ ] Nothing: the retry cancels the first write
> Deduplication works only on an identity the sender keeps. A fresh id per attempt makes every retry a new write. The batch id is minted once, before the loop, and sent on every attempt.
:::

## A stream resumes where it stopped

A streaming call can fail halfway. Restarting it from the beginning replays what the consumer already
has: the caller hears the first sentence again, a transcript repeats a minute of audio, a reader
reprocesses rows. Track the offset of the last item actually delivered (played, written, confirmed,
not merely received), and open the retry from there: the request carries the offset, and the server
starts after it. The attempt bound and the deadline still apply per attempt, and a stream the caller
cancelled (a barge-in, a closed tab) is not resumed at all.

## A timeout is an unknown outcome

\`DEADLINE_EXCEEDED\` on a call with an effect says only that the caller stopped waiting. The gRPC
status documentation is explicit: for an operation that changes state, the status "may be returned
even if the operation has completed successfully". The effect may be done, half done or never
started:

:::sequence
{
  "participants": ["refunds", "PSP"],
  "messages": [
    {"from": "refunds", "to": "PSP", "label": "Refund(r-42) · idempotency-key r-42 · deadline 5 s", "kind": "sync"},
    {"from": "PSP", "to": "PSP", "label": "money moves", "kind": "sync"},
    {"from": "PSP", "to": "refunds", "label": "reply lost · DEADLINE_EXCEEDED at 5 s", "kind": "reply"},
    {"from": "refunds", "to": "PSP", "label": "GetRefund(r-42) · deadline 5 s", "kind": "sync"},
    {"from": "PSP", "to": "refunds", "label": "SUCCEEDED, psp_ref p-9", "kind": "reply"},
    {"from": "refunds", "to": "refunds", "label": "mark r-42 CONFIRMED; no second Refund", "kind": "sync"}
  ]
}
:::

The honest moves, in order of preference:

1. **Reconcile.** Ask the dependency about the effect by its id (\`GetStatus\`, \`GetInvoice\`, a
   lookup on the page the click should have changed) and record what it says.
2. **Resend with the same id**, only when the receiver dedupes by it, so a duplicate is answered
   from its record instead of applied again.
3. **Record it as unknown** (pending, parked, unsigned, kept on hold) and let a reconciler or a
   person settle it later. Never "failed", which invites a fresh retry, and never "done".

:::quiz
Q: An email relay call times out after 10 s. Which handling is right?
- [ ] Mark the message failed; the next worker will resend it
- [ ] Resend straight away with a new message id, so the relay cannot reject it as a duplicate
- [x] Ask the relay for the message's status by its id, and resend (with the same id) only if the relay has no record of it
> The relay may have accepted the message just before the reply was lost. Resending with a new id, or marking it failed so something else resends it, delivers it twice. The status lookup turns the unknown back into a known outcome first.
:::

# The fix and its trade-offs

Put together, a well-shaped call to a dependency looks like this in grpc-go (the other languages
differ only in how the deadline and code are spelled):

\`\`\`go
func (c *Client) Archive(ctx context.Context, docID string, version int64) (Reply, error) {
	id := fmt.Sprintf("archive:%s:%d", docID, version) // one id, before the first attempt
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			wait := time.Duration(rand.Int63n(int64(base << attempt))) // full jitter
			if dl, ok := ctx.Deadline(); ok && time.Until(dl) < wait+minAttempt {
				break // the budget cannot fit another attempt
			}
			c.clock.Sleep(wait)
		}
		actx, cancel := context.WithTimeout(ctx, perAttempt) // the smaller of the two wins
		reply, err := c.archiver.Archive(actx, &ArchiveRequest{RequestId: id})
		cancel()
		switch status.Code(err) {
		case codes.OK:
			return reply, nil
		case codes.Unavailable:
			continue // nothing happened; safe to try again
		case codes.DeadlineExceeded:
			return c.reconcile(ctx, id) // unknown outcome: ask before anything else
		default:
			return Reply{}, err // terminal: one call, the status passed up
		}
	}
	return Reply{}, ErrPending // leave the work open, not failed
}
\`\`\`

The choices each have a cost:

- **Short deadlines** free threads quickly but time out a slow-but-healthy call, which then costs a
  retry or a reconcile. Start from the dependency's tail latency (p99 or p99.9), not its median, and
  shorten only where the caller's own budget demands it.
- **More attempts** raise apparent availability during blips and multiply load during outages. Two or
  three, inside the budget, behind a breaker, is the usual answer.
- **Retrying \`DEADLINE_EXCEEDED\`** is cheap for a read and dangerous for an effect. Some courses
  retry it with the same id because the receiver dedupes; others never retry it and park the work
  instead. The check titles say which.
- **Reconciling** costs an extra call and an API to ask (a status endpoint keyed by your id). Without
  one, the only honest outcome of a timeout is "unknown", recorded and settled later.
- **Resuming a stream** needs a server that accepts an offset, and a client that tracks what was
  delivered rather than what was received.
- **Retrying in one layer** means the other layers fail fast and say so; the user sees an error a
  little sooner instead of an outage a lot later.

:::details Hedged requests, the cousin of a retry
A hedge sends a second copy of a slow read to another replica before the first has failed, and
cancels whichever loses. It cuts tail latency for idempotent reads at the cost of extra load, and it
needs cancellation to propagate so the losing copy stops working. It is never used for effects: two
copies of a write in flight at once is the duplicate this page is about.
:::

# Proving the fix

A retry policy cannot be proved by calling a healthy dependency; that path never runs the policy.
The course harnesses stand the dependency in for real and make it misbehave on cue, and the proofs
are about outcomes, read from what the fake recorded:

- **A hung dependency.** The fake accepts the call and never answers. The proof: the call returns
  \`DEADLINE_EXCEEDED\` (or the course's fallback) at the deadline, the fake saw a deadline on the
  request, and the total time across attempts stays inside the overall budget.
- **An injected \`UNAVAILABLE\`.** The fake fails the first one or two attempts, then answers. The
  proof: the call succeeds; the fake saw exactly the expected number of attempts, every one carrying
  the same id; and a fake that never recovers sees the bound and not one call more.
- **A terminal status.** The fake answers \`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\` or a refusal.
  The proof: exactly one call, and the outcome recorded as that answer (invalid, refused,
  quarantined), not as a transient failure.
- **A lost reply.** The fake applies the effect, then lets the deadline pass. The proof: a status
  lookup by the same id follows, no second effect is applied, and the record reads confirmed or
  pending, never failed.
- **A dropped stream.** The fake fails the stream after chunk three. The proof: the retry asks for
  the offset after three, and the consumer received every chunk exactly once.
- **The virtual clock.** Sleeps go through an injected clock, so the harness reads the waits
  (growing, inside the budget) instead of waiting them out, and a seeded random source makes the
  jitter repeatable.

:::details Why the proofs avoid real sleeps and real timers
A test that sleeps through a real backoff is slow, and one that measures wall time is flaky on a busy
machine. With a virtual clock, "the second wait is longer than the first" and "no attempt starts past
the budget" are exact comparisons over recorded numbers. The deadline itself is still real on the
wire: the fake reads it from the call, which is what proves it was set on the call and not around it.
:::

:::quiz
Q: Which test proves that a client retries \`UNAVAILABLE\` correctly?
- [ ] Call a healthy fake once and assert the reply
- [ ] Assert the source contains \`codes.Unavailable\`
- [x] Make the fake fail twice with \`UNAVAILABLE\` then answer, and assert the reply, three attempts, the same id on each, and growing recorded waits
> A healthy fake never exercises the retry path, and reading the source proves nothing about behaviour. Only a dependency made to fail on cue shows the attempts, the id they carry and the waits between them.
:::
`;

export const sources: Source[] = [
  {
    kind: 'docs',
    title: 'Deadlines',
    url: 'https://grpc.io/docs/guides/deadlines/',
    venue: 'gRPC documentation',
    takes:
      "gRPC sets no deadline by default; a deadline on the call reaches the server, which cancels the work once it passes; and deadline propagation turns the caller's deadline into a remaining timeout for the next hop.",
  },
  {
    kind: 'docs',
    title: 'Status Codes',
    url: 'https://grpc.io/docs/guides/status-codes/',
    venue: 'gRPC documentation',
    takes:
      'What each status means for a retry: UNAVAILABLE is transient and retried with backoff, INVALID_ARGUMENT and PERMISSION_DENIED describe the request, and DEADLINE_EXCEEDED may come back for an operation that completed.',
  },
  {
    kind: 'post',
    title: 'Timeouts, retries, and backoff with jitter',
    url: 'https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter',
    venue: "Amazon Builders' Library",
    by: 'Marc Brooker',
    date: '2019-12-05',
    takes:
      "Timeouts chosen from the dependency's tail latency, retries as selfish load, the 243x amplification of three retries in five layers, and idempotency as the condition for retrying a call with side effects.",
  },
  {
    kind: 'post',
    title: 'Exponential Backoff and Jitter',
    url: 'https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/',
    venue: 'AWS Architecture Blog',
    by: 'Marc Brooker',
    date: '2015-03-04',
    takes: 'Full jitter: a random wait up to the exponential bound, which spreads synchronised clients apart.',
  },
  {
    kind: 'docs',
    title: 'Addressing Cascading Failures',
    url: 'https://sre.google/sre-book/addressing-cascading-failures/',
    venue: "Site Reliability Engineering (O'Reilly)",
    by: 'Mike Ulrich',
    date: '2016-04',
    takes:
      'Limit retries per request, retry at one layer, keep a process-wide retry budget, and propagate one absolute deadline (and its cancellation) through the whole tree of calls.',
  },
];
