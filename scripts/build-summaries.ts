/**
 * Writes src/data/problems/summaries.ts and src/data/problems/modules.ts from the courses (see
 * scripts/summaries.ts). Run `yarn build:summaries` after adding a course or changing what its
 * summary holds: its id, title, tagline, difficulty, concepts, minutes, track, tag, language,
 * company, or a step's id, title or concept. `yarn verify` fails while they are stale.
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
