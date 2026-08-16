import { Pool } from 'pg';
import { ANNOTATION_MIGRATION_SQL, ANNOTATION_MIGRATION_VERSION } from './migrations/annotations';
import {
  SEGMENTATION_OBJECT_MIGRATION_SQL,
  SEGMENTATION_OBJECT_MIGRATION_VERSION,
} from './migrations/segmentationObjects';
import {
  SEGMENTATION_JOB_MIGRATION_SQL,
  SEGMENTATION_JOB_MIGRATION_VERSION,
} from './migrations/segmentationJobs';
import {
  REFERENCE_STORAGE_MIGRATION_SQL,
  REFERENCE_STORAGE_MIGRATION_VERSION,
} from './migrations/referenceStorage';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'pacsdb',
  user: process.env.DB_USER || 'pacs',
  password: process.env.DB_PASSWORD || 'pacs',
});

export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Create schema if not exists
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS measurements
    `);

    // Create reports table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS measurements.reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        study_uid VARCHAR(255) NOT NULL,
        patient_id VARCHAR(255),
        accession_number VARCHAR(255),
        report TEXT,
        createdon TIMESTAMP DEFAULT NOW(),
        updatedon TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create index on study_uid
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_study_uid 
      ON measurements.reports(study_uid)
    `);

    await client.query('BEGIN');
    try {
      await client.query(ANNOTATION_MIGRATION_SQL);
      await client.query(
        `INSERT INTO ia.schema_migrations (version)
         VALUES ($1)
         ON CONFLICT (version) DO NOTHING`,
        [ANNOTATION_MIGRATION_VERSION]
      );
      await client.query(SEGMENTATION_OBJECT_MIGRATION_SQL);
      await client.query(
        `INSERT INTO ia.schema_migrations (version)
         VALUES ($1)
         ON CONFLICT (version) DO NOTHING`,
        [SEGMENTATION_OBJECT_MIGRATION_VERSION]
      );
      await client.query(SEGMENTATION_JOB_MIGRATION_SQL);
      await client.query(
        `INSERT INTO ia.schema_migrations (version)
         VALUES ($1)
         ON CONFLICT (version) DO NOTHING`,
        [SEGMENTATION_JOB_MIGRATION_VERSION]
      );
      await client.query(REFERENCE_STORAGE_MIGRATION_SQL);
      await client.query(
        `INSERT INTO ia.schema_migrations (version)
         VALUES ($1)
         ON CONFLICT (version) DO NOTHING`,
        [REFERENCE_STORAGE_MIGRATION_VERSION]
      );
      await client.query('COMMIT');
    } catch (migrationError) {
      await client.query('ROLLBACK');
      throw migrationError;
    }

    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
