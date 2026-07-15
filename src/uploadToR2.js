import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
 * Build a headObject function backed by an S3-compatible client and a bucket.
 * It fetches an object's metadata (its ETag) so the uploader can skip
 * re-uploading unchanged objects; a missing object resolves to `null` instead
 * of throwing. HEAD is a cheap read (Class B on R2), traded against the more
 * limited write budget (Class A).
 * @param {object} options - Options.
 * @param {S3Client} options.client - S3 client (createR2Client, or a fake in tests).
 * @param {string} options.bucket - Target bucket name.
 * @returns {Function} headObject({ key }) => Promise<{ etag: string } | null>.
 */
export function createR2HeadObject({ client, bucket }) {
  return async ({ key }) => {
    try {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { etag: response.ETag };
    } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  };
}

/**
 * Objects rebuilt on every crawl: always uploaded without a HEAD probe, since
 * their content changes each run (a `generated_at` timestamp, the integration
 * set) and the probe would never spare a write.
 * @param {string} key - Object key.
 * @returns {boolean} True if the object must be re-uploaded unconditionally.
 */
function isAlwaysUpload(key) {
  return key === 'index.json' || key === 'rejected.json';
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
 * Upload a directory to an object store through an injected putObject function.
 *
 * When a headObject probe is provided, immutable objects (everything but the
 * index/rejection documents) are only re-uploaded if their remote ETag differs
 * from the local bytes. Covers change almost never, so this turns the dominant,
 * per-integration write cost into a one-off: at steady state a crawl re-writes
 * just index.json and rejected.json instead of every cover, keeping the write
 * volume (Class A on R2) roughly constant regardless of the store size.
 *
 * Objects are only ever PUT, never deleted: the freshly written
 * index.json/rejected.json always reference the current covers, so leftover
 * covers of removed integrations are harmless (unreferenced) — pruning is left
 * out on purpose so the credentials never need delete rights (read + write
 * only, no delete).
 * @param {object} options - Options.
 * @param {string} options.dir - Local directory to publish (the build output).
 * @param {Function} options.putObject - Uploader ({ key, body, contentType, cacheControl }).
 * @param {Function} [options.headObject] - Optional probe ({ key }) => { etag } | null; enables skip-if-unchanged.
 * @param {object} [options.logger] - Logger, console-compatible.
 * @returns {Promise<{ uploaded: string[], skipped: string[] }>} Sorted keys, split by outcome.
 */
export async function uploadDirectory({ dir, putObject, headObject, logger = console }) {
  const keys = (await listFiles(dir)).sort();
  const uploaded = [];
  const skipped = [];
  for (const key of keys) {
    const body = await readFile(path.join(dir, ...key.split('/')));
    if (headObject && !isAlwaysUpload(key)) {
      const head = await headObject({ key });
      if (head && etagMatches(head.etag, body)) {
        skipped.push(key);
        continue;
      }
    }
    await putObject({
      key,
      body,
      contentType: contentTypeFor(key),
      cacheControl: cacheControlFor(key),
    });
    uploaded.push(key);
  }
  logger.log(`Uploaded ${uploaded.length} objects (${skipped.length} unchanged).`);
  return { uploaded, skipped };
}
