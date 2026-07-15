import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { expect } from 'chai';

import { createR2Client, createR2HeadObject, createR2PutObject, uploadDirectory } from '../src/uploadToR2.js';

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

describe('createR2HeadObject', () => {
  it('should return the ETag of an existing object', async () => {
    const sent = [];
    const fakeClient = {
      send: async (command) => {
        sent.push(command);
        return { ETag: '"abc123"' };
      },
    };
    const headObject = createR2HeadObject({ client: fakeClient, bucket: 'my-bucket' });

    const result = await headObject({ key: 'covers/john--demo.jpg' });

    expect(sent).to.have.lengthOf(1);
    expect(sent[0]).to.be.instanceOf(HeadObjectCommand);
    expect(sent[0].input).to.deep.equal({ Bucket: 'my-bucket', Key: 'covers/john--demo.jpg' });
    expect(result).to.deep.equal({ etag: '"abc123"' });
  });

  it('should return null when the object does not exist (NotFound)', async () => {
    const fakeClient = {
      send: async () => {
        const error = new Error('not found');
        error.name = 'NotFound';
        throw error;
      },
    };
    const headObject = createR2HeadObject({ client: fakeClient, bucket: 'my-bucket' });

    expect(await headObject({ key: 'missing.json' })).to.equal(null);
  });

  it('should return null when the object does not exist (NoSuchKey)', async () => {
    const fakeClient = {
      send: async () => {
        const error = new Error('no such key');
        error.name = 'NoSuchKey';
        throw error;
      },
    };
    const headObject = createR2HeadObject({ client: fakeClient, bucket: 'my-bucket' });

    expect(await headObject({ key: 'missing.json' })).to.equal(null);
  });

  it('should rethrow any other error', async () => {
    const fakeClient = {
      send: async () => {
        const error = new Error('boom');
        error.name = 'InternalError';
        throw error;
      },
    };
    const headObject = createR2HeadObject({ client: fakeClient, bucket: 'my-bucket' });

    let caught;
    try {
      await headObject({ key: 'x.json' });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.an('error');
    expect(caught.message).to.equal('boom');
  });
});

describe('uploadDirectory', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'integration-store-upload-'));
    await mkdir(path.join(dir, 'covers'), { recursive: true });
    await writeFile(path.join(dir, 'index.json'), '{"index_format":1}');
    await writeFile(path.join(dir, 'rejected.json'), '[]');
    await writeFile(path.join(dir, 'manifest.schema.json'), '{"$id":"schema"}');
    await writeFile(path.join(dir, 'covers', 'placeholder.png'), Buffer.from('png-bytes'));
    await writeFile(path.join(dir, 'covers', 'john--demo.jpg'), Buffer.from('jpg-bytes'));
    await writeFile(path.join(dir, 'covers', 'jane--demo.jpeg'), Buffer.from('jpeg-bytes'));
    await writeFile(path.join(dir, 'extra.bin'), Buffer.from('binary'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should upload every file with a sorted key, forward slashes and the right content type', async () => {
    const uploads = [];
    const putObject = async (params) => {
      uploads.push(params);
    };

    const { uploaded, skipped } = await uploadDirectory({ dir, putObject, logger: { log: () => {} } });

    expect(uploaded).to.deep.equal([
      'covers/jane--demo.jpeg',
      'covers/john--demo.jpg',
      'covers/placeholder.png',
      'extra.bin',
      'index.json',
      'manifest.schema.json',
      'rejected.json',
    ]);
    expect(skipped).to.deep.equal([]);

    const byKey = Object.fromEntries(uploads.map((u) => [u.key, u]));
    expect(byKey['index.json'].contentType).to.equal('application/json');
    expect(byKey['rejected.json'].contentType).to.equal('application/json');
    expect(byKey['manifest.schema.json'].contentType).to.equal('application/json');
    expect(byKey['covers/placeholder.png'].contentType).to.equal('image/png');
    expect(byKey['covers/john--demo.jpg'].contentType).to.equal('image/jpeg');
    expect(byKey['covers/jane--demo.jpeg'].contentType).to.equal('image/jpeg');
    expect(byKey['extra.bin'].contentType).to.equal('application/octet-stream');

    expect(byKey['index.json'].body.toString()).to.equal('{"index_format":1}');
    expect(byKey['covers/john--demo.jpg'].body.toString()).to.equal('jpg-bytes');
  });

  it('should cache the index short and everything else long', async () => {
    const uploads = [];
    const putObject = async (params) => {
      uploads.push(params);
    };

    await uploadDirectory({ dir, putObject, logger: { log: () => {} } });

    const byKey = Object.fromEntries(uploads.map((u) => [u.key, u]));
    expect(byKey['index.json'].cacheControl).to.equal('public, max-age=300');
    expect(byKey['rejected.json'].cacheControl).to.equal('public, max-age=300');
    expect(byKey['manifest.schema.json'].cacheControl).to.equal('public, max-age=86400');
    expect(byKey['covers/john--demo.jpg'].cacheControl).to.equal('public, max-age=86400');
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
    const headCalls = [];
    const headObject = async ({ key }) => {
      headCalls.push(key);
      // Byte-identical remote cover: must be skipped.
      if (key === 'covers/john--demo.jpg') {
        return { etag: `"${md5(Buffer.from('jpg-bytes'))}"` };
      }
      // Remote cover with different bytes: must be re-uploaded.
      if (key === 'covers/jane--demo.jpeg') {
        return { etag: '"stale-etag"' };
      }
      // Remote object without a usable ETag: must be re-uploaded.
      if (key === 'covers/placeholder.png') {
        return { etag: undefined };
      }
      // Everything else is absent remotely: must be uploaded.
      return null;
    };

    const { uploaded, skipped } = await uploadDirectory({ dir, putObject, headObject, logger: { log: () => {} } });

    expect(skipped).to.deep.equal(['covers/john--demo.jpg']);
    expect(uploaded).to.deep.equal([
      'covers/jane--demo.jpeg',
      'covers/placeholder.png',
      'extra.bin',
      'index.json',
      'manifest.schema.json',
      'rejected.json',
    ]);
    expect(uploads).to.deep.equal(uploaded);
    // The mutable index documents are re-uploaded without a HEAD probe.
    expect(headCalls).to.not.include('index.json');
    expect(headCalls).to.not.include('rejected.json');
    expect(headCalls).to.include('manifest.schema.json');
  });
});
