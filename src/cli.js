import { buildIndex } from './buildIndex.js';
import { DEFAULT_OUTPUT_DIR, DEFAULT_STORE_BASE_URL, REJECTION_LEVELS, STORE_TOPIC } from './constants.js';
import { downloadCover, fetchManifestFile, searchRepositoriesByTopic } from './github.js';
import { createR2Client, createR2PutObject, uploadDirectory } from './uploadToR2.js';
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

// Publish the built directory to a Cloudflare R2 bucket (S3-compatible API)
// when configured. Without R2_BUCKET the run is a local build only (useful for
// tests and dry runs).
const bucket = process.env.R2_BUCKET;
if (bucket) {
  const client = createR2Client({
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    endpoint: process.env.R2_ENDPOINT,
  });
  const putObject = createR2PutObject({ client, bucket });
  await uploadDirectory({ dir: outputDir, putObject });
  console.log(`Published ${outputDir}/ to R2 bucket "${bucket}" (public URL: ${storeBaseUrl}).`);
} else {
  console.log('R2_BUCKET not set: skipping upload (local build only).');
}
