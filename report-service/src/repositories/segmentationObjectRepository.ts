import pool from '../db';
import {
  CreateSegmentationObjectInput,
  SegmentationObjectRecord,
  UpdateSegmentationObjectInput,
} from '../types/segmentationObjects';

export class SegmentationObjectRepositoryError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function mapObject(row: any): SegmentationObjectRecord {
  return {
    id: row.id,
    studyInstanceUID: row.study_instance_uid,
    sourceSeriesInstanceUID: row.source_series_instance_uid,
    segmentationSeriesInstanceUID: row.segmentation_series_instance_uid,
    segmentationSOPInstanceUID: row.segmentation_sop_instance_uid,
    name: row.name,
    description: row.description,
    ontologyVersion: row.ontology_version,
    dimensions: row.dimensions,
    spacing: row.spacing,
    frameOfReferenceUID: row.frame_of_reference_uid,
    version: row.version,
    supersedesObjectId: row.supersedes_object_id,
    createdBy: row.created_by,
    status: row.status,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

export async function listSegmentationObjects(
  studyInstanceUID: string,
  sourceSeriesInstanceUID?: string
): Promise<SegmentationObjectRecord[]> {
  const values: unknown[] = [studyInstanceUID];
  const conditions = ['study_instance_uid = $1'];
  if (sourceSeriesInstanceUID) {
    values.push(sourceSeriesInstanceUID);
    conditions.push(`source_series_instance_uid = $${values.length}`);
  }
  const result = await pool.query(
    `SELECT * FROM ia.segmentation_object
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, version DESC`,
    values
  );
  return result.rows.map(mapObject);
}

export async function getSegmentationObject(id: string): Promise<SegmentationObjectRecord> {
  const result = await pool.query('SELECT * FROM ia.segmentation_object WHERE id = $1', [id]);
  if (!result.rows[0]) throw new SegmentationObjectRepositoryError(404, 'Segmentation object not found');
  return mapObject(result.rows[0]);
}

export async function createSegmentationObject(
  input: CreateSegmentationObjectInput,
  username: string | null
): Promise<SegmentationObjectRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.supersedesObjectId) {
      const previous = await client.query(
        `SELECT id, study_instance_uid, source_series_instance_uid
         FROM ia.segmentation_object WHERE id = $1 FOR UPDATE`,
        [input.supersedesObjectId]
      );
      if (!previous.rows[0]) {
        throw new SegmentationObjectRepositoryError(404, 'Previous segmentation object not found');
      }
      if (previous.rows[0].study_instance_uid !== input.studyInstanceUID ||
          previous.rows[0].source_series_instance_uid !== input.sourceSeriesInstanceUID) {
        throw new SegmentationObjectRepositoryError(400, 'Previous segmentation object belongs to another CT series');
      }
    }

    const result = await client.query(
      `INSERT INTO ia.segmentation_object (
         study_instance_uid, source_series_instance_uid,
         segmentation_series_instance_uid, segmentation_sop_instance_uid,
         name, description, ontology_version, dimensions, spacing,
         frame_of_reference_uid, version, supersedes_object_id, created_by, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        input.studyInstanceUID,
        input.sourceSeriesInstanceUID,
        input.segmentationSeriesInstanceUID,
        input.segmentationSOPInstanceUID,
        input.name,
        input.description ?? null,
        input.ontologyVersion,
        JSON.stringify(input.dimensions),
        JSON.stringify(input.spacing),
        input.frameOfReferenceUID ?? null,
        input.version || 1,
        input.supersedesObjectId ?? null,
        username,
        input.status || 'draft',
      ]
    );

    if (input.supersedesObjectId) {
      await client.query(
        `UPDATE ia.segmentation_object
         SET status = 'superseded'
         WHERE id = $1 AND status <> 'archived'`,
        [input.supersedesObjectId]
      );
    }
    await client.query('COMMIT');
    return mapObject(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof SegmentationObjectRepositoryError) throw error;
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSegmentationObject(
  id: string,
  input: UpdateSegmentationObjectInput
): Promise<SegmentationObjectRecord> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) { values.push(input.name); fields.push(`name = $${values.length}`); }
  if (input.description !== undefined) { values.push(input.description); fields.push(`description = $${values.length}`); }
  if (input.status !== undefined) { values.push(input.status); fields.push(`status = $${values.length}`); }
  if (fields.length === 0) return getSegmentationObject(id);

  values.push(id);
  const result = await pool.query(
    `UPDATE ia.segmentation_object
     SET ${fields.join(', ')}
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );
  if (!result.rows[0]) throw new SegmentationObjectRepositoryError(404, 'Segmentation object not found');
  return mapObject(result.rows[0]);
}
