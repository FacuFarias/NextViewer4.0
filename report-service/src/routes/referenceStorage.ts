import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest, requirePermission } from '../auth';
import {
  enqueueReferenceImport,
  enqueueReferenceImports,
  getReferenceImport,
  getReferenceStudy,
  listReferenceStudies,
  ReferenceStorageError,
} from '../repositories/referenceStorageRepository';
import { processReferenceImportQueue } from '../services/referenceImporter';

const router = Router();
router.use(authenticate);

function sendError(response: Response, error: unknown): void {
  if (error instanceof ReferenceStorageError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error('Reference storage API error:', error);
  response.status(500).json({ error: 'Reference storage operation failed' });
}

router.get('/reference-studies', requirePermission('segmentation:read'), async (request, response) => {
  try {
    const requestedLimit = Number(request.query.limit || 20);
    const requestedOffset = Number(request.query.offset || 0);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(20, Math.floor(requestedLimit)))
      : 20;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const segValue = String(request.query.seg || 'all');
    const seg = segValue === 'with' || segValue === 'without' ? segValue : 'all';
    const importStatus = request.query.importStatus ? String(request.query.importStatus) : undefined;
    response.json(await listReferenceStudies({
      search: request.query.search ? String(request.query.search).trim() : undefined,
      seg,
      importStatus,
      limit,
      offset,
    }));
  } catch (error) { sendError(response, error); }
});

router.get('/reference-studies/:id', requirePermission('segmentation:read'), async (request, response) => {
  try { response.json(await getReferenceStudy(request.params.id)); }
  catch (error) { sendError(response, error); }
});

router.post('/reference-studies/pull-batch', requirePermission('segmentation:write'), async (
  request: AuthenticatedRequest, response
) => {
  try {
    const ids = request.body?.referenceStudyIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      throw new ReferenceStorageError(400, 'referenceStudyIds must be an array of UUIDs');
    }
    const jobs = await enqueueReferenceImports(ids, request.user?.username || null);
    void processReferenceImportQueue().catch(error => console.error('Reference import queue failed:', error));
    response.status(202).json({ items: jobs });
  } catch (error) { sendError(response, error); }
});

router.post('/reference-studies/:id/pull', requirePermission('segmentation:write'), async (
  request: AuthenticatedRequest, response
) => {
  try {
    const job = await enqueueReferenceImport(request.params.id, request.user?.username || null);
    void processReferenceImportQueue().catch(error => console.error('Reference import queue failed:', error));
    response.status(202).json(job);
  } catch (error) { sendError(response, error); }
});

router.get('/reference-import-jobs/:id', requirePermission('segmentation:read'), async (request, response) => {
  try { response.json(await getReferenceImport(request.params.id)); }
  catch (error) { sendError(response, error); }
});

export default router;
