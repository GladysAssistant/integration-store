import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLACEHOLDER_COVER_FILE_NAME } from './constants.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const CANONICAL_SCHEMA_PATH = path.join(packageRoot, 'schemas', 'manifest.schema.json');
const PLACEHOLDER_COVER_PATH = path.join(packageRoot, 'assets', 'placeholder-cover.png');

/**
 * Serialize a JSON document for publication.
 * @param {*} value - JSON-serializable value.
 * @returns {string} Pretty-printed JSON with a trailing newline.
 */
function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write everything the store publishes: index.json, rejected.json, the
 * canonical manifest.schema.json, the re-hosted covers (and the placeholder)
 * and the re-hosted documentation files.
 * @param {object} options - Options.
 * @param {string} options.outputDir - Destination directory.
 * @param {object} options.index - index.json content.
 * @param {object[]} options.rejected - rejected.json content.
 * @param {{fileName: string, data: Buffer}[]} options.coverFiles - Re-hosted covers.
 * @param {{fileName: string, data: Buffer}[]} options.docsFiles - Re-hosted documentation files, fileName relative to docs/ (e.g. "john--demo/en.md").
 * @returns {Promise<void>} Resolves once everything is written.
 */
export async function writeOutput({ outputDir, index, rejected, coverFiles, docsFiles }) {
  const coversDir = path.join(outputDir, 'covers');
  await mkdir(coversDir, { recursive: true });

  await writeFile(path.join(outputDir, 'index.json'), toJson(index));
  await writeFile(path.join(outputDir, 'rejected.json'), toJson(rejected));
  await copyFile(CANONICAL_SCHEMA_PATH, path.join(outputDir, 'manifest.schema.json'));
  await copyFile(PLACEHOLDER_COVER_PATH, path.join(coversDir, PLACEHOLDER_COVER_FILE_NAME));

  for (const coverFile of coverFiles) {
    await writeFile(path.join(coversDir, coverFile.fileName), coverFile.data);
  }

  const docsDir = path.join(outputDir, 'docs');
  for (const docsFile of docsFiles) {
    const filePath = path.join(docsDir, ...docsFile.fileName.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, docsFile.data);
  }
}
