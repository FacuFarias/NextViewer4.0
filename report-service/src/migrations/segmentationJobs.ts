export const SEGMENTATION_JOB_MIGRATION_VERSION = '004_segmentation_jobs';

export const SEGMENTATION_JOB_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS ia.segmentation_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_instance_uid varchar(128) NOT NULL,
  source_series_instance_uid varchar(128) NOT NULL,
  model_name text NOT NULL,
  model_version text NOT NULL,
  input_manifest jsonb NOT NULL,
  idempotency_key text,
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 0,
  progress numeric(5,2) NOT NULL DEFAULT 0,
  stage text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  requested_by text,
  output_bucket text,
  output_key text,
  output_version_id text,
  output_etag text,
  output_checksum_sha256 text,
  output_size_bytes bigint,
  output_metadata jsonb,
  segmentation_object_id uuid,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT ck_segmentation_job_status CHECK (
    status IN ('queued', 'leased', 'processing', 'uploading', 'publishing', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT ck_segmentation_job_progress CHECK (progress >= 0 AND progress <= 100),
  CONSTRAINT ck_segmentation_job_attempts CHECK (attempt_count >= 0 AND max_attempts > 0),
  CONSTRAINT ck_segmentation_job_manifest CHECK (jsonb_typeof(input_manifest) = 'object')
);

CREATE TABLE IF NOT EXISTS ia.segmentation_job_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ia.segmentation_job(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  worker_id text NOT NULL,
  lease_token_hash text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'leased',
  stage text,
  progress numeric(5,2) NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT uq_segmentation_job_attempt UNIQUE (job_id, attempt_number),
  CONSTRAINT ck_segmentation_job_attempt_status CHECK (
    status IN ('leased', 'processing', 'uploading', 'completed', 'failed', 'expired', 'cancelled')
  ),
  CONSTRAINT ck_segmentation_attempt_progress CHECK (progress >= 0 AND progress <= 100)
);

ALTER TABLE ia.segmentation_object
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'HUMAN',
  ADD COLUMN IF NOT EXISTS model_run_id uuid REFERENCES ia.model_run(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES ia.segmentation_job(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS s3_bucket text,
  ADD COLUMN IF NOT EXISTS s3_key text,
  ADD COLUMN IF NOT EXISTS s3_version_id text,
  ADD COLUMN IF NOT EXISTS s3_etag text,
  ADD COLUMN IF NOT EXISTS checksum_sha256 text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS pacs_published_at timestamptz;

DO $$ BEGIN
  ALTER TABLE ia.segmentation_object
    ADD CONSTRAINT ck_segmentation_object_origin CHECK (origin IN ('HUMAN', 'AI', 'IMPORTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ia.segmentation_job
    ADD CONSTRAINT fk_segmentation_job_object
    FOREIGN KEY (segmentation_object_id) REFERENCES ia.segmentation_object(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_segmentation_job_idempotency
  ON ia.segmentation_job (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_segmentation_job_active_model
  ON ia.segmentation_job (study_instance_uid, source_series_instance_uid, model_name, model_version)
  WHERE status IN ('queued', 'leased', 'processing', 'uploading', 'publishing');
CREATE INDEX IF NOT EXISTS ix_segmentation_job_queue
  ON ia.segmentation_job (priority DESC, created_at ASC) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ix_segmentation_job_study
  ON ia.segmentation_job (study_instance_uid, source_series_instance_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_segmentation_attempt_lease
  ON ia.segmentation_job_attempt (lease_expires_at) WHERE status IN ('leased', 'processing', 'uploading');
CREATE UNIQUE INDEX IF NOT EXISTS uq_segmentation_object_job
  ON ia.segmentation_object (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_segmentation_object_model_run
  ON ia.segmentation_object (model_run_id) WHERE model_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ia.touch_segmentation_job_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_segmentation_job_updated_at ON ia.segmentation_job;
CREATE TRIGGER trg_segmentation_job_updated_at
BEFORE UPDATE ON ia.segmentation_job
FOR EACH ROW EXECUTE FUNCTION ia.touch_segmentation_job_updated_at();

DROP TRIGGER IF EXISTS trg_segmentation_attempt_updated_at ON ia.segmentation_job_attempt;
CREATE TRIGGER trg_segmentation_attempt_updated_at
BEFORE UPDATE ON ia.segmentation_job_attempt
FOR EACH ROW EXECUTE FUNCTION ia.touch_segmentation_job_updated_at();
`;
