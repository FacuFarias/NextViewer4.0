import { PoolClient } from 'pg';
import pool from '../db';
import {
  AnnotationFilters,
  AnnotationRecord,
  AnnotationSetRecord,
  CreateAnnotationInput,
  CreateAnnotationSetInput,
  UpdateAnnotationInput,
  UpdateAnnotationSetInput,
} from '../types/annotations';

export class AnnotationRepositoryError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function jsonValue(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function mapAnnotation(row: any): AnnotationRecord {
  return {
    id: row.id,
    annotationSetId: row.annotation_set_id,
    studyInstanceUID: row.study_instance_uid,
    seriesInstanceUID: row.series_instance_uid,
    sopInstanceUID: row.sop_instance_uid,
    frameNumber: row.frame_number,
    instanceNumber: row.instance_number,
    labelCode: row.label_code,
    labelName: row.label_name,
    toolName: row.tool_name,
    color: row.color,
    geometryType: row.geometry_type,
    geometry: row.geometry,
    source: row.source,
    status: row.status,
    modelRunId: row.model_run_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    version: row.version,
    supersedesAnnotationId: row.supersedes_annotation_id,
    createdBy: row.created_by,
    reviewedBy: row.reviewed_by,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    deletedAt: iso(row.deleted_at),
    cornerstoneAnnotationUID: row.cornerstone_annotation_uid,
    imageMetadata: {
      modality: row.modality || undefined,
      rows: row.rows ?? undefined,
      columns: row.columns ?? undefined,
      pixelSpacing: row.pixel_spacing || undefined,
      imagePositionPatient: row.image_position_patient || undefined,
      imageOrientationPatient: row.image_orientation_patient || undefined,
      frameOfReferenceUID: row.frame_of_reference_uid || undefined,
      seriesNumber: row.series_number ?? undefined,
    },
  };
}

function mapSet(row: any): AnnotationSetRecord {
  return {
    id: row.id,
    studyInstanceUID: row.study_instance_uid,
    name: row.name,
    description: row.description,
    ontologyVersion: row.ontology_version,
    status: row.status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

const annotationColumns = `
  a.id, a.annotation_set_id, a.study_instance_uid, a.series_instance_uid,
  a.sop_instance_uid, a.frame_number, a.instance_number, a.label_code,
  a.label_name, a.tool_name, a.color, a.geometry_type, a.geometry, a.source,
  a.status, a.model_run_id, a.confidence, a.version, a.supersedes_annotation_id,
  a.created_by, a.reviewed_by, a.cornerstone_annotation_uid, a.modality,
  a.rows, a.columns, a.pixel_spacing, a.image_position_patient,
  a.image_orientation_patient, a.frame_of_reference_uid, a.series_number,
  a.created_at, a.updated_at, a.deleted_at
`;

async function getSetById(client: PoolClient, id: string): Promise<any> {
  const result = await client.query('SELECT * FROM ia.annotation_set WHERE id = $1', [id]);
  if (!result.rows[0]) throw new AnnotationRepositoryError(404, 'Annotation set not found');
  return result.rows[0];
}

async function insertAnnotation(
  client: PoolClient,
  input: CreateAnnotationInput,
  username: string | null
): Promise<AnnotationRecord> {
  const set = await getSetById(client, input.annotationSetId);
  if (set.study_instance_uid !== input.studyInstanceUID) {
    throw new AnnotationRepositoryError(400, 'Annotation set and studyInstanceUID do not match');
  }

  if (input.clientMutationId) {
    const existing = await client.query(
      `SELECT ${annotationColumns} FROM ia.annotation a
       WHERE a.annotation_set_id = $1 AND a.client_mutation_id = $2`,
      [input.annotationSetId, input.clientMutationId]
    );
    if (existing.rows[0]) return mapAnnotation(existing.rows[0]);
  }

  const result = await client.query(
    `INSERT INTO ia.annotation (
       annotation_set_id, study_instance_uid, series_instance_uid, sop_instance_uid,
       frame_number, instance_number, label_code, label_name, tool_name, color,
       geometry_type, geometry, source, status, model_run_id, confidence, created_by,
       cornerstone_annotation_uid, modality, rows, columns, pixel_spacing,
       image_position_patient, image_orientation_patient, frame_of_reference_uid,
       series_number, client_mutation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
     RETURNING ${annotationColumns.replace(/a\./g, '')}`,
    [
      input.annotationSetId,
      input.studyInstanceUID,
      input.seriesInstanceUID,
      input.sopInstanceUID,
      input.frameNumber ?? null,
      input.instanceNumber ?? null,
      input.labelCode,
      input.labelName,
      input.toolName,
      input.color ?? null,
      input.geometryType,
      input.geometry,
      input.source || 'HUMAN',
      input.status || 'draft',
      input.modelRunId ?? null,
      input.confidence ?? null,
      username,
      input.cornerstoneAnnotationUID ?? null,
      input.imageMetadata?.modality ?? null,
      input.imageMetadata?.rows ?? null,
      input.imageMetadata?.columns ?? null,
      jsonValue(input.imageMetadata?.pixelSpacing),
      jsonValue(input.imageMetadata?.imagePositionPatient),
      jsonValue(input.imageMetadata?.imageOrientationPatient),
      input.imageMetadata?.frameOfReferenceUID ?? null,
      input.imageMetadata?.seriesNumber ?? null,
      input.clientMutationId ?? null,
    ]
  );

  return mapAnnotation({ ...result.rows[0], annotation_set_id: input.annotationSetId });
}

export async function createAnnotationSet(
  input: CreateAnnotationSetInput,
  username: string | null
): Promise<AnnotationSetRecord> {
  const client = await pool.connect();
  try {
    const result = input.isDefault
      ? await client.query(
          `INSERT INTO ia.annotation_set
             (study_instance_uid, name, description, ontology_version, status, is_default, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [input.studyInstanceUID, input.name, input.description ?? null, input.ontologyVersion, input.status || 'draft', username]
        )
      : await client.query(
          `INSERT INTO ia.annotation_set
             (study_instance_uid, name, description, ontology_version, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [input.studyInstanceUID, input.name, input.description ?? null, input.ontologyVersion, input.status || 'draft', username]
        );

    if (result.rows[0]) return mapSet(result.rows[0]);
    const existing = await client.query(
      `SELECT * FROM ia.annotation_set
       WHERE study_instance_uid = $1 AND is_default = true
       ORDER BY updated_at DESC LIMIT 1`,
      [input.studyInstanceUID]
    );
    if (!existing.rows[0]) throw new AnnotationRepositoryError(409, 'Unable to create default annotation set');
    return mapSet(existing.rows[0]);
  } finally {
    client.release();
  }
}

export async function getAnnotationSet(id: string): Promise<AnnotationSetRecord> {
  const result = await pool.query('SELECT * FROM ia.annotation_set WHERE id = $1', [id]);
  if (!result.rows[0]) throw new AnnotationRepositoryError(404, 'Annotation set not found');
  return mapSet(result.rows[0]);
}

export async function listAnnotationSets(studyInstanceUID: string): Promise<AnnotationSetRecord[]> {
  const result = await pool.query(
    `SELECT * FROM ia.annotation_set
     WHERE study_instance_uid = $1
     ORDER BY is_default DESC, updated_at DESC`,
    [studyInstanceUID]
  );
  return result.rows.map(mapSet);
}

export async function updateAnnotationSet(id: string, input: UpdateAnnotationSetInput): Promise<AnnotationSetRecord> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) { values.push(input.name); fields.push(`name = $${values.length}`); }
  if (input.description !== undefined) { values.push(input.description); fields.push(`description = $${values.length}`); }
  if (input.status !== undefined) { values.push(input.status); fields.push(`status = $${values.length}`); }
  if (!fields.length) return getAnnotationSet(id);
  values.push(id);
  const result = await pool.query(
    `UPDATE ia.annotation_set SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!result.rows[0]) throw new AnnotationRepositoryError(404, 'Annotation set not found');
  return mapSet(result.rows[0]);
}

export async function createAnnotation(input: CreateAnnotationInput, username: string | null): Promise<AnnotationRecord> {
  const client = await pool.connect();
  try {
    return await insertAnnotation(client, input, username);
  } catch (error: any) {
    if (error.code === '23505') throw new AnnotationRepositoryError(409, 'Duplicate annotation mutation');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAnnotation(id: string): Promise<AnnotationRecord> {
  const result = await pool.query(`SELECT ${annotationColumns} FROM ia.annotation a WHERE a.id = $1`, [id]);
  if (!result.rows[0]) throw new AnnotationRepositoryError(404, 'Annotation not found');
  return mapAnnotation(result.rows[0]);
}

export async function listAnnotations(filters: AnnotationFilters): Promise<{ items: AnnotationRecord[]; total: number }> {
  const conditions = ['a.deleted_at IS NULL'];
  const values: unknown[] = [];
  const add = (condition: string, value: unknown) => {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  };

  if (filters.studyInstanceUID) add('a.study_instance_uid = ?', filters.studyInstanceUID);
  if (filters.seriesInstanceUID) add('a.series_instance_uid = ?', filters.seriesInstanceUID);
  if (filters.sopInstanceUID) add('a.sop_instance_uid = ?', filters.sopInstanceUID);
  if (filters.frameNumber !== undefined) add('a.frame_number = ?', filters.frameNumber);
  if (filters.annotationSetId) add('a.annotation_set_id = ?', filters.annotationSetId);
  if (filters.labelCode) add('a.label_code = ?', filters.labelCode);
  if (filters.source) add('a.source = ?', filters.source);
  if (filters.status) add('a.status = ?', filters.status);
  if (filters.latestOnly) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM ia.annotation newer
      WHERE newer.supersedes_annotation_id = a.id
    )`);
  }

  const where = conditions.join(' AND ');
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM ia.annotation a WHERE ${where}`, values);
  const total = countResult.rows[0]?.total || 0;
  const limitPosition = values.length + 1;
  const offsetPosition = values.length + 2;
  const result = await pool.query(
    `SELECT ${annotationColumns} FROM ia.annotation a
     WHERE ${where}
     ORDER BY a.created_at ASC, a.version ASC
     LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
    [...values, filters.limit, filters.offset]
  );
  return { items: result.rows.map(mapAnnotation), total };
}

export async function updateAnnotation(id: string, input: UpdateAnnotationInput, username: string | null): Promise<AnnotationRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query('SELECT * FROM ia.annotation WHERE id = $1 FOR UPDATE', [id]);
    const current = currentResult.rows[0];
    if (!current) throw new AnnotationRepositoryError(404, 'Annotation not found');
    if (current.version !== input.expectedVersion) {
      throw new AnnotationRepositoryError(409, 'Annotation version conflict');
    }

    const nextSource = current.source === 'AI' ? 'AI_CORRECTED' : current.source;
    const mustVersion = current.status !== 'draft' || current.source === 'AI';
    let result;

    if (mustVersion) {
      result = await client.query(
        `INSERT INTO ia.annotation (
           annotation_set_id, study_instance_uid, series_instance_uid, sop_instance_uid,
           frame_number, instance_number, label_code, label_name, tool_name, color,
           geometry_type, geometry, source, status, model_run_id, confidence, version,
           supersedes_annotation_id, created_by, cornerstone_annotation_uid, modality,
           rows, columns, pixel_spacing, image_position_patient, image_orientation_patient,
           frame_of_reference_uid, series_number
         ) SELECT annotation_set_id, study_instance_uid, series_instance_uid, sop_instance_uid,
           frame_number, instance_number, $2, $3, $4, $5, $6, $7, $8, $9, model_run_id,
           $10, version + 1, id, $11, $12, modality, rows, columns, pixel_spacing,
           image_position_patient, image_orientation_patient, frame_of_reference_uid, series_number
         FROM ia.annotation WHERE id = $1
         RETURNING ${annotationColumns.replace(/a\./g, '')}`,
        [
          id,
          input.labelCode ?? current.label_code,
          input.labelName ?? current.label_name,
          input.toolName ?? current.tool_name,
          input.color === undefined ? current.color : input.color,
          input.geometryType ?? current.geometry_type,
          input.geometry ?? current.geometry,
          nextSource,
          input.status ?? 'draft',
          input.confidence === undefined ? current.confidence : input.confidence,
          username,
          input.cornerstoneAnnotationUID ?? current.cornerstone_annotation_uid,
        ]
      );
    } else {
      result = await client.query(
        `UPDATE ia.annotation SET
           label_code = $2, label_name = $3, tool_name = $4, color = $5,
           geometry_type = $6, geometry = $7, status = $8, confidence = $9,
           cornerstone_annotation_uid = $10
         WHERE id = $1 AND version = $11
         RETURNING ${annotationColumns.replace(/a\./g, '')}`,
        [
          id,
          input.labelCode ?? current.label_code,
          input.labelName ?? current.label_name,
          input.toolName ?? current.tool_name,
          input.color === undefined ? current.color : input.color,
          input.geometryType ?? current.geometry_type,
          input.geometry ?? current.geometry,
          input.status ?? current.status,
          input.confidence === undefined ? current.confidence : input.confidence,
          input.cornerstoneAnnotationUID ?? current.cornerstone_annotation_uid,
          input.expectedVersion,
        ]
      );
    }

    if (!result.rows[0]) throw new AnnotationRepositoryError(409, 'Annotation version conflict');
    await client.query('COMMIT');
    return mapAnnotation(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAnnotation(id: string, expectedVersion?: number): Promise<AnnotationRecord> {
  const values: unknown[] = [id];
  const versionCondition = expectedVersion === undefined ? '' : ` AND version = $2`;
  if (expectedVersion !== undefined) values.push(expectedVersion);
  const result = await pool.query(
    `UPDATE ia.annotation SET deleted_at = clock_timestamp(), status = 'archived'
     WHERE id = $1${versionCondition} AND deleted_at IS NULL
     RETURNING ${annotationColumns.replace(/a\./g, '')}`,
    values
  );
  if (!result.rows[0]) {
    if (expectedVersion !== undefined) throw new AnnotationRepositoryError(409, 'Annotation version conflict');
    throw new AnnotationRepositoryError(404, 'Annotation not found');
  }
  return mapAnnotation(result.rows[0]);
}

export async function getAnnotationHistory(id: string): Promise<AnnotationRecord[]> {
  const result = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT a.*, 0 AS depth FROM ia.annotation a WHERE a.id = $1
       UNION ALL
       SELECT previous.*, ancestors.depth + 1
       FROM ia.annotation previous
       JOIN ancestors ON ancestors.supersedes_annotation_id = previous.id
     ), descendants AS (
       SELECT a.*, 0 AS depth FROM ia.annotation a WHERE a.id = $1
       UNION ALL
       SELECT next_version.*, descendants.depth + 1
       FROM ia.annotation next_version
       JOIN descendants ON next_version.supersedes_annotation_id = descendants.id
     )
     SELECT ${annotationColumns} FROM (
       SELECT * FROM ancestors
       UNION
       SELECT * FROM descendants
     ) a ORDER BY a.version ASC, a.created_at ASC`,
    [id]
  );
  if (!result.rows.length) throw new AnnotationRepositoryError(404, 'Annotation not found');
  return result.rows.map(mapAnnotation);
}

export async function createAnnotationsBulk(
  inputs: CreateAnnotationInput[],
  clientMutationId: string,
  username: string | null
): Promise<AnnotationRecord[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientMutationId]);
    const existing = await client.query(
      'SELECT response FROM ia.annotation_bulk_mutation WHERE client_mutation_id = $1',
      [clientMutationId]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return existing.rows[0].response as AnnotationRecord[];
    }

    const records: AnnotationRecord[] = [];
    for (const input of inputs) records.push(await insertAnnotation(client, input, username));
    await client.query(
      `INSERT INTO ia.annotation_bulk_mutation (client_mutation_id, response)
       VALUES ($1, $2::jsonb)`,
      [clientMutationId, JSON.stringify(records)]
    );
    await client.query('COMMIT');
    return records;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
