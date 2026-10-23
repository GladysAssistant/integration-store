import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { expect } from 'chai';

import { createR2Client, createR2ListObjects, createR2PutObject, uploadDirectory } from '../src/uploadToR2.js';

const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

describe('createR2Client', () => {
  it('should build an S3 client from an account id', () => {
    const client = createR2Client({
      accountId: 'abc123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(client).to.be.instanceOf(S3Client);
  });

  it('should honor an explicit endpoint override', () => {
    const client = createR2Client({
      endpoint: 'https://custom.example.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(client).to.be.instanceOf(S3Client);
  });
});

describe('createR2PutObject', () => {
  it('should send a PutObjectCommand with the given parameters', async () => {
    const sent = [];
    const fakeClient = {
      send: async (command) => {
        sent.push(command);
      },
    };
    const putObject = createR2PutObject({ client: fakeClient, bucket: 'my-bucket' });

    const body = Buffer.from('{"index_format":1}');
    await putObject({ key: 'index.json', body, contentType: 'application/json', cacheControl: 'public, max-age=300' });

    expect(sent).to.have.lengthOf(1);
    expect(sent[0]).to.be.instanceOf(PutObjectCommand);
    expect(sent[0].input).to.deep.equal({
      Bucket: 'my-bucket',
      Key: 'index.json',
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'public, max-age=300',
    });
  });
});

describe('createR2ListObjects', () => {
  it('should list every page of the bucket into a key → ETag map', async () => {
    const sent = [];
    const pages = [
      {
        IsTruncated: true,
        NextContinuationToken: 'page-2',
        Contents: [
          { Key: 'covers/john--demo.jpg', ETag: '"aaa"' },
          { Key: 'index.json', ETag: '"bbb"' },
        ],
      },
      { IsTruncated: false, Contents: [{ Key: 'integrations/john--demo.json', ETag: '"ccc"' }] },
    ];
    const fakeClient = {
      send: async (command) => {
        sent.push(command);
        return pages[sent.length - 1];
      },
    };
    const listObjects = createR2ListObjects({ client: fakeClient, bucket: 'my-bucket' });

    const etags = await listObjects();

    expect(sent).to.have.lengthOf(2);
    expect(sent[0]).to.be.instanceOf(ListObjectsV2Command);
    expect(sent[0].input).to.deep.equal({ Bucket: 'my-bucket', ContinuationToken: undefined });
    expect(sent[1].input).to.deep.equal({ Bucket: 'my-bucket', ContinuationToken: 'page-2' });
    expect([...etags]).to.deep.equal([
      ['covers/john--demo.jpg', '"aaa"'],
      ['index.json', '"bbb"'],
      ['integrations/john--demo.json', '"ccc"'],
    ]);
  });

  it('should return an empty map for an empty bucket (no Contents)', async () => {
    const fakeClient = { send: async () => ({ IsTruncated: false }) };
    const listObjects = createR2ListObjects({ client: fakeClient, bucket: 'my-bucket' });

    expect((await listObjects()).size).to.equal(0);
  });

  it('should propagate a listing error', async () => {
    const fakeClient = {
      send: async () => {
        throw new Error('AccessDenied');
      },
    };
    const listObjects = createR2ListObjects({ client: fakeClient, bucket: 'my-bucket' });

    let caught;
    try {
      await listObjects();
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.an('error');
    expect(caught.message).to.equal('AccessDenied');
  });
});

describe('uploadDirectory', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'integration-store-upload-'));
    await mkdir(path.join(dir, 'covers'), { recursive: true });
    await writeFile(path.join(dir, 'index.json'), '{"index_format":1}');
    await writeFile(path.join(dir, 'index-lite.json'), '{"index_format":1}');
    await writeFile(path.join(dir, 'rejected.json'), '[]');
    await writeFile(path.join(dir, 'manifest.schema.json'), '{"$id":"schema"}');
    await writeFile(path.join(dir, 'covers', 'placeholder.png'), Buffer.from('png-bytes'));
    await writeFile(path.join(dir, 'covers', 'john--demo.jpg'), Buffer.from('jpg-bytes'));
    await writeFile(path.join(dir, 'covers', 'jane--demo.jpeg'), Buffer.from('jpeg-bytes'));
    await mkdir(path.join(dir, 'docs', 'john--demo'), { recursive: true });
    await writeFile(path.join(dir, 'docs', 'john--demo', 'en.md'), Buffer.from('# English docs'));
    await mkdir(path.join(dir, 'integrations'), { recursive: true });
    await writeFile(path.join(dir, 'integrations', 'john--demo.json'), '{"store_slug":"john/demo"}');
    await writeFile(path.join(dir, 'extra.bin'), Buffer.from('binary'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should upload every file with forward slashes, the right content type, and the crawl documents last', async () => {
    const uploads = [];
    const putObject = async (params) => {
      uploads.push(params);
    };

    const { uploaded, skipped } = await uploadDirectory({ dir, putObject, logger: { log: () => {} } });

    expect(uploaded).to.deep.equal([
      'covers/jane--demo.jpeg',
      'covers/john--demo.jpg',
      'covers/placeholder.png',
      'docs/john--demo/en.md',
      'extra.bin',
      'integrations/john--demo.json',
      'manifest.schema.json',
      'index-lite.json',
      'index.json',
      'rejected.json',
    ]);
    expect(skipped).to.deep.equal([]);

    const byKey = Object.fromEntries(uploads.map((u) => [u.key, u]));
    expect(byKey['index.json'].contentType).to.equal('application/json');
    expect(byKey['index-lite.json'].contentType).to.equal('application/json');
    expect(byKey['rejected.json'].contentType).to.equal('application/json');
    expect(byKey['manifest.schema.json'].contentType).to.equal('application/json');
    expect(byKey['integrations/john--demo.json'].contentType).to.equal('application/json');
    expect(byKey['covers/placeholder.png'].contentType).to.equal('image/png');
    expect(byKey['covers/john--demo.jpg'].contentType).to.equal('image/jpeg');
    expect(byKey['covers/jane--demo.jpeg'].contentType).to.equal('image/jpeg');
    expect(byKey['docs/john--demo/en.md'].contentType).to.equal('text/markdown; charset=utf-8');
    expect(byKey['extra.bin'].contentType).to.equal('application/octet-stream');

    expect(byKey['index.json'].body.toString()).to.equal('{"index_format":1}');
    expect(byKey['covers/john--demo.jpg'].body.toString()).to.equal('jpg-bytes');
  });

  it('should cache the index and the integration entries short, the docs medium and everything else long', async () => {
    const uploads = [];
    const putObject = async (params) => {
      uploads.push(params);
    };

    await uploadDirectory({ dir, putObject, logger: { log: () => {} } });

    const byKey = Object.fromEntries(uploads.map((u) => [u.key, u]));
    expect(byKey['index.json'].cacheControl).to.equal('public, max-age=300');
    expect(byKey['index-lite.json'].cacheControl).to.equal('public, max-age=300');
    expect(byKey['rejected.json'].cacheControl).to.equal('public, max-age=300');
    expect(byKey['integrations/john--demo.json'].cacheControl).to.equal('public, max-age=300');
    expect(byKey['manifest.schema.json'].cacheControl).to.equal('public, max-age=86400');
    expect(byKey['covers/john--demo.jpg'].cacheControl).to.equal('public, max-age=86400');
    expect(byKey['docs/john--demo/en.md'].cacheControl).to.equal('public, max-age=3600');
  });

  it('should publish the crawl documents after every object they reference', async () => {
    const uploads = [];
    const putObject = async (params) => {
      uploads.push(params.key);
    };

    await uploadDirectory({ dir, putObject, logger: { log: () => {} } });

    const firstCrawlDocument = uploads.findIndex((key) =>
      ['index.json', 'index-lite.json', 'rejected.json'].includes(key),
    );
    expect(uploads.slice(firstCrawlDocument)).to.have.members(['index.json', 'index-lite.json', 'rejected.json']);
    expect(uploads.slice(0, firstCrawlDocument)).to.include('integrations/john--demo.json');
    expect(uploads.slice(0, firstCrawlDocument)).to.include('covers/john--demo.jpg');
    expect(uploads.slice(0, firstCrawlDocument)).to.include('docs/john--demo/en.md');
  });

  it('should default the logger to the console', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'integration-store-upload-empty-'));
    try {
      const { uploaded, skipped } = await uploadDirectory({ dir: emptyDir, putObject: async () => {} });
      expect(uploaded).to.deep.equal([]);
      expect(skipped).to.deep.equal([]);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should skip unchanged immutable objects and always re-upload the index documents', async () => {
    const uploads = [];
    const putObject = async (params) => {
      uploads.push(params.key);
    };
    let listCalls = 0;
    const listObjects = async () => {
      listCalls += 1;
      return new Map([
        // Byte-identical remote cover: must be skipped.
        ['covers/john--demo.jpg', `"${md5(Buffer.from('jpg-bytes'))}"`],
        // Remote cover with different bytes: must be re-uploaded.
        ['covers/jane--demo.jpeg', '"stale-etag"'],
        // Remote object without a usable ETag: must be re-uploaded.
        ['covers/placeholder.png', undefined],
        // Byte-identical remote integration entry: must be skipped, unlike the
        // index documents (an unchanged integration costs no write).
        ['integrations/john--demo.json', `"${md5(Buffer.from('{"store_slug":"john/demo"}'))}"`],
        // Byte-identical crawl document: re-uploaded anyway, without comparison.
        ['index.json', `"${md5(Buffer.from('{"index_format":1}'))}"`],
        // Everything else is absent remotely: must be uploaded.
      ]);
    };

    const { uploaded, skipped } = await uploadDirectory({ dir, putObject, listObjects, logger: { log: () => {} } });

    // A single listing for the whole upload, however many objects it holds.
    expect(listCalls).to.equal(1);
    expect(skipped).to.deep.equal(['covers/john--demo.jpg', 'integrations/john--demo.json']);
    expect(uploaded).to.deep.equal([
      'covers/jane--demo.jpeg',
      'covers/placeholder.png',
      'docs/john--demo/en.md',
      'extra.bin',
      'manifest.schema.json',
      'index-lite.json',
      'index.json',
      'rejected.json',
    ]);
    expect(uploads).to.have.members(uploaded);
  });

  it('should upload up to `concurrency` objects at a time, the crawl documents only once the rest is written', async () => {
    const events = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const putObject = async ({ key }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${key}`);
      inFlight -= 1;
    };

    const { uploaded } = await uploadDirectory({ dir, putObject, concurrency: 3, logger: { log: () => {} } });

    expect(maxInFlight).to.equal(3);
    expect(uploaded).to.have.lengthOf(10);
    // Every referenced object is fully written before the first crawl document starts.
    const firstCrawlDocumentStart = events.findIndex((event) =>
      ['start index.json', 'start index-lite.json', 'start rejected.json'].includes(event),
    );
    const lastReferencedEnd = events.findLastIndex(
      (event) =>
        event.startsWith('end ') && !['index.json', 'index-lite.json', 'rejected.json'].includes(event.slice(4)),
    );
    expect(lastReferencedEnd).to.be.below(firstCrawlDocumentStart);
  });

  it('should stop before the crawl documents when an upload fails', async () => {
    const uploads = [];
    const putObject = async ({ key }) => {
      if (key === 'covers/john--demo.jpg') {
        throw new Error('PUT failed');
      }
      uploads.push(key);
    };

    let caught;
    try {
      await uploadDirectory({ dir, putObject, concurrency: 2, logger: { log: () => {} } });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.an('error');
    expect(caught.message).to.equal('PUT failed');
    // The previous index stays in place: no crawl document was published.
    expect(uploads).to.not.include('index.json');
    expect(uploads).to.not.include('index-lite.json');
    expect(uploads).to.not.include('rejected.json');
  });
});
