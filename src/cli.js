import { buildIndex } from './buildIndex.js';
import { DEFAULT_OUTPUT_DIR, DEFAULT_STORE_BASE_URL, REJECTION_LEVELS, STORE_TOPIC } from './constants.js';
import { downloadCover, fetchManifestFile, searchRepositoriesByTopic } from './github.js';
import { writeOutput } from './writeOutput.js';

const topic = process.env.STORE_TOPIC || STORE_TOPIC;
const storeBaseUrl = (process.env.STORE_BASE_URL || DEFAULT_STORE_BASE_URL).replace(/\/$/, '');
const outputDir = process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
const token = process.env.GITHUB_TOKEN;

const repositories = await searchRepositoriesByTopic({ topic, token });
console.log(`Found ${repositories.length} public repositories tagged "${topic}".`);

const { index, rejected, coverFiles } = await buildIndex({
  repositories,
  fetchManifestFile,
  downloadCover,
  storeBaseUrl,
  now: new Date().toISOString(),
});

await writeOutput({ outputDir, index, rejected, coverFiles });

const errorCount = rejected.filter((entry) => entry.level === REJECTION_LEVELS.ERROR).length;
const warningCount = rejected.length - errorCount;
console.log(
  `Indexed ${index.integrations.length} integrations (${warningCount} warnings), rejected ${errorCount}, in ${outputDir}/.`,
);
for (const entry of rejected) {
  console.log(`  [${entry.level}] ${entry.store_slug}: ${entry.reason}`);
}
