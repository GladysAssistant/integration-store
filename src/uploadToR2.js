import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Content-Type to publish a file with, derived from its extension. Serving the
 * right type matters: browsers and Gladys expect application/json for the
 * index and image/* for the covers.
 * @param {string} key - Object key (e.g. "covers/john--demo.jpg").
 * @returns {string} MIME type.
 */
function contentTypeFor(key) {
  if (key.endsWith('.json')) {
    return 'application/json';
  }
  if (key.endsWith('.png')) {
    return 'image/png';
  }
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  return 'application/octet-stream';
}

/**
 * Cache-Control to publish a file with. The index and rejection documents are
 * rebuilt on every crawl, so they get a short TTL; covers and the schema are
 * effectively immutable and can be cached hard.
 * @param {string} key - Object key.
 * @returns {string} Cache-Control header value.
 */
function cacheControlFor(key) {
  if (key === 'index.json' || key === 'rejected.json') {
    return 'public, max-age=300';
  }
  return 'public, max-age=86400';
}

/**
 * List every file under a directory, recursively, returning object keys
 * relative to the root and always using forward slashes (S3/R2 keys).
 * @param {string} dir - Directory to walk.
 * @param {string} [prefix] - Key prefix accumulated during recursion.
 * @returns {Promise<string[]>} Object keys.
 */
async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(dir, entry.name), key)));
    } else {
      files.push(key);
    }
  }
  return files;
}

/**
 * Build an S3 client pointed at a Cloudflare R2 bucket. R2 exposes an
 * S3-compatible API at `https://<account_id>.r2.cloudflarestorage.com` with a
 * fixed `auto` region.
 * @param {object} options - Options.
 * @param {string} [options.accountId] - Cloudflare account id (used to build the endpoint).
 * @param {string} options.accessKeyId - R2 access key id.
 * @param {string} options.secretAccessKey - R2 secret access key.
 * @param {string} [options.endpoint] - Explicit endpoint override (takes precedence over accountId).
 * @returns {S3Client} Configured client.
 */
export function createR2Client({ accountId, accessKeyId, secretAccessKey, endpoint }) {
  return new S3Client({
    region: 'auto',
    endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/**
 * Build a putObject function backed by an S3-compatible client and a bucket.
 * @param {object} options - Options.
 * @param {S3Client} options.client - S3 client (createR2Client, or a fake in tests).
 * @param {string} options.bucket - Target bucket name.
 * @returns {Function} putObject({ key, body, contentType, cacheControl }) => Promise<void>.
 */
export function createR2PutObject({ client, bucket }) {
  return async ({ key, body, contentType, cacheControl }) => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  };
}

/**
 * Upload every file of a directory to an object store through an injected
 * putObject function. Objects are only PUT, never deleted: the freshly written
 * index.json/rejected.json always reference the current covers, so leftover
 * covers of removed integrations are harmless (unreferenced) — pruning is left
 * out on purpose to keep the required credentials write-only.
 * @param {object} options - Options.
 * @param {string} options.dir - Local directory to publish (the build output).
 * @param {Function} options.putObject - Uploader ({ key, body, contentType, cacheControl }).
 * @param {object} [options.logger] - Logger, console-compatible.
 * @returns {Promise<string[]>} The uploaded object keys, sorted.
 */
export async function uploadDirectory({ dir, putObject, logger = console }) {
  const keys = (await listFiles(dir)).sort();
  for (const key of keys) {
    const body = await readFile(path.join(dir, ...key.split('/')));
    await putObject({
      key,
      body,
      contentType: contentTypeFor(key),
      cacheControl: cacheControlFor(key),
    });
  }
  logger.log(`Uploaded ${keys.length} objects.`);
  return keys;
}
