import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ManifestObject, SegmentationInputManifest } from '../types/segmentationJobs';

export class S3ConfigurationError extends Error {}

const region = process.env.AWS_REGION || 'us-east-1';
const endpoint = process.env.S3_ENDPOINT || undefined;
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true' || Boolean(endpoint);
export const sourceDicomBucket = process.env.SOURCE_DICOM_BUCKET || '';
export const segmentationBucket = process.env.SEGMENTATION_BUCKET || sourceDicomBucket;
const sourcePrefixTemplate = process.env.SOURCE_DICOM_PREFIX_TEMPLATE ||
  'studies/{studyInstanceUID}/series/{seriesInstanceUID}/';
const outputPrefix = (process.env.SEGMENTATION_OUTPUT_PREFIX || 'dicom-seg').replace(/^\/+|\/+$/g, '');
const presignSeconds = Math.max(60, Number(process.env.S3_PRESIGN_SECONDS || 3600));

const client = new S3Client({ region, endpoint, forcePathStyle });

export async function listCommonPrefixes(bucket: string, prefix: string): Promise<string[]> {
  const prefixes: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    prefixes.push(...(result.CommonPrefixes || []).flatMap(item => item.Prefix ? [item.Prefix] : []));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return prefixes;
}

export async function summarizeObjects(bucket: string, prefix: string): Promise<{
  objectCount: number;
  totalSizeBytes: number;
  representativeObjectKey: string | null;
  lastModifiedAt: Date | null;
}> {
  let objectCount = 0;
  let totalSizeBytes = 0;
  let representativeObjectKey: string | null = null;
  let lastModifiedAt: Date | null = null;
  let continuationToken: string | undefined;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    for (const object of result.Contents || []) {
      if (!object.Key || object.Key.endsWith('/')) continue;
      objectCount += 1;
      totalSizeBytes += Number(object.Size || 0);
      if (!representativeObjectKey && /\.dcm$/i.test(object.Key)) representativeObjectKey = object.Key;
      if (object.LastModified && (!lastModifiedAt || object.LastModified > lastModifiedAt)) {
        lastModifiedAt = object.LastModified;
      }
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return { objectCount, totalSizeBytes, representativeObjectKey, lastModifiedAt };
}

export async function getObjectBytes(
  bucket: string, key: string, options: { versionId?: string; range?: string } = {}
): Promise<Uint8Array> {
  const result = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    VersionId: options.versionId,
    Range: options.range,
  }));
  if (!result.Body) throw new Error('S3 GetObject returned an empty body');
  return result.Body.transformToByteArray();
}

export function sourcePrefix(studyInstanceUID: string, seriesInstanceUID: string): string {
  return sourcePrefixTemplate
    .replace('{studyInstanceUID}', studyInstanceUID)
    .replace('{seriesInstanceUID}', seriesInstanceUID)
    .replace(/^\/+/, '');
}

export async function listBucketObjects(bucket: string, prefix: string): Promise<Array<{
  key: string; etag?: string; size?: number;
}>> {
  const objects: Array<{ key: string; etag?: string; size?: number }> = [];
  let continuationToken: string | undefined;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    objects.push(...(result.Contents || []).flatMap(object => object.Key ? [{
      key: object.Key,
      etag: object.ETag?.replace(/^"|"$/g, ''),
      size: object.Size,
    }] : []));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

export async function listSourceObjects(prefix: string): Promise<Array<{
  key: string; etag?: string; size?: number;
}>> {
  assertS3Ready();
  return listBucketObjects(sourceDicomBucket, prefix);
}

export function outputObjectKey(studyUID: string, seriesUID: string, jobId: string): string {
  return `${outputPrefix}/${studyUID}/${seriesUID}/${jobId}.dcm`;
}

export async function presignObject(
  method: 'GET' | 'PUT', bucket: string, key: string,
  options: { versionId?: string; checksumSha256?: string; expiresSeconds?: number } = {}
): Promise<{ url: string; headers: Record<string, string> }> {
  assertS3Ready();
  const command = method === 'GET'
    ? new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: options.versionId })
    : new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumSHA256: options.checksumSha256,
        ServerSideEncryption: process.env.S3_KMS_KEY_ID ? 'aws:kms' : undefined,
        SSEKMSKeyId: process.env.S3_KMS_KEY_ID || undefined,
      });
  const headers: Record<string, string> = {};
  if (options.checksumSha256) headers['x-amz-checksum-sha256'] = options.checksumSha256;
  if (process.env.S3_KMS_KEY_ID && method === 'PUT') {
    headers['x-amz-server-side-encryption'] = 'aws:kms';
    headers['x-amz-server-side-encryption-aws-kms-key-id'] = process.env.S3_KMS_KEY_ID;
  }
  return {
    url: await getSignedUrl(client, command, { expiresIn: options.expiresSeconds || presignSeconds }),
    headers,
  };
}

export async function signedManifest(manifest: SegmentationInputManifest): Promise<
  SegmentationInputManifest & { objects: Array<ManifestObject & { downloadUrl: string }> }
> {
  return {
    ...manifest,
    objects: await Promise.all(manifest.objects.map(async object => ({
      ...object,
      downloadUrl: (await presignObject('GET', manifest.bucket, object.key, {
        versionId: object.versionId,
      })).url,
    }))),
  };
}

export async function headObject(bucket: string, key: string, versionId?: string): Promise<{
  etag: string | null; checksumSha256: string | null; size: number; versionId: string | null;
}> {
  const result = await client.send(new HeadObjectCommand({
    Bucket: bucket, Key: key, VersionId: versionId, ChecksumMode: 'ENABLED',
  }));
  return {
    etag: result.ETag?.replace(/^"|"$/g, '') || null,
    checksumSha256: result.ChecksumSHA256 || null,
    size: Number(result.ContentLength || 0),
    versionId: result.VersionId || null,
  };
}

export async function getObject(bucket: string, key: string, versionId?: string): Promise<ArrayBuffer> {
  const bytes = await getObjectBytes(bucket, key, { versionId });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function putDicomSeg(bucket: string, key: string, bytes: ArrayBuffer): Promise<{
  etag: string | null; checksumSha256: string; size: number; versionId: string | null;
}> {
  assertS3Ready();
  const body = Buffer.from(bytes);
  const checksumSha256 = createHash('sha256').update(body).digest('base64');
  const result = await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/dicom',
    ChecksumSHA256: checksumSha256,
    ServerSideEncryption: process.env.S3_KMS_KEY_ID ? 'aws:kms' : undefined,
    SSEKMSKeyId: process.env.S3_KMS_KEY_ID || undefined,
  }));
  return {
    etag: result.ETag?.replace(/^"|"$/g, '') || null,
    checksumSha256,
    size: body.byteLength,
    versionId: result.VersionId || null,
  };
}

export function assertS3Ready(): void {
  if (!sourceDicomBucket || !segmentationBucket) {
    throw new S3ConfigurationError('SOURCE_DICOM_BUCKET and SEGMENTATION_BUCKET must be configured');
  }
}
