#!/usr/bin/env node
// Local pre-publish check, so a developer never has to wait for the hourly
// indexing to discover a rejection. Runs the exact same admission checks as
// the indexer against a local checkout of an integration repository:
//
//   npx github:GladysAssistant/integration-store [--skip-image-check] [path-to-integration]
//
// --skip-image-check: do not check the Docker images on their registry (for
// the CI of a pull request, where the bumped image tag is not pushed yet);
// every other check still runs.
//
// Exit code 0: the integration would be indexed (possibly with warnings).
// Exit code 1: the integration would be rejected.
// Exit code 2: invalid command-line arguments.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { checkDockerImage } from './checkDockerImage.js';
import { MANIFEST_FILE_NAME, REJECTION_LEVELS, STORE_TOPIC } from './constants.js';
import { downloadCover } from './github.js';
import { validateLocalIntegration } from './validateLocal.js';

const SKIP_IMAGE_CHECK_FLAG = 'skip-image-check';

let args;
try {
  args = parseArgs({
    options: { [SKIP_IMAGE_CHECK_FLAG]: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
} catch (e) {
  console.error(e.message);
  console.error(
    `Usage: npx github:GladysAssistant/integration-store [--${SKIP_IMAGE_CHECK_FLAG}] [path-to-integration]`,
  );
  process.exit(2);
}
const skipImageCheck = args.values[SKIP_IMAGE_CHECK_FLAG];

const manifestPath = resolve(args.positionals[0] ?? '.', MANIFEST_FILE_NAME);
console.log(`Validating ${manifestPath} against the store admission rules...\n`);

const { problems } = await validateLocalIntegration({ manifestPath, checkDockerImage, downloadCover, skipImageCheck });
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
if (skipImageCheck) {
  console.log(
    `The Docker images were not checked (--${SKIP_IMAGE_CHECK_FLAG}): publish them before the manifest` +
      ' that references them reaches the default branch, then run again without the flag — the indexer' +
      ' rejects an integration whose image is missing.',
  );
}
