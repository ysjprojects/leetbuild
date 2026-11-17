/**
 * Writes src/data/problems/summaries.ts and src/data/problems/modules.ts from the courses, and
 * src/data/mockSteps.ts from the mock scenarios (see scripts/summaries.ts). Run
 * `yarn build:summaries` after adding a course or changing what its summary holds: its id, title,
 * tagline, difficulty, concepts, minutes, track, tag, language, company, or a step's id, title or
 * concept; or after adding a mock scenario or changing its id, title, course or step. `yarn verify`
 * fails while they are stale.
 */
import {writeFileSync} from 'node:fs';

import {renderSummaries} from './summaries';

async function main(): Promise<void> {
  for (const [file, source] of Object.entries(await renderSummaries())) {
    writeFileSync(file, source);
    console.log(`✓ ${file}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
