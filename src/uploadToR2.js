import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { INTEGRATIONS_DIR_NAME, UPLOAD_CONCURRENCY } from './constants.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';

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
  if (key.endsWith('.md')) {
    return 'text/markdown; charset=utf-8';
  }
  return 'application/octet-stream';
}

/**
 * Documents rebuilt on every crawl: the index, its lite projection and the
 * rejection list.
 */
const CRAWL_DOCUMENT_KEYS = new Set(['index.json', 'index-lite.json', 'rejected.json']);

/**
 * Cache-Control to publish a file with. The index and rejection documents are
 * rebuilt on every crawl, so they get a short TTL; so does a per-integration
 * entry file (integrations/), which must follow the index as closely as it
 * does: a longer TTL would let the CDN serve an outdated manifest while the
 * index already lists the new version. Documentation pages keep a stable URL
 * but their content follows the repository, so they get a medium TTL; covers
 * and the schema are effectively immutable and can be cached hard.
 * @param {string} key - Object key.
 * @returns {string} Cache-Control header value.
 */
function cacheControlFor(key) {
  if (CRAWL_DOCUMENT_KEYS.has(key) || key.startsWith(`${INTEGRATIONS_DIR_NAME}/`)) {
    return 'public, max-age=300';
  }
  if (key.startsWith('docs/')) {
    return 'public, max-age=3600';
  }
  return 'public, max-age=86400';
}

/**
 * Publication phases of the object keys: everything the crawl documents
 * reference (covers, docs, per-integration entries, schemas) first, the crawl
 * documents themselves (index.json, index-lite.json, rejected.json) only once
 * the first phase is fully written. A consumer that reads a freshly published
 * index thus never follows a `cover_url`, a `docs` URL or an `entry_url` to an
 * object not uploaded yet, and a run that fails midway leaves the previous
 * index in place, consistent with the bucket, rather than a new index pointing
 * at missing objects. Within each phase the keys stay sorted, so the reported
 * order is deterministic.
 * @param {string[]} keys - Object keys.
 * @returns {string[][]} The same keys, split into the phases in upload order.
 */
function uploadPhases(keys) {
  const referenced = keys.filter((key) => !CRAWL_DOCUMENT_KEYS.has(key)).sort();
  const crawlDocuments = keys.filter((key) => CRAWL_DOCUMENT_KEYS.has(key)).sort();
  return [referenced, crawlDocuments];
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
 * Build a listObjects function backed by an S3-compatible client and a bucket.
 * It lists the whole bucket (ListObjectsV2, 1000 keys per page) and returns
 * the ETag of every object, so the uploader can skip re-uploading unchanged
 * objects. A handful of listing pages replace one HEAD per published file:
 * thousands of sequential round trips, the bulk of the upload time. A listing
 * is a Class A operation on R2, but a few per crawl are negligible against
 * its free tier.
 * @param {object} options - Options.
 * @param {S3Client} options.client - S3 client (createR2Client, or a fake in tests).
 * @param {string} options.bucket - Target bucket name.
 * @returns {Function} listObjects() => Promise<Map<string, string>> (object key → quoted ETag).
 */
export function createR2ListObjects({ client, bucket }) {
  return async () => {
    const etags = new Map();
    let continuationToken;
    do {
      const response = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
      );
      for (const object of response.Contents ?? []) {
        etags.set(object.Key, object.ETag);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return etags;
  };
}

/**
 * Objects rebuilt on every crawl: always uploaded without an ETag comparison,
 * since their content changes each run (a `generated_at` timestamp, the
 * integration set) and the comparison would never spare a write.
 * @param {string} key - Object key.
 * @returns {boolean} True if the object must be re-uploaded unconditionally.
 */
function isAlwaysUpload(key) {
  return CRAWL_DOCUMENT_KEYS.has(key);
}

/**
 * Whether the object already stored under `etag` has the exact same bytes as
 * `body`. R2 sets the ETag of a single-part upload to the hex MD5 of the object,
 * so comparing that against the local MD5 is a reliable "unchanged" test. MD5 is
 * used here as R2's content fingerprint, not for security. A missing or
 * non-MD5 ETag simply fails the match and triggers a safe re-upload.
 * @param {string|undefined} etag - Remote ETag (quoted), or undefined.
 * @param {Buffer} body - Local file bytes.
 * @returns {boolean} True if the remote object is byte-identical.
 */
function etagMatches(etag, body) {
  if (!etag) {
    return false;
  }
  return etag.replace(/"/g, '') === createHash('md5').update(body).digest('hex');
}

/**
 * Upload a directory to an object store through an injected putObject function,
 * `concurrency` objects at a time (each PUT is a round trip to the bucket: one
 * after the other, they would add up to minutes).
 *
 * When a listObjects function is provided, every object but the
 * index/rejection documents is only re-uploaded if its remote ETag (as listed
 * before the upload) differs from the local bytes. Covers change almost
 * never, and a per-integration entry file only changes when its integration
 * does (a new manifest version, a GitHub metadata change), so this turns the
 * dominant, per-integration write cost into a one-off: at steady state a
 * crawl re-writes just the three crawl documents (index.json, index-lite.json
 * and rejected.json) plus the few entries that changed, instead of every cover
 * and every entry, keeping the write volume (Class A on R2) roughly constant
 * regardless of the store size.
 *
 * Objects are only ever PUT, never deleted: the freshly written
 * index.json/rejected.json always reference the current covers, so leftover
 * covers of removed integrations are harmless (unreferenced) — pruning is left
 * out on purpose so the credentials never need delete rights (read + write
 * only, no delete).
 * @param {object} options - Options.
 * @param {string} options.dir - Local directory to publish (the build output).
 * @param {Function} options.putObject - Uploader ({ key, body, contentType, cacheControl }).
 * @param {Function} [options.listObjects] - Optional bucket listing () => Map<key, etag>; enables skip-if-unchanged.
 * @param {number} [options.concurrency] - Number of objects uploaded at the same time.
 * @param {object} [options.logger] - Logger, console-compatible.
 * @returns {Promise<{ uploaded: string[], skipped: string[] }>} Keys in upload order (referenced objects first, crawl documents last), split by outcome.
 */
export async function uploadDirectory({
  dir,
  putObject,
  listObjects,
  concurrency = UPLOAD_CONCURRENCY,
  logger = console,
}) {
  const remoteEtags = listObjects ? await listObjects() : new Map();
  const uploaded = [];
  const skipped = [];
  for (const keys of uploadPhases(await listFiles(dir))) {
    const outcomes = await mapWithConcurrency(keys, concurrency, async (key) => {
      const body = await readFile(path.join(dir, ...key.split('/')));
      if (!isAlwaysUpload(key) && etagMatches(remoteEtags.get(key), body)) {
        return 'skipped';
      }
      await putObject({
        key,
        body,
        contentType: contentTypeFor(key),
        cacheControl: cacheControlFor(key),
      });
      return 'uploaded';
    });
    keys.forEach((key, i) => {
      if (outcomes[i] === 'uploaded') {
        uploaded.push(key);
      } else {
        skipped.push(key);
      }
    });
  }
  logger.log(`Uploaded ${uploaded.length} objects (${skipped.length} unchanged).`);
  return { uploaded, skipped };
}
