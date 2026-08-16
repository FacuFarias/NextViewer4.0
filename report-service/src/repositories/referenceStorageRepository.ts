import pool from '../db';
import { ReferenceImportJob, ReferenceStudy } from '../types/referenceStorage';

export class ReferenceStorageError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

const iso = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value || null;

function mapImport(row: any): ReferenceImportJob {
  return {
    id: row.id,
    referenceStudyId: row.reference_study_id,
    status: row.status,
    requestedBy: row.requested_by,
    totalInstances: Number(row.total_instances || 0),
    importedInstances: Number(row.imported_instances || 0),
    failedInstances: Number(row.failed_instances || 0),
    progress: Number(row.progress || 0),
    errorMessage: row.error_message,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    updatedAt: iso(row.updated_at)!,
  };
}

function mapStudy(row: any): ReferenceStudy {
  return {
    id: row.id,
    accessionNumber: row.accession_number,
    studyInstanceUID: row.study_instance_uid,
    representativeSeriesInstanceUID: row.representative_series_instance_uid,
    representativeSOPInstanceUID: row.representative_sop_instance_uid,
    modality: row.modality,
    studyDate: row.study_date,
    studyDescription: row.study_description,
    patientId: row.patient_id,
    patientName: row.patient_name,
    sourceBucket: row.source_bucket,
    sourcePrefix: row.source_prefix,
    objectCount: Number(row.object_count || 0),
    totalSizeBytes: Number(row.total_size_bytes || 0),
    scanStatus: row.scan_status,
    scanError: row.scan_error,
    lastScannedAt: iso(row.last_scanned_at),
    pacsVerifiedAt: iso(row.pacs_verified_at),
    pacsPresent: Boolean(row.pacs_present),
    hasSeg: Number(row.segmentation_count || 0) > 0,
    segmentationCount: Number(row.segmentation_count || 0),
    segmentationOrigins: row.segmentation_origins || [],
    segmentations: row.segmentations || [],
    measurements: row.measurements || [],
    latestImport: row.latest_import ? mapImport(row.latest_import) : null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

const enrichedSelect = `
  SELECT r.*,
    EXISTS(SELECT 1 FROM public.study pacs WHERE pacs.study_iuid=r.study_instance_uid) AS pacs_present,
    COALESCE(seg.segmentation_count, 0)::int AS segmentation_count,
    COALESCE(seg.segmentation_origins, '[]'::jsonb) AS segmentation_origins,
    COALESCE(seg.segmentations, '[]'::jsonb) AS segmentations,
    COALESCE(measurements.measurements, '[]'::jsonb) AS measurements,
    latest_import.latest_import
  FROM ia.reference_study r
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS segmentation_count,
      jsonb_agg(DISTINCT so.origin) AS segmentation_origins,
      jsonb_agg(jsonb_build_object(
        'id', so.id, 'origin', so.origin, 'name', so.name, 'status', so.status,
        'version', so.version, 'segmentSummary', so.segment_summary, 'createdAt', so.created_at
      ) ORDER BY so.created_at DESC) AS segmentations
    FROM ia.segmentation_object so
    WHERE so.study_instance_uid = r.study_instance_uid AND so.status = 'draft'
  ) seg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'labelCode', grouped.label_code, 'labelName', grouped.label_name,
      'toolName', grouped.tool_name, 'geometryType', grouped.geometry_type,
      'source', grouped.source, 'count', grouped.item_count
    ) ORDER BY grouped.item_count DESC, grouped.label_name) AS measurements
    FROM (
      SELECT a.label_code, a.label_name, a.tool_name, a.geometry_type, a.source, count(*)::int item_count
      FROM ia.annotation a
      WHERE a.study_instance_uid = r.study_instance_uid
        AND a.deleted_at IS NULL AND a.status <> 'archived'
      GROUP BY a.label_code, a.label_name, a.tool_name, a.geometry_type, a.source
    ) grouped
  ) measurements ON true
  LEFT JOIN LATERAL (
    SELECT to_jsonb(job) AS latest_import
    FROM ia.reference_import_job job
    WHERE job.reference_study_id = r.id
    ORDER BY job.created_at DESC LIMIT 1
  ) latest_import ON true`;

export async function listReferenceStudies(input: {
  search?: string;
  seg?: 'all' | 'with' | 'without';
  importStatus?: string;
  limit: number;
  offset: number;
}): Promise<{ items: ReferenceStudy[]; total: number }> {
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (input.search) {
    // Search is intentionally applied in PostgreSQL before LIMIT/OFFSET so the
    // UI never needs to load the full catalog and filter it in memory.
    values.push(`%${input.search}%`);
    conditions.push(`(r.accession_number ILIKE $${values.length} OR r.study_instance_uid ILIKE $${values.length}
      OR r.patient_id ILIKE $${values.length} OR r.study_description ILIKE $${values.length})`);
  }
  if (input.seg === 'with') conditions.push('COALESCE(seg.segmentation_count, 0) > 0');
  if (input.seg === 'without') conditions.push('COALESCE(seg.segmentation_count, 0) = 0');
  if (input.importStatus) {
    values.push(input.importStatus);
    conditions.push(`latest_import.latest_import->>'status' = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(input.limit, input.offset);
  const result = await pool.query(
    `WITH enriched AS (${enrichedSelect} ${where})
     SELECT enriched.*, count(*) OVER()::int AS full_count
     FROM enriched
     ORDER BY accession_number
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return { items: result.rows.map(mapStudy), total: Number(result.rows[0]?.full_count || 0) };
}

export async function getReferenceStudy(id: string): Promise<ReferenceStudy> {
  const result = await pool.query(`${enrichedSelect} WHERE r.id = $1`, [id]);
  if (!result.rows[0]) throw new ReferenceStorageError(404, 'Reference study not found');
  return mapStudy(result.rows[0]);
}

export async function getReferenceStudySourcePrefix(studyInstanceUID: string): Promise<string> {
  const result = await pool.query(
    `SELECT source_prefix FROM ia.reference_study
     WHERE study_instance_uid=$1 AND scan_status='ready' LIMIT 1`, [studyInstanceUID]
  );
  if (!result.rows[0]?.source_prefix) {
    throw new ReferenceStorageError(409, 'Study is not registered in reference storage');
  }
  return String(result.rows[0].source_prefix).replace(/\/+$/, '');
}

export async function ensureReferenceStudy(input: {
  accessionNumber: string; sourceBucket: string; sourcePrefix: string;
}): Promise<string> {
  const result = await pool.query(
    `INSERT INTO ia.reference_study (accession_number, source_bucket, source_prefix, scan_status)
     VALUES ($1,$2,$3,'scanning')
     ON CONFLICT (accession_number) DO UPDATE SET
       source_bucket = EXCLUDED.source_bucket, source_prefix = EXCLUDED.source_prefix,
       scan_status = 'scanning', scan_error = NULL
     RETURNING id`,
    [input.accessionNumber, input.sourceBucket, input.sourcePrefix]
  );
  return result.rows[0].id;
}

export async function completeReferenceStudyScan(id: string, input: {
  studyInstanceUID: string;
  representativeSeriesInstanceUID: string | null;
  representativeSOPInstanceUID: string | null;
  modality: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  patientId: string | null;
  patientName: string | null;
  representativeObjectKey: string;
  objectCount: number;
  totalSizeBytes: number;
  sourceLastModifiedAt: Date | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `UPDATE ia.reference_study SET
       study_instance_uid=$2, representative_series_instance_uid=$3,
       representative_sop_instance_uid=$4, modality=$5, study_date=$6,
       study_description=$7, patient_id=$8, patient_name=$9,
       representative_object_key=$10, object_count=$11, total_size_bytes=$12,
       source_last_modified_at=$13, metadata=$14::jsonb, scan_status='ready',
       scan_error=NULL, last_scanned_at=clock_timestamp()
     WHERE id=$1`,
    [id, input.studyInstanceUID, input.representativeSeriesInstanceUID,
     input.representativeSOPInstanceUID, input.modality, input.studyDate,
     input.studyDescription, input.patientId, input.patientName,
     input.representativeObjectKey, input.objectCount, input.totalSizeBytes,
     input.sourceLastModifiedAt, JSON.stringify(input.metadata)]
  );
}

export async function failReferenceStudyScan(id: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE ia.reference_study SET scan_status='error', scan_error=$2,
       last_scanned_at=clock_timestamp() WHERE id=$1`, [id, message.slice(0, 2000)]
  );
}

export async function enqueueReferenceImport(
  referenceStudyId: string, requestedBy: string | null
): Promise<ReferenceImportJob> {
  const study = await pool.query(
    `SELECT id FROM ia.reference_study WHERE id=$1 AND scan_status='ready' AND study_instance_uid IS NOT NULL`,
    [referenceStudyId]
  );
  if (!study.rows[0]) throw new ReferenceStorageError(409, 'Reference study is not ready for import');
  try {
    const result = await pool.query(
      `INSERT INTO ia.reference_import_job (reference_study_id, requested_by)
       VALUES ($1,$2) RETURNING *`, [referenceStudyId, requestedBy]
    );
    return mapImport(result.rows[0]);
  } catch (error: any) {
    if (error?.code !== '23505') throw error;
    const active = await pool.query(
      `SELECT * FROM ia.reference_import_job WHERE reference_study_id=$1
       AND status IN ('queued','importing') ORDER BY created_at DESC LIMIT 1`, [referenceStudyId]
    );
    return mapImport(active.rows[0]);
  }
}

export async function enqueueReferenceImports(
  referenceStudyIds: string[], requestedBy: string | null
): Promise<ReferenceImportJob[]> {
  const uniqueIds = [...new Set(referenceStudyIds)];
  if (!uniqueIds.length || uniqueIds.length > 20) {
    throw new ReferenceStorageError(400, 'A pull batch must contain between 1 and 20 studies');
  }
  const ready = await pool.query(
    `SELECT id FROM ia.reference_study
     WHERE id = ANY($1::uuid[]) AND scan_status='ready' AND study_instance_uid IS NOT NULL`,
    [uniqueIds]
  );
  if (ready.rows.length !== uniqueIds.length) {
    throw new ReferenceStorageError(409, 'One or more selected studies are not ready for import');
  }
  const jobs: ReferenceImportJob[] = [];
  for (const id of uniqueIds) jobs.push(await enqueueReferenceImport(id, requestedBy));
  return jobs;
}

export async function getReferenceImport(id: string): Promise<ReferenceImportJob> {
  const result = await pool.query('SELECT * FROM ia.reference_import_job WHERE id=$1', [id]);
  if (!result.rows[0]) throw new ReferenceStorageError(404, 'Reference import job not found');
  return mapImport(result.rows[0]);
}

export async function claimReferenceImport(): Promise<{ job: ReferenceImportJob; study: ReferenceStudy } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `SELECT * FROM ia.reference_import_job WHERE status='queued'
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    if (!claimed.rows[0]) { await client.query('COMMIT'); return null; }
    const updated = await client.query(
      `UPDATE ia.reference_import_job SET status='importing', started_at=clock_timestamp(), error_message=NULL
       WHERE id=$1 RETURNING *`, [claimed.rows[0].id]
    );
    await client.query('COMMIT');
    return { job: mapImport(updated.rows[0]), study: await getReferenceStudy(updated.rows[0].reference_study_id) };
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

export async function updateReferenceImport(id: string, input: {
  status?: 'importing' | 'completed' | 'failed';
  totalInstances?: number;
  importedInstances?: number;
  failedInstances?: number;
  progress?: number;
  errorMessage?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE ia.reference_import_job SET
       status=COALESCE($2,status), total_instances=COALESCE($3,total_instances),
       imported_instances=COALESCE($4,imported_instances), failed_instances=COALESCE($5,failed_instances),
       progress=COALESCE($6,progress), error_message=$7,
       completed_at=CASE WHEN $2 IN ('completed','failed') THEN clock_timestamp() ELSE completed_at END
     WHERE id=$1`,
    [id, input.status ?? null, input.totalInstances ?? null, input.importedInstances ?? null,
     input.failedInstances ?? null, input.progress ?? null, input.errorMessage ?? null]
  );
}

export async function markReferenceStudyPacsVerified(id: string): Promise<void> {
  await pool.query('UPDATE ia.reference_study SET pacs_verified_at=clock_timestamp() WHERE id=$1', [id]);
}
