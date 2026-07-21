import { Pool } from 'pg';

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

    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
