/**
 * The reference comparison: after an accepted run, the reference solution runs through the same
 * checks in the same world, and what each did — read off the runtime's resources per check
 * (`RunMetrics`) — is laid side by side. Deterministic, so a difference is a difference in the
 * code, not in the weather; informational, so nothing here touches a verdict or a score.
 */
import type {CheckResult} from './judge';
import type {RunMetrics} from './runtime/types';

export interface MetricRow {
  key: keyof RunMetrics;
  label: string;
  /** What the number counts, for the tooltip. */
  blurb: string;
  format: (value: number) => string;
}

const count = (value: number): string => String(value);
const seconds = (ms: number): string => (ms === 0 ? '0' : ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(1)} s`);

export const METRIC_ROWS: readonly MetricRow[] = [
  {
    key: 'redisTrips',
    label: 'Redis round trips',
    blurb: 'commands sent to Redis, a pipeline or transaction counting once',
    format: count,
  },
  {key: 'redisCommands', label: 'Redis commands', blurb: 'commands inside those round trips', format: count},
  {key: 'kafkaProduced', label: 'records produced', blurb: 'records your producers put on the broker', format: count},
  {
    key: 'kafkaDelivered',
    label: 'records consumed',
    blurb: 'records the broker delivered to your consumers',
    format: count,
  },
  {key: 'kafkaCommits', label: 'offset commits', blurb: 'offset commits, automatic or explicit', format: count},
  {key: 'grpcCalls', label: 'RPCs made', blurb: 'gRPC calls your code made to other services', format: count},
  {key: 'sqlStatements', label: 'SQL statements', blurb: 'statements your code sent to Postgres', format: count},
  {key: 'sleeps', label: 'waits', blurb: 'times your code slept or waited on virtual time', format: count},
  {key: 'sleptMs', label: 'time waited', blurb: 'virtual time those waits covered', format: seconds},
];

/** Per-check values of one metric, in check order (0 where the check reported none). */
export const metricByCheck = (results: readonly CheckResult[], key: keyof RunMetrics): number[] =>
  results.map(r => r.metrics?.[key] ?? 0);

export const total = (values: readonly number[]): number => values.reduce((n, v) => n + v, 0);

/** Rows worth showing: a metric either side touched at all. */
export function comparedRows(yours: readonly CheckResult[], reference: readonly CheckResult[]): MetricRow[] {
  return METRIC_ROWS.filter(
    row => total(metricByCheck(yours, row.key)) > 0 || total(metricByCheck(reference, row.key)) > 0,
  );
}
