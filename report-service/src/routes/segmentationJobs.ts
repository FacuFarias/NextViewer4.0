import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest, requirePermission } from '../auth';
import {
  beginPublishing,
  cancelSegmentationJob,
  claimSegmentationJobs,
  enqueueSegmentationJob,
  failSegmentationJob,
  getSegmentationJob,
  getSegmentationJobForLease,
  getSegmentationQueueMetrics,
  heartbeatSegmentationJob,
  listStudySegmentationStatuses,
  retrySegmentationJob,
  SegmentationJobRepositoryError,
} from '../repositories/segmentationJobRepository';
import { buildSourceManifest } from '../services/pacs';
import {
  assertS3Ready,
  outputObjectKey,
  presignObject,
  segmentationBucket,
  signedManifest,
} from '../services/s3';
import { CompleteSegmentationJobInput } from '../types/segmentationJobs';
import { publishSegmentationJob } from '../services/segmentationPublisher';

const router = Router();
router.use(authenticate);
const leaseMinutes = Math.max(1, Number(process.env.SEGMENTATION_LEASE_MINUTES || 15));
const defaultBatchSize = Math.max(1, Number(process.env.SEGMENTATION_BATCH_SIZE || 5));
const maxBatchSize = Math.max(defaultBatchSize, Number(process.env.SEGMENTATION_MAX_BATCH_SIZE || 20));

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SegmentationJobRepositoryError(400, `${field} is required`);
  }
  return value.trim();
}

function numberValue(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new SegmentationJobRepositoryError(400, `${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function triple(value: unknown, field: string, integer = false): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item =>
    !Number.isFinite(Number(item)) || Number(item) <= 0 || (integer && !Number.isInteger(Number(item))))) {
    throw new SegmentationJobRepositoryError(400, `${field} must contain three positive ${integer ? 'integers' : 'numbers'}`);
  }
  return value.map(Number) as [number, number, number];
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof SegmentationJobRepositoryError) {
    response.status(error.statusCode).json({ error: error.message }); return;
  }
  console.error('Segmentation job API error:', error);
  response.status(500).json({ error: 'Segmentation job operation failed' });
}

const username = (request: AuthenticatedRequest): string | null => request.user?.username || null;
const leaseToken = (request: AuthenticatedRequest): string =>
  requiredString(request.header('x-segmentation-lease-token'), 'X-Segmentation-Lease-Token');

router.post('/segmentation-status/query', requirePermission('segmentation:read'), async (request, response) => {
  try {
    const values = request.body?.studyInstanceUIDs;
    if (!Array.isArray(values) || values.length > 500) {
      throw new SegmentationJobRepositoryError(400, 'studyInstanceUIDs must be an array with at most 500 items');
    }
    const ids = [...new Set(values.map(value => requiredString(value, 'studyInstanceUID')))] as string[];
    response.json({ items: await listStudySegmentationStatuses(ids) });
  } catch (error) { sendError(response, error); }
});

router.post('/segmentation-jobs', requirePermission('segmentation:write'), async (request, response) => {
  try {
    assertS3Ready();
    const rawItems = request.body?.items;
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 100) {
      throw new SegmentationJobRepositoryError(400, 'items must contain between 1 and 100 jobs');
    }
    const modelName = requiredString(request.body?.modelName, 'modelName');
    const modelVersion = requiredString(request.body?.modelVersion, 'modelVersion');
    const requestKey = request.body?.idempotencyKey
      ? requiredString(request.body.idempotencyKey, 'idempotencyKey') : undefined;
    const jobs = [];
    for (const [index, item] of rawItems.entries()) {
      const studyInstanceUID = requiredString(item.studyInstanceUID, 'studyInstanceUID');
      const sourceSeriesInstanceUID = requiredString(item.sourceSeriesInstanceUID, 'sourceSeriesInstanceUID');
      const manifest = await buildSourceManifest(studyInstanceUID, sourceSeriesInstanceUID);
      jobs.push(await enqueueSegmentationJob({
        studyInstanceUID, sourceSeriesInstanceUID, modelName, modelVersion, inputManifest: manifest,
        idempotencyKey: requestKey ? `${requestKey}:${index}:${studyInstanceUID}:${sourceSeriesInstanceUID}` : undefined,
        priority: item.priority === undefined ? 0 : numberValue(item.priority, 'priority', -100, 100),
      }, username(request)));
    }
    response.status(201).json({ items: jobs });
  } catch (error) { sendError(response, error); }
});

router.get('/segmentation-metrics', requirePermission('segmentation:read'), async (_request, response) => {
  try { response.json(await getSegmentationQueueMetrics()); }
  catch (error) { sendError(response, error); }
});

router.get('/segmentation-jobs/:id', requirePermission('segmentation:read'), async (request, response) => {
  try { response.json(await getSegmentationJob(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.post('/segmentation-jobs/:id/retry', requirePermission('segmentation:write'), async (request, response) => {
  let publicationRetry = false;
  try {
    const retried = await retrySegmentationJob(request.params.id);
    publicationRetry = retried.status === 'publishing';
    response.json(publicationRetry ? await publishSegmentationJob(request.params.id) : retried);
  }
  catch (error) {
    if (publicationRetry) {
      await failSegmentationJob(request.params.id, null, 'PUBLISH_FAILED',
        error instanceof Error ? error.message : 'Publication failed', false).catch(() => undefined);
    }
    sendError(response, error);
  }
});

router.post('/segmentation-jobs/:id/cancel', requirePermission('segmentation:write'), async (request, response) => {
  try { response.json(await cancelSegmentationJob(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.post('/worker/segmentation-jobs/claim', requirePermission('segmentation:worker'), async (request, response) => {
  try {
    assertS3Ready();
    const workerId = requiredString(request.body?.workerId, 'workerId');
    const batchSize = request.body?.batchSize === undefined ? defaultBatchSize :
      numberValue(request.body.batchSize, 'batchSize', 1, maxBatchSize);
    const claimed = await claimSegmentationJobs(
      workerId, Math.floor(batchSize), leaseMinutes,
      request.body?.modelName ? requiredString(request.body.modelName, 'modelName') : undefined,
      request.body?.modelVersion ? requiredString(request.body.modelVersion, 'modelVersion') : undefined
    );
    response.json({
      items: await Promise.all(claimed.map(async item => ({
        ...item, inputManifest: await signedManifest(item.job.inputManifest),
      }))),
      leaseMinutes,
    });
  } catch (error) { sendError(response, error); }
});

router.post('/worker/segmentation-jobs/:id/heartbeat', requirePermission('segmentation:worker'), async (request, response) => {
  try {
    const stage = requiredString(request.body?.stage || 'processing', 'stage');
    const progress = numberValue(request.body?.progress ?? 0, 'progress', 0, 100);
    response.json(await heartbeatSegmentationJob(request.params.id, leaseToken(request), stage, progress, leaseMinutes));
  } catch (error) { sendError(response, error); }
});

router.get('/worker/segmentation-jobs/:id/input-manifest', requirePermission('segmentation:worker'), async (request, response) => {
  try {
    const job = await getSegmentationJobForLease(request.params.id, leaseToken(request));
    response.json(await signedManifest(job.inputManifest));
  } catch (error) { sendError(response, error); }
});

router.post('/worker/segmentation-jobs/:id/output-upload-url', requirePermission('segmentation:worker'), async (request, response) => {
  try {
    assertS3Ready();
    const job = await getSegmentationJobForLease(request.params.id, leaseToken(request));
    const checksum = requiredString(request.body?.checksumSha256, 'checksumSha256');
    const key = outputObjectKey(job.studyInstanceUID, job.sourceSeriesInstanceUID, job.id);
    response.json({ bucket: segmentationBucket, key,
      ...await presignObject('PUT', segmentationBucket, key, { checksumSha256: checksum }) });
  } catch (error) { sendError(response, error); }
});

router.post('/worker/segmentation-jobs/:id/complete', requirePermission('segmentation:worker'), async (request, response) => {
  let publicationStarted = false;
  try {
    const body = request.body || {};
    const output: CompleteSegmentationJobInput = {
      bucket: requiredString(body.bucket, 'bucket'), key: requiredString(body.key, 'key'),
      versionId: body.versionId || undefined, etag: body.etag || undefined,
      checksumSha256: requiredString(body.checksumSha256, 'checksumSha256'),
      sizeBytes: numberValue(body.sizeBytes, 'sizeBytes', 1, Number.MAX_SAFE_INTEGER),
      segmentationSeriesInstanceUID: requiredString(body.segmentationSeriesInstanceUID, 'segmentationSeriesInstanceUID'),
      segmentationSOPInstanceUID: requiredString(body.segmentationSOPInstanceUID, 'segmentationSOPInstanceUID'),
      frameOfReferenceUID: body.frameOfReferenceUID || null,
      dimensions: triple(body.dimensions, 'dimensions', true), spacing: triple(body.spacing, 'spacing'),
      ontologyVersion: requiredString(body.ontologyVersion, 'ontologyVersion'),
      name: requiredString(body.name, 'name'), description: body.description || null,
      weightsHash: body.weightsHash || null, parameters: body.parameters || {},
    };
    const token = leaseToken(request);
    const current = await getSegmentationJob(request.params.id);
    if (current.status === 'completed') { response.json(current); return; }
    const leased = await getSegmentationJobForLease(request.params.id, token);
    const expectedKey = outputObjectKey(leased.studyInstanceUID, leased.sourceSeriesInstanceUID, leased.id);
    if (output.bucket !== segmentationBucket || output.key !== expectedKey) {
      throw new SegmentationJobRepositoryError(400, 'Output S3 location does not match the reserved job location');
    }
    const publishing = await beginPublishing(request.params.id, token, output);
    publicationStarted = true;
    if (publishing.status === 'completed') { response.json(publishing); return; }
    response.json(await publishSegmentationJob(request.params.id));
  } catch (error) {
    if (request.params.id && publicationStarted) {
      await failSegmentationJob(request.params.id, null, 'PUBLISH_FAILED', error instanceof Error ? error.message : 'Publication failed', false)
        .catch(() => undefined);
    }
    sendError(response, error);
  }
});

router.post('/worker/segmentation-jobs/:id/fail', requirePermission('segmentation:worker'), async (request, response) => {
  try {
    response.json(await failSegmentationJob(
      request.params.id, leaseToken(request), requiredString(request.body?.code || 'WORKER_FAILED', 'code'),
      requiredString(request.body?.message, 'message'), Boolean(request.body?.retryable)
    ));
  } catch (error) { sendError(response, error); }
});

export default router;
