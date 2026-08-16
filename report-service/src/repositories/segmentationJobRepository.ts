import { createHash, randomBytes } from 'crypto';
import pool from '../db';
import {
  CompleteSegmentationJobInput,
  SegmentationInputManifest,
  SegmentationJobRecord,
  SegmentationJobStatus,
  StudySegmentationStatusRecord,
} from '../types/segmentationJobs';

export class SegmentationJobRepositoryError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

const iso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value.toISOString() : value) : null;

function mapJob(row: any): SegmentationJobRecord {
  return {
    id: row.id,
    studyInstanceUID: row.study_instance_uid,
    sourceSeriesInstanceUID: row.source_series_instance_uid,
    modelName: row.model_name,
    modelVersion: row.model_version,
    inputManifest: row.input_manifest,
    status: row.status,
    priority: row.priority,
    progress: Number(row.progress),
    stage: row.stage,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    requestedBy: row.requested_by,
    outputBucket: row.output_bucket,
    outputKey: row.output_key,
    segmentationObjectId: row.segmentation_object_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    completedAt: iso(row.completed_at),
  };
}

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function deriveStudySegmentationState(
  hasSeg: boolean, jobStatus: SegmentationJobStatus | null
): StudySegmentationStatusRecord['state'] {
  if (hasSeg) return 'with_seg';
  if (jobStatus === 'queued') return 'queued';
  if (jobStatus && ['leased', 'processing', 'uploading', 'publishing'].includes(jobStatus)) return 'processing';
  if (jobStatus === 'failed') return 'failed';
  return 'without_seg';
}

export async function enqueueSegmentationJob(input: {
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  modelName: string;
  modelVersion: string;
  inputManifest: SegmentationInputManifest;
  idempotencyKey?: string;
  priority?: number;
  maxAttempts?: number;
}, requestedBy: string | null): Promise<SegmentationJobRecord> {
  try {
    const result = await pool.query(
      `INSERT INTO ia.segmentation_job (
         study_instance_uid, source_series_instance_uid, model_name, model_version,
         input_manifest, idempotency_key, priority, max_attempts, requested_by
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING *`,
      [input.studyInstanceUID, input.sourceSeriesInstanceUID, input.modelName,
       input.modelVersion, JSON.stringify(input.inputManifest), input.idempotencyKey || null,
       input.priority || 0, input.maxAttempts || 3, requestedBy]
    );
    return mapJob(result.rows[0]);
  } catch (error: any) {
    if (error?.code === '23505' && input.idempotencyKey) {
      const existing = await pool.query(
        'SELECT * FROM ia.segmentation_job WHERE idempotency_key = $1',
        [input.idempotencyKey]
      );
      if (existing.rows[0]) return mapJob(existing.rows[0]);
    }
    if (error?.code === '23505') {
      throw new SegmentationJobRepositoryError(409, 'An active job already exists for this study, series and model');
    }
    throw error;
  }
}

export async function getSegmentationJob(id: string): Promise<SegmentationJobRecord & { attempts: any[] }> {
  const [job, attempts] = await Promise.all([
    pool.query('SELECT * FROM ia.segmentation_job WHERE id = $1', [id]),
    pool.query(
      `SELECT id, attempt_number AS "attemptNumber", worker_id AS "workerId", status,
              stage, progress, lease_expires_at AS "leaseExpiresAt", error_code AS "errorCode",
              error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt"
       FROM ia.segmentation_job_attempt WHERE job_id = $1 ORDER BY attempt_number`, [id]
    ),
  ]);
  if (!job.rows[0]) throw new SegmentationJobRepositoryError(404, 'Segmentation job not found');
  return { ...mapJob(job.rows[0]), attempts: attempts.rows };
}

export async function getSegmentationJobForLease(
  id: string, leaseToken: string
): Promise<SegmentationJobRecord> {
  const result = await pool.query(
    `SELECT j.* FROM ia.segmentation_job j
     JOIN ia.segmentation_job_attempt a ON a.job_id = j.id AND a.attempt_number = j.attempt_count
     WHERE j.id = $1 AND a.lease_token_hash = $2
       AND ((a.status IN ('leased', 'processing', 'uploading') AND a.lease_expires_at >= clock_timestamp())
            OR (a.status = 'completed' AND j.status = 'publishing'))`, [id, tokenHash(leaseToken)]
  );
  if (!result.rows[0]) throw new SegmentationJobRepositoryError(409, 'Lease is invalid or expired');
  return mapJob(result.rows[0]);
}

export async function getSegmentationJobPublication(id: string): Promise<{
  job: SegmentationJobRecord;
  output: CompleteSegmentationJobInput;
  versionId: string | null;
}> {
  const result = await pool.query(
    `SELECT * FROM ia.segmentation_job WHERE id = $1 AND status = 'publishing'`, [id]
  );
  if (!result.rows[0] || !result.rows[0].output_metadata) {
    throw new SegmentationJobRepositoryError(409, 'Job has no output ready for publication');
  }
  return {
    job: mapJob(result.rows[0]),
    output: result.rows[0].output_metadata,
    versionId: result.rows[0].output_version_id,
  };
}

export async function listStudySegmentationStatuses(
  studyInstanceUIDs: string[]
): Promise<StudySegmentationStatusRecord[]> {
  if (!studyInstanceUIDs.length) return [];
  const result = await pool.query(
    `WITH requested(study_uid) AS (SELECT unnest($1::text[])),
     object_summary AS (
       SELECT study_instance_uid, count(*) FILTER (WHERE status <> 'archived')::int AS seg_count,
              (array_agg(id ORDER BY created_at DESC) FILTER (WHERE status <> 'archived'))[1] AS latest_object_id,
              max(updated_at) FILTER (WHERE status <> 'archived') AS object_updated_at
       FROM ia.segmentation_object WHERE study_instance_uid = ANY($1::text[])
       GROUP BY study_instance_uid
     ), latest_job AS (
       SELECT DISTINCT ON (study_instance_uid) study_instance_uid, id, status, progress, stage,
              updated_at, last_error_message
       FROM ia.segmentation_job WHERE study_instance_uid = ANY($1::text[])
       ORDER BY study_instance_uid, updated_at DESC, created_at DESC
     )
     SELECT r.study_uid, COALESCE(o.seg_count, 0) AS seg_count, o.latest_object_id,
            j.id AS job_id, j.status AS job_status, j.progress, j.stage, j.last_error_message,
            GREATEST(o.object_updated_at, j.updated_at) AS updated_at
     FROM requested r
     LEFT JOIN object_summary o ON o.study_instance_uid = r.study_uid
     LEFT JOIN latest_job j ON j.study_instance_uid = r.study_uid`,
    [studyInstanceUIDs]
  );
  return result.rows.map(row => {
    const hasSeg = Number(row.seg_count) > 0;
    const active = ['queued', 'leased', 'processing', 'uploading', 'publishing'].includes(row.job_status);
    const state = deriveStudySegmentationState(hasSeg, row.job_status || null);
    return {
      studyInstanceUID: row.study_uid,
      hasSeg,
      segmentationCount: Number(row.seg_count),
      state,
      activeJobId: active ? row.job_id : null,
      latestSegmentationObjectId: row.latest_object_id || null,
      updatedAt: iso(row.updated_at),
      ...(row.last_error_message ? { lastError: row.last_error_message } : {}),
      ...(row.job_id ? { progress: Number(row.progress || 0), stage: row.stage || undefined } : {}),
    };
  });
}

export async function getSegmentationQueueMetrics(): Promise<Record<string, number | null>> {
  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'queued')::int AS queued,
       count(*) FILTER (WHERE status IN ('leased','processing','uploading'))::int AS processing,
       count(*) FILTER (WHERE status = 'publishing')::int AS publishing,
       count(*) FILTER (WHERE status = 'failed')::int AS failed,
       count(*) FILTER (WHERE status = 'completed')::int AS completed,
       EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at) FILTER (WHERE status = 'queued'))) AS oldest_queued_seconds,
       count(*) FILTER (WHERE status IN ('leased','processing','uploading') AND EXISTS (
         SELECT 1 FROM ia.segmentation_job_attempt a WHERE a.job_id = ia.segmentation_job.id
           AND a.attempt_number = ia.segmentation_job.attempt_count
           AND a.lease_expires_at < clock_timestamp()
       ))::int AS expired_leases
     FROM ia.segmentation_job`
  );
  const row = result.rows[0];
  return {
    queued: Number(row.queued), processing: Number(row.processing), publishing: Number(row.publishing),
    failed: Number(row.failed), completed: Number(row.completed),
    oldestQueuedSeconds: row.oldest_queued_seconds === null ? null : Number(row.oldest_queued_seconds),
    expiredLeases: Number(row.expired_leases),
  };
}

async function expireLeases(client: any): Promise<void> {
  const expired = await client.query(
    `UPDATE ia.segmentation_job_attempt SET status = 'expired', finished_at = clock_timestamp()
     WHERE status IN ('leased', 'processing', 'uploading') AND lease_expires_at < clock_timestamp()
     RETURNING job_id`
  );
  if (!expired.rowCount) return;
  const ids = expired.rows.map((row: any) => row.job_id);
  await client.query(
    `UPDATE ia.segmentation_job
     SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
         stage = NULL,
         last_error_code = 'LEASE_EXPIRED',
         last_error_message = 'Worker lease expired'
     WHERE id = ANY($1::uuid[]) AND status IN ('leased', 'processing', 'uploading')`, [ids]
  );
}

export async function requeueExpiredSegmentationLeases(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireLeases(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function claimSegmentationJobs(
  workerId: string,
  limit: number,
  leaseMinutes: number,
  modelName?: string,
  modelVersion?: string
): Promise<Array<{ job: SegmentationJobRecord; leaseToken: string; leaseExpiresAt: string }>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireLeases(client);
    const filters = [`status = 'queued'`, 'attempt_count < max_attempts'];
    const values: unknown[] = [];
    if (modelName) { values.push(modelName); filters.push(`model_name = $${values.length}`); }
    if (modelVersion) { values.push(modelVersion); filters.push(`model_version = $${values.length}`); }
    values.push(limit);
    const jobs = await client.query(
      `SELECT * FROM ia.segmentation_job WHERE ${filters.join(' AND ')}
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT $${values.length}`,
      values
    );
    const claimed = [];
    for (const row of jobs.rows) {
      const leaseToken = randomBytes(32).toString('base64url');
      const attemptNumber = row.attempt_count + 1;
      const attempt = await client.query(
        `INSERT INTO ia.segmentation_job_attempt (
           job_id, attempt_number, worker_id, lease_token_hash, lease_expires_at
         ) VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 * interval '1 minute'))
         RETURNING lease_expires_at`,
        [row.id, attemptNumber, workerId, tokenHash(leaseToken), leaseMinutes]
      );
      const updated = await client.query(
        `UPDATE ia.segmentation_job SET status = 'leased', stage = 'claimed', attempt_count = $2,
                progress = 0, last_error_code = NULL, last_error_message = NULL
         WHERE id = $1 RETURNING *`, [row.id, attemptNumber]
      );
      claimed.push({
        job: mapJob(updated.rows[0]), leaseToken,
        leaseExpiresAt: iso(attempt.rows[0].lease_expires_at)!,
      });
    }
    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function lockValidAttempt(client: any, jobId: string, leaseToken: string): Promise<any> {
  const result = await client.query(
    `SELECT a.* FROM ia.segmentation_job_attempt a
     JOIN ia.segmentation_job j ON j.id = a.job_id
     WHERE a.job_id = $1 AND a.attempt_number = j.attempt_count
       AND a.lease_token_hash = $2 AND a.status IN ('leased', 'processing', 'uploading')
       AND a.lease_expires_at >= clock_timestamp() FOR UPDATE OF a`,
    [jobId, tokenHash(leaseToken)]
  );
  if (!result.rows[0]) throw new SegmentationJobRepositoryError(409, 'Lease is invalid or expired');
  return result.rows[0];
}

export async function heartbeatSegmentationJob(
  jobId: string, leaseToken: string, stage: string, progress: number, leaseMinutes: number
): Promise<SegmentationJobRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const attempt = await lockValidAttempt(client, jobId, leaseToken);
    const status: SegmentationJobStatus = stage === 'uploading' ? 'uploading' : 'processing';
    await client.query(
      `UPDATE ia.segmentation_job_attempt SET status = $2, stage = $3, progress = $4,
              lease_expires_at = clock_timestamp() + ($5 * interval '1 minute') WHERE id = $1`,
      [attempt.id, status, stage, progress, leaseMinutes]
    );
    const job = await client.query(
      'UPDATE ia.segmentation_job SET status = $2, stage = $3, progress = $4 WHERE id = $1 RETURNING *',
      [jobId, status, stage, progress]
    );
    await client.query('COMMIT');
    return mapJob(job.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function beginPublishing(
  jobId: string, leaseToken: string, output: CompleteSegmentationJobInput
): Promise<SegmentationJobRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM ia.segmentation_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (!existing.rows[0]) throw new SegmentationJobRepositoryError(404, 'Segmentation job not found');
    if (existing.rows[0].status === 'completed' || existing.rows[0].status === 'publishing') {
      await client.query('COMMIT');
      return mapJob(existing.rows[0]);
    }
    const attempt = await lockValidAttempt(client, jobId, leaseToken);
    await client.query(
      `UPDATE ia.segmentation_job_attempt SET status = 'completed', stage = 'uploaded', progress = 100,
              finished_at = clock_timestamp() WHERE id = $1`, [attempt.id]
    );
    const result = await client.query(
      `UPDATE ia.segmentation_job SET status = 'publishing', stage = 'publishing', progress = 100,
          output_bucket = $2, output_key = $3, output_version_id = $4, output_etag = $5,
          output_checksum_sha256 = $6, output_size_bytes = $7, output_metadata = $8::jsonb
       WHERE id = $1 RETURNING *`,
      [jobId, output.bucket, output.key, output.versionId || null, output.etag || null,
       output.checksumSha256, output.sizeBytes, JSON.stringify(output)]
    );
    await client.query('COMMIT');
    return mapJob(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function finalizeSegmentationJob(jobId: string): Promise<SegmentationJobRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM ia.segmentation_job WHERE id = $1 FOR UPDATE', [jobId]);
    const job = locked.rows[0];
    if (!job) throw new SegmentationJobRepositoryError(404, 'Segmentation job not found');
    if (job.status === 'completed') { await client.query('COMMIT'); return mapJob(job); }
    if (job.status !== 'publishing') throw new SegmentationJobRepositoryError(409, 'Job is not ready for publication');
    const output = job.output_metadata as CompleteSegmentationJobInput;
    const previous = await client.query(
      `SELECT * FROM ia.segmentation_object
       WHERE study_instance_uid = $1 AND source_series_instance_uid = $2
         AND status NOT IN ('archived', 'superseded')
       ORDER BY version DESC, created_at DESC LIMIT 1 FOR UPDATE`,
      [job.study_instance_uid, job.source_series_instance_uid]
    );
    const modelRun = await client.query(
      `INSERT INTO ia.model_run (model_name, model_version, weights_hash, parameters, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
      [job.model_name, job.model_version, output.weightsHash || null,
       JSON.stringify(output.parameters || {}), job.requested_by]
    );
    const version = previous.rows[0] ? previous.rows[0].version + 1 : 1;
    const object = await client.query(
      `INSERT INTO ia.segmentation_object (
         study_instance_uid, source_series_instance_uid, segmentation_series_instance_uid,
         segmentation_sop_instance_uid, name, description, ontology_version, dimensions, spacing,
         frame_of_reference_uid, version, supersedes_object_id, created_by, status, origin,
         model_run_id, job_id, s3_bucket, s3_key, s3_version_id, s3_etag,
         checksum_sha256, size_bytes, pacs_published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,'draft','AI',
                 $14,$15,$16,$17,$18,$19,$20,$21,clock_timestamp()) RETURNING id`,
      [job.study_instance_uid, job.source_series_instance_uid,
       output.segmentationSeriesInstanceUID, output.segmentationSOPInstanceUID,
       output.name, output.description || null, output.ontologyVersion,
       JSON.stringify(output.dimensions), JSON.stringify(output.spacing), output.frameOfReferenceUID || null,
       version, previous.rows[0]?.id || null, job.requested_by, modelRun.rows[0].id, job.id,
       job.output_bucket, job.output_key, job.output_version_id, job.output_etag,
       job.output_checksum_sha256, job.output_size_bytes]
    );
    if (previous.rows[0]) {
      await client.query("UPDATE ia.segmentation_object SET status = 'superseded' WHERE id = $1", [previous.rows[0].id]);
    }
    const completed = await client.query(
      `UPDATE ia.segmentation_job SET status = 'completed', stage = 'completed',
              segmentation_object_id = $2, completed_at = clock_timestamp()
       WHERE id = $1 RETURNING *`, [jobId, object.rows[0].id]
    );
    await client.query('COMMIT');
    return mapJob(completed.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function failSegmentationJob(
  jobId: string, leaseToken: string | null, code: string, message: string, retryable: boolean
): Promise<SegmentationJobRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM ia.segmentation_job WHERE id = $1 FOR UPDATE', [jobId]);
    if (!current.rows[0]) throw new SegmentationJobRepositoryError(404, 'Segmentation job not found');
    if (['completed', 'cancelled'].includes(current.rows[0].status)) {
      await client.query('COMMIT'); return mapJob(current.rows[0]);
    }
    if (leaseToken) {
      const attempt = await lockValidAttempt(client, jobId, leaseToken);
      await client.query(
        `UPDATE ia.segmentation_job_attempt SET status = 'failed', error_code = $2,
                error_message = $3, finished_at = clock_timestamp() WHERE id = $1`,
        [attempt.id, code, message]
      );
    }
    const shouldRetry = retryable && current.rows[0].attempt_count < current.rows[0].max_attempts;
    const result = await client.query(
      `UPDATE ia.segmentation_job SET status = $2, stage = NULL,
              last_error_code = $3, last_error_message = $4 WHERE id = $1 RETURNING *`,
      [jobId, shouldRetry ? 'queued' : 'failed', code, message]
    );
    await client.query('COMMIT'); return mapJob(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function retrySegmentationJob(id: string): Promise<SegmentationJobRecord> {
  try {
    const result = await pool.query(
      `UPDATE ia.segmentation_job SET
              status = CASE WHEN last_error_code = 'PUBLISH_FAILED' AND output_metadata IS NOT NULL
                            THEN 'publishing' ELSE 'queued' END,
              stage = CASE WHEN last_error_code = 'PUBLISH_FAILED' AND output_metadata IS NOT NULL
                           THEN 'publishing' ELSE NULL END,
              progress = CASE WHEN last_error_code = 'PUBLISH_FAILED' AND output_metadata IS NOT NULL
                              THEN 100 ELSE 0 END,
              max_attempts = GREATEST(max_attempts, attempt_count + 3),
              last_error_code = NULL, last_error_message = NULL,
              completed_at = NULL, cancelled_at = NULL
       WHERE id = $1 AND status = 'failed' RETURNING *`, [id]
    );
    if (!result.rows[0]) throw new SegmentationJobRepositoryError(409, 'Only failed jobs can be retried');
    return mapJob(result.rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') {
      throw new SegmentationJobRepositoryError(409, 'Another active job already exists for this study, series and model');
    }
    throw error;
  }
}

export async function cancelSegmentationJob(id: string): Promise<SegmentationJobRecord> {
  const result = await pool.query(
    `UPDATE ia.segmentation_job SET status = 'cancelled', stage = NULL, cancelled_at = clock_timestamp()
     WHERE id = $1 AND status IN ('queued', 'leased') RETURNING *`, [id]
  );
  if (!result.rows[0]) throw new SegmentationJobRepositoryError(409, 'This job can no longer be cancelled');
  await pool.query(
    `UPDATE ia.segmentation_job_attempt SET status = 'cancelled', finished_at = clock_timestamp()
     WHERE job_id = $1 AND status = 'leased'`, [id]
  );
  return mapJob(result.rows[0]);
}
