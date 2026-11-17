/**
 * The links between a course step and its timed mock scenario: the course page offers the
 * scenario ("rehearse it timed"), the mock links back to the step. The course side reads the
 * generated `mockSteps` index, not `src/data/mock.ts`, so it never bundles the scenarios.
 */
import {mockSteps} from '@/data/mockSteps';

/** The mock scenario built on `problemId`'s step `stepId`, or null when the step has none. */
export const mockScenarioFor = (problemId: string, stepId: string): {id: string; title: string} | null =>
  mockSteps[`${problemId}/${stepId}`] ?? null;

/** The scenario's own page: the mock opens it at the start dialog. */
export const scenarioHref = (id: string): string => `/mock-interview?scenario=${encodeURIComponent(id)}`;
