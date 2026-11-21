/**
 * The real-time budget of one check, shared by the TypeScript, Go and C++ runtimes and read by the
 * verdict (`src/lib/outcome.ts`). Dependency-free, so the UI can import it without a runtime.
 */

/** Real time one check may take; a check still running past it fails and the next one starts. */
export const CHECK_BUDGET_MS = 10_000;

/** What a check says when it ran past `CHECK_BUDGET_MS`, in every runtime. */
export const CHECK_TIMEOUT_MESSAGE = `the check did not finish within ${CHECK_BUDGET_MS / 1000} s`;
