import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest, requirePermission } from '../auth';
import {
  createSegmentationObject,
  getSegmentationObject,
  listSegmentationObjects,
  SegmentationObjectRepositoryError,
  updateSegmentationObject,
  markSegmentationObjectS3,
} from '../repositories/segmentationObjectRepository';
import {
  CreateSegmentationObjectInput,
  SegmentationObjectStatus,
} from '../types/segmentationObjects';
import { fetchDicomInstance } from '../services/pacs';
import { putDicomSeg, segmentationBucket } from '../services/s3';
import { getReferenceStudySourcePrefix } from '../repositories/referenceStorageRepository';

const router = Router();
router.use(authenticate);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SegmentationObjectRepositoryError(400, `${field} is required`);
  }
  return value.trim();
}

function dimensions(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 ||
      !value.every(item => Number.isInteger(item) && Number(item) > 0)) {
    throw new SegmentationObjectRepositoryError(400, `${field} must contain three positive integers`);
  }
  return value.map(Number) as [number, number, number];
}

function spacing(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 ||
      !value.every(item => Number.isFinite(Number(item)) && Number(item) > 0)) {
    throw new SegmentationObjectRepositoryError(400, 'spacing must contain three positive numbers');
  }
  return value.map(Number) as [number, number, number];
}

function status(value: unknown, fallback: SegmentationObjectStatus = 'draft'): SegmentationObjectStatus {
  const candidate = value || fallback;
  if (candidate !== 'draft' && candidate !== 'superseded' && candidate !== 'archived') {
    throw new SegmentationObjectRepositoryError(400, 'Invalid segmentation object status');
  }
  return candidate;
}

function buildInput(body: any): CreateSegmentationObjectInput {
  const version = body.version === undefined ? 1 : Number(body.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new SegmentationObjectRepositoryError(400, 'version must be a positive integer');
  }
  return {
    studyInstanceUID: requiredString(body.studyInstanceUID, 'studyInstanceUID'),
    sourceSeriesInstanceUID: requiredString(body.sourceSeriesInstanceUID, 'sourceSeriesInstanceUID'),
    segmentationSeriesInstanceUID: requiredString(body.segmentationSeriesInstanceUID, 'segmentationSeriesInstanceUID'),
    segmentationSOPInstanceUID: requiredString(body.segmentationSOPInstanceUID, 'segmentationSOPInstanceUID'),
    name: requiredString(body.name, 'name'),
    description: body.description ?? null,
    ontologyVersion: requiredString(body.ontologyVersion, 'ontologyVersion'),
    dimensions: dimensions(body.dimensions, 'dimensions'),
    spacing: spacing(body.spacing),
    frameOfReferenceUID: body.frameOfReferenceUID || null,
    version,
    supersedesObjectId: body.supersedesObjectId || null,
    status: status(body.status),
  };
}

function username(request: AuthenticatedRequest): string | null {
  return request.user?.username || null;
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof SegmentationObjectRepositoryError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error('Segmentation object API error:', error);
  response.status(500).json({ error: 'Segmentation object operation failed' });
}

router.get('/segmentation-objects', requirePermission('segmentation:read'), async (request, response) => {
  try {
    const study = requiredString(request.query.studyInstanceUID, 'studyInstanceUID');
    const series = request.query.sourceSeriesInstanceUID === undefined
      ? undefined
      : requiredString(request.query.sourceSeriesInstanceUID, 'sourceSeriesInstanceUID');
    response.json(await listSegmentationObjects(study, series));
  } catch (error) { sendError(response, error); }
});

router.post('/segmentation-objects', requirePermission('segmentation:write'), async (request, response) => {
  try {
    response.status(201).json(await createSegmentationObject(buildInput(request.body || {}), username(request)));
  } catch (error) { sendError(response, error); }
});

router.get('/segmentation-objects/:id', requirePermission('segmentation:read'), async (request, response) => {
  try { response.json(await getSegmentationObject(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.post('/segmentation-objects/:id/push-s3', requirePermission('segmentation:write'), async (request, response) => {
  try {
    const object = await getSegmentationObject(request.params.id);
    if (object.status === 'archived') throw new SegmentationObjectRepositoryError(409, 'Archived SEG objects cannot be pushed');
    const studyPrefix = await getReferenceStudySourcePrefix(object.studyInstanceUID);
    // The backend derives this prefix from the catalog; callers cannot choose
    // an arbitrary S3 location. SEG files stay inside the study's OP-* folder.
    const key = `${studyPrefix}/SEG/${object.id}.dcm`;
    const bytes = await fetchDicomInstance(
      object.studyInstanceUID, object.segmentationSeriesInstanceUID, object.segmentationSOPInstanceUID
    );
    const uploaded = await putDicomSeg(segmentationBucket, key, bytes);
    response.json(await markSegmentationObjectS3(object.id, {
      bucket: segmentationBucket, key, versionId: uploaded.versionId, etag: uploaded.etag,
      checksumSha256: uploaded.checksumSha256, sizeBytes: uploaded.size,
    }));
  } catch (error) { sendError(response, error); }
});

router.patch('/segmentation-objects/:id', requirePermission('segmentation:write'), async (request, response) => {
  try {
    const body = request.body || {};
    const input = {
      name: body.name === undefined ? undefined : requiredString(body.name, 'name'),
      description: body.description,
      status: body.status === undefined ? undefined : status(body.status),
    };
    response.json(await updateSegmentationObject(request.params.id, input));
  } catch (error) { sendError(response, error); }
});

export default router;
