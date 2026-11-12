import type {GuideId} from '@/lib/types';

/**
 * Each failure-mode guide's title and one-line summary: what the course pane links by, the index
 * lists and the guide's page opens with. The guides themselves are the modules beside this one.
 */
export const GUIDES: Record<GuideId, {title: string; tagline: string}> = {
  'request-boundaries': {
    title: 'Request boundaries',
    tagline:
      'Who is asking, what they may touch and what they may send: the tenant from the credential, a foreign record answered like a missing one, and every limit checked before anything is stored, fetched or called.',
  },
  'idempotent-requests': {
    title: 'Idempotent requests',
    tagline:
      'A client that retries gets its first answer again, not a second effect: keys scoped to the tenant, the response recorded with the effect, and a reused key with a different body refused.',
  },
  'atomic-state': {
    title: 'One decision, one atomic step',
    tagline:
      'A read, a comparison and a write sent as separate commands let two requests both pass. One Lua script, SET NX or a compare-and-set makes them one step no other client can split.',
  },
  'keys-and-expiry': {
    title: 'Keys and lifetimes',
    tagline:
      'A key names everything its value depends on, and its expiry is decided in the write that creates it: windows that end on time, nothing that grows forever, and the few things that must never expire.',
  },
  leases: {
    title: 'Leases, claims and fencing',
    tagline:
      'Work owned for a while: a claim that carries a deadline, a renewal only the holder can make, an expired claim handed back once, and a completion from a replaced worker refused.',
  },
  'deadlines-and-retries': {
    title: 'Deadlines and retries',
    tagline:
      'Every attempt carries a deadline; only a failure that can succeed next time is retried, a bounded number of times, spaced out, with the same id; and a timeout is an unknown outcome, not a failure.',
  },
  'failing-dependencies': {
    title: 'When a dependency fails',
    tagline:
      'What to answer when the call cannot succeed: a breaker that stops calling, a fallback that says it is one, a degraded answer instead of a wrong one, and a failure never remembered as a result.',
  },
  'producing-events': {
    title: 'Producing events',
    tagline:
      'The key decides order, acks=all with an idempotent producer decides durability, the delivery report decides success and the outbox keeps what the broker refused; the event carries ids, not content.',
  },
  'consuming-events': {
    title: 'Consuming events',
    tagline:
      'Every record can arrive twice: apply its effect, then commit its offset, and make the effect safe to apply again.',
  },
  'honest-reads': {
    title: 'Reads that tell the truth',
    tagline:
      "The caller's own data, counters read live, caches keyed by everything that varies, no verdict below a minimum sample, pages by cursor, and a partial result marked partial.",
  },
  'model-output': {
    title: 'Model output is untrusted',
    tagline:
      'Retrieved text is data, not instructions; quotes are checked against their source; refusals and sampled or truncated answers are not cached; and a model decides alone only above a threshold.',
  },
};
