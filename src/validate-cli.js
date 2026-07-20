#!/usr/bin/env node
// Local pre-publish check, so a developer never has to wait for the hourly
// indexing to discover a rejection. Runs the exact same admission checks as
// the indexer against a local checkout of an integration repository:
//
//   npx github:GladysAssistant/integration-store [path-to-integration]
//
// Exit code 0: the integration would be indexed (possibly with warnings).
// Exit code 1: the integration would be rejected.

import { resolve } from 'node:path';

import { checkDockerImage } from './checkDockerImage.js';
import { MANIFEST_FILE_NAME, REJECTION_LEVELS, STORE_TOPIC } from './constants.js';
import { downloadCover } from './github.js';
import { validateLocalIntegration } from './validateLocal.js';

const manifestPath = resolve(process.argv[2] ?? '.', MANIFEST_FILE_NAME);
console.log(`Validating ${manifestPath} against the store admission rules...\n`);

const { problems } = await validateLocalIntegration({ manifestPath, checkDockerImage, downloadCover });
for (const problem of problems) {
  console.log(`  [${problem.level}] ${problem.reason}`);
}

const errorCount = problems.filter((problem) => problem.level === REJECTION_LEVELS.ERROR).length;
const warningCount = problems.length - errorCount;

if (errorCount > 0) {
  console.log(
    `\n✖ ${errorCount} error(s), ${warningCount} warning(s): this integration would be REJECTED by the store.`,
  );
  process.exit(1);
}
if (warningCount > 0) {
  console.log(
    `\n✔ Valid with ${warningCount} warning(s): the integration would be indexed, with the degradations above.`,
  );
} else {
  console.log('✔ Valid: this integration passes all local admission checks.');
}
console.log(
  '\nRemember what can only be checked once published: the repository must be public,' +
    ` tagged with the "${STORE_TOPIC}" topic, and the manifest pushed at the root of the default branch.`,
);
