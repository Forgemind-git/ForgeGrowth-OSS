// Thin MinIO (S3-compatible) wrapper. One bucket holds every Media Library
// object. We use minio's native node client to avoid pulling in aws-sdk.

const { Client } = require('minio');
const { Readable } = require('stream');

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'minio';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000', 10);
const MINIO_USE_SSL = String(process.env.MINIO_USE_SSL || 'false') === 'true';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || 'minioadmin';

const BUCKET = process.env.FORGECRM_MEDIA_BUCKET || 'forgecrm-media';

let _client = null;
function client() {
  if (!_client) {
    _client = new Client({
      endPoint: MINIO_ENDPOINT,
      port: MINIO_PORT,
      useSSL: MINIO_USE_SSL,
      accessKey: MINIO_ACCESS_KEY,
      secretKey: MINIO_SECRET_KEY,
    });
  }
  return _client;
}

async function ensureBucket() {
  const c = client();
  const exists = await c.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await c.makeBucket(BUCKET);
    console.log(`[minio] created bucket "${BUCKET}"`);
  }
}

async function putObject(objectKey, buffer, mimeType) {
  await client().putObject(BUCKET, objectKey, buffer, buffer.length, {
    'Content-Type': mimeType,
  });
}

async function getObjectBuffer(objectKey) {
  const stream = await client().getObject(BUCKET, objectKey);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function removeObject(objectKey) {
  await client().removeObject(BUCKET, objectKey).catch(() => {});
}

function bucketName() { return BUCKET; }

module.exports = {
  ensureBucket,
  putObject,
  getObjectBuffer,
  removeObject,
  bucketName,
};
