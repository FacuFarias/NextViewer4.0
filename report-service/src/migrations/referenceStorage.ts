export const REFERENCE_STORAGE_MIGRATION_VERSION = '005_reference_storage';

export const REFERENCE_STORAGE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS ia.reference_study (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accession_number varchar(64) NOT NULL,
  study_instance_uid varchar(128),
  representative_series_instance_uid varchar(128),
  representative_sop_instance_uid varchar(128),
  modality varchar(32),
  study_date varchar(16),
  study_description text,
  patient_id varchar(128),
  patient_name text,
  source_bucket text NOT NULL,
  source_prefix text NOT NULL,
  representative_object_key text,
  object_count bigint NOT NULL DEFAULT 0,
  total_size_bytes bigint NOT NULL DEFAULT 0,
  source_last_modified_at timestamptz,
  scan_status text NOT NULL DEFAULT 'pending',
  scan_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_scanned_at timestamptz,
  pacs_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_reference_study_accession UNIQUE (accession_number),
  CONSTRAINT uq_reference_study_source UNIQUE (source_bucket, source_prefix),
  CONSTRAINT ck_reference_study_scan_status
    CHECK (scan_status IN ('pending', 'scanning', 'ready', 'error')),
  CONSTRAINT ck_reference_study_counts CHECK (object_count >= 0 AND total_size_bytes >= 0),
  CONSTRAINT ck_reference_study_metadata CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reference_study_uid
  ON ia.reference_study (study_instance_uid) WHERE study_instance_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reference_study_scan
  ON ia.reference_study (scan_status, accession_number);
CREATE INDEX IF NOT EXISTS ix_reference_study_date
  ON ia.reference_study (study_date DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS ia.reference_import_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_study_id uuid NOT NULL REFERENCES ia.reference_study(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued',
  requested_by text,
  total_instances integer NOT NULL DEFAULT 0,
  imported_instances integer NOT NULL DEFAULT 0,
  failed_instances integer NOT NULL DEFAULT 0,
  progress numeric(5,2) NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_reference_import_status
    CHECK (status IN ('queued', 'importing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ck_reference_import_progress CHECK (progress >= 0 AND progress <= 100),
  CONSTRAINT ck_reference_import_counts
    CHECK (total_instances >= 0 AND imported_instances >= 0 AND failed_instances >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reference_import_active
  ON ia.reference_import_job (reference_study_id)
  WHERE status IN ('queued', 'importing');
CREATE INDEX IF NOT EXISTS ix_reference_import_queue
  ON ia.reference_import_job (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ix_reference_import_study
  ON ia.reference_import_job (reference_study_id, created_at DESC);

ALTER TABLE ia.segmentation_object
  ADD COLUMN IF NOT EXISTS segment_summary jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  ALTER TABLE ia.segmentation_object
    ADD CONSTRAINT ck_segmentation_object_segment_summary
    CHECK (jsonb_typeof(segment_summary) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION ia.touch_reference_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reference_study_updated_at ON ia.reference_study;
CREATE TRIGGER trg_reference_study_updated_at
BEFORE UPDATE ON ia.reference_study
FOR EACH ROW EXECUTE FUNCTION ia.touch_reference_updated_at();

DROP TRIGGER IF EXISTS trg_reference_import_updated_at ON ia.reference_import_job;
CREATE TRIGGER trg_reference_import_updated_at
BEFORE UPDATE ON ia.reference_import_job
FOR EACH ROW EXECUTE FUNCTION ia.touch_reference_updated_at();
`;
