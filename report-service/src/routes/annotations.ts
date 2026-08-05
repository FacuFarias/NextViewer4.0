import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest, hasPermission, requirePermission } from '../auth';
import {
  AnnotationRepositoryError,
  createAnnotation,
  createAnnotationSet,
  createAnnotationsBulk,
  deleteAnnotation,
  getAnnotation,
  getAnnotationHistory,
  getAnnotationSet,
  listAnnotationSets,
  listAnnotations,
  updateAnnotation,
  updateAnnotationSet,
} from '../repositories/annotationRepository';
import {
  AnnotationFilters,
  AnnotationSource,
  AnnotationStatus,
  CreateAnnotationInput,
  CreateAnnotationSetInput,
} from '../types/annotations';

const router = Router();
router.use(authenticate);

function valueString(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AnnotationRepositoryError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new AnnotationRepositoryError(400, `${field} must be a string`);
  return value;
}

function valueNumber(value: unknown, field: string, required = false): number | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AnnotationRepositoryError(400, `${field} is required`);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AnnotationRepositoryError(400, `${field} must be numeric`);
  return parsed;
}

function validateGeometry(geometry: any): void {
  if (!geometry || geometry.coordinateSystem !== 'IMAGE_PIXEL' ||
      !Number.isFinite(geometry.imageWidth) || !Number.isFinite(geometry.imageHeight) ||
      !Array.isArray(geometry.points) ||
      geometry.points.some((point: any) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    throw new AnnotationRepositoryError(400, 'geometry must use IMAGE_PIXEL coordinates and decimal points');
  }
}

function validateNasalSeptumDeviationGeometry(geometry: any): void {
  const shape = geometry?.shape;
  const pointNames = ['axis_start', 'axis_end', 'deviation_point', 'projection_point'];
  const isFinitePoint = (point: any): boolean =>
    Number.isFinite(point?.x) && Number.isFinite(point?.y);

  if (geometry?.points?.length < 4 || pointNames.some(name => !isFinitePoint(shape?.[name]))) {
    throw new AnnotationRepositoryError(400, 'nasal_septum_deviation requires four named points');
  }

  if (shape.measurement !== 'nasal_septum_deviation' ||
      !Number.isFinite(shape.axis_length_mm) ||
      !Number.isFinite(shape.deviation_length_mm) ||
      !Array.isArray(shape.pixel_spacing) ||
      shape.pixel_spacing.length < 2 ||
      !shape.pixel_spacing.slice(0, 2).every((value: unknown) => Number.isFinite(value) && Number(value) > 0)) {
    throw new AnnotationRepositoryError(400, 'nasal_septum_deviation requires valid millimetric measurements');
  }
}

function buildCreateAnnotation(body: any): CreateAnnotationInput {
  const geometry = body.geometry;
  validateGeometry(geometry);
  if (body.geometryType === 'nasal_septum_deviation') {
    validateNasalSeptumDeviationGeometry(geometry);
  }
  const source = body.source || 'HUMAN';
  const status = body.status || 'draft';
  if (!['HUMAN', 'AI', 'AI_CORRECTED'].includes(source)) {
    throw new AnnotationRepositoryError(400, 'Invalid annotation source');
  }
  if (!['draft', 'reviewed', 'approved', 'rejected', 'archived'].includes(status)) {
    throw new AnnotationRepositoryError(400, 'Invalid annotation status');
  }

  return {
    annotationSetId: valueString(body.annotationSetId, 'annotationSetId')!,
    studyInstanceUID: valueString(body.studyInstanceUID, 'studyInstanceUID')!,
    seriesInstanceUID: valueString(body.seriesInstanceUID, 'seriesInstanceUID')!,
    sopInstanceUID: valueString(body.sopInstanceUID, 'sopInstanceUID')!,
    frameNumber: valueNumber(body.frameNumber, 'frameNumber'),
    instanceNumber: valueNumber(body.instanceNumber, 'instanceNumber'),
    labelCode: valueString(body.labelCode, 'labelCode')!,
    labelName: valueString(body.labelName, 'labelName')!,
    toolName: valueString(body.toolName, 'toolName')!,
    color: body.color ?? null,
    geometryType: valueString(body.geometryType, 'geometryType')!,
    geometry,
    source: source as AnnotationSource,
    status: status as AnnotationStatus,
    modelRunId: body.modelRunId ?? null,
    confidence: valueNumber(body.confidence, 'confidence'),
    cornerstoneAnnotationUID: body.cornerstoneAnnotationUID ?? null,
    imageMetadata: body.imageMetadata || {},
    clientMutationId: body.clientMutationId,
  };
}

function username(request: AuthenticatedRequest): string | null {
  return request.user?.username || null;
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof AnnotationRepositoryError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error('Annotation API error:', error);
  response.status(500).json({ error: 'Annotation operation failed' });
}

function requireReview(request: AuthenticatedRequest): void {
  if (!hasPermission(request.user, 'annotation:review')) {
    throw new AnnotationRepositoryError(request.user ? 403 : 401, 'Review permission required');
  }
}

router.post('/annotation-sets', requirePermission('annotation:write'), async (request, response) => {
  try {
    const body = request.body || {};
    const status = body.status || 'draft';
    if (status !== 'draft') requireReview(request);
    const input: CreateAnnotationSetInput = {
      studyInstanceUID: valueString(body.studyInstanceUID, 'studyInstanceUID')!,
      name: valueString(body.name, 'name')!,
      description: body.description ?? null,
      ontologyVersion: valueString(body.ontologyVersion, 'ontologyVersion')!,
      status,
      isDefault: Boolean(body.isDefault),
    };
    response.status(201).json(await createAnnotationSet(input, username(request)));
  } catch (error) { sendError(response, error); }
});

router.get('/annotation-sets/:id', requirePermission('annotation:read'), async (request, response) => {
  try { response.json(await getAnnotationSet(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.get('/studies/:studyInstanceUID/annotation-sets', requirePermission('annotation:read'), async (request, response) => {
  try { response.json(await listAnnotationSets(request.params.studyInstanceUID)); }
  catch (error) { sendError(response, error); }
});

router.patch('/annotation-sets/:id', requirePermission('annotation:write'), async (request, response) => {
  try {
    if (request.body?.status && request.body.status !== 'draft') requireReview(request);
    response.json(await updateAnnotationSet(request.params.id, {
      name: request.body?.name,
      description: request.body?.description,
      status: request.body?.status,
    }));
  } catch (error) { sendError(response, error); }
});

router.post('/annotations/bulk', requirePermission('annotation:write'), async (request, response) => {
  try {
    const clientMutationId = valueString(request.body?.clientMutationId, 'clientMutationId')!;
    const rawItems = request.body?.annotations;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new AnnotationRepositoryError(400, 'annotations must be a non-empty array');
    }
    const inputs = rawItems.map((item: any) => buildCreateAnnotation(item));
    if (inputs.some(input => input.status !== 'draft')) requireReview(request);
    response.status(201).json({ items: await createAnnotationsBulk(inputs, clientMutationId, username(request)) });
  } catch (error) { sendError(response, error); }
});

router.post('/annotations', requirePermission('annotation:write'), async (request, response) => {
  try {
    const input = buildCreateAnnotation(request.body || {});
    if (input.status !== 'draft') requireReview(request);
    response.status(201).json(await createAnnotation(input, username(request)));
  } catch (error) { sendError(response, error); }
});

router.get('/annotations', requirePermission('annotation:read'), async (request, response) => {
  try {
    const filters: AnnotationFilters = {
      studyInstanceUID: typeof request.query.studyInstanceUID === 'string' ? request.query.studyInstanceUID : undefined,
      seriesInstanceUID: typeof request.query.seriesInstanceUID === 'string' ? request.query.seriesInstanceUID : undefined,
      sopInstanceUID: typeof request.query.sopInstanceUID === 'string' ? request.query.sopInstanceUID : undefined,
      frameNumber: request.query.frameNumber === undefined ? undefined : valueNumber(request.query.frameNumber, 'frameNumber'),
      annotationSetId: typeof request.query.annotationSetId === 'string' ? request.query.annotationSetId : undefined,
      labelCode: typeof request.query.labelCode === 'string' ? request.query.labelCode : undefined,
      source: typeof request.query.source === 'string' ? request.query.source as AnnotationSource : undefined,
      status: typeof request.query.status === 'string' ? request.query.status as AnnotationStatus : undefined,
      latestOnly: request.query.latestOnly === 'true',
      limit: Math.min(Math.max(Number(request.query.limit || 100), 1), 500),
      offset: Math.max(Number(request.query.offset || 0), 0),
    };
    response.json(await listAnnotations(filters));
  } catch (error) { sendError(response, error); }
});

router.get('/annotations/:id/history', requirePermission('annotation:read'), async (request, response) => {
  try { response.json(await getAnnotationHistory(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.get('/annotations/:id', requirePermission('annotation:read'), async (request, response) => {
  try { response.json(await getAnnotation(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.patch('/annotations/:id', requirePermission('annotation:write'), async (request, response) => {
  try {
    const input = request.body || {};
    const expectedVersion = valueNumber(input.expectedVersion, 'expectedVersion', true)!;
    if (input.status && input.status !== 'draft') requireReview(request);
    if (input.geometry) {
      validateGeometry(input.geometry);
      if (input.geometryType === 'nasal_septum_deviation' ||
          input.geometry.shape?.measurement === 'nasal_septum_deviation') {
        validateNasalSeptumDeviationGeometry(input.geometry);
      }
    }
    response.json(await updateAnnotation(request.params.id, {
      ...input,
      expectedVersion,
    }, username(request)));
  } catch (error) { sendError(response, error); }
});

router.delete('/annotations/:id', requirePermission('annotation:delete'), async (request, response) => {
  try {
    const expectedVersion = request.body?.expectedVersion === undefined
      ? undefined
      : valueNumber(request.body.expectedVersion, 'expectedVersion', true);
    response.json(await deleteAnnotation(request.params.id, expectedVersion));
  } catch (error) { sendError(response, error); }
});

export default router;
