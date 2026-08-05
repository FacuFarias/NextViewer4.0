export const ANNOTATION_MIGRATION_VERSION = '002_annotations';

export const ANNOTATION_MIGRATION_SQL = `
CREATE SCHEMA IF NOT EXISTS ia;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ia.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ia.model_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name text NOT NULL,
  model_version text NOT NULL,
  weights_hash text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text
);

CREATE TABLE IF NOT EXISTS ia.annotation_set (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_instance_uid varchar(128) NOT NULL,
  name text NOT NULL,
  description text,
  ontology_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  is_default boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_annotation_set_status CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'archived'))
);

CREATE TABLE IF NOT EXISTS ia.annotation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_set_id uuid NOT NULL REFERENCES ia.annotation_set(id) ON DELETE RESTRICT,
  study_instance_uid varchar(128) NOT NULL,
  series_instance_uid varchar(128) NOT NULL,
  sop_instance_uid varchar(128) NOT NULL,
  frame_number integer,
  instance_number integer,
  label_code text NOT NULL,
  label_name text NOT NULL,
  tool_name text NOT NULL,
  color varchar(32),
  geometry_type text NOT NULL,
  geometry jsonb NOT NULL,
  source text NOT NULL DEFAULT 'HUMAN',
  status text NOT NULL DEFAULT 'draft',
  model_run_id uuid REFERENCES ia.model_run(id) ON DELETE SET NULL,
  confidence numeric,
  version integer NOT NULL DEFAULT 1,
  supersedes_annotation_id uuid REFERENCES ia.annotation(id) ON DELETE RESTRICT,
  created_by text,
  reviewed_by text,
  cornerstone_annotation_uid text,
  modality text,
  rows integer,
  columns integer,
  pixel_spacing jsonb,
  image_position_patient jsonb,
  image_orientation_patient jsonb,
  frame_of_reference_uid text,
  series_number integer,
  client_mutation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT ck_annotation_source CHECK (source IN ('HUMAN', 'AI', 'AI_CORRECTED')),
  CONSTRAINT ck_annotation_status CHECK (status IN ('draft', 'reviewed', 'approved', 'rejected', 'archived')),
  CONSTRAINT ck_annotation_version CHECK (version > 0),
  CONSTRAINT ck_annotation_frame_number CHECK (frame_number IS NULL OR frame_number > 0),
  CONSTRAINT ck_annotation_geometry_object CHECK (jsonb_typeof(geometry) = 'object')
);

CREATE TABLE IF NOT EXISTS ia.annotation_bulk_mutation (
  client_mutation_id text PRIMARY KEY,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_annotation_set_default_study
  ON ia.annotation_set (study_instance_uid)
  WHERE is_default = true AND status NOT IN ('archived', 'rejected');

CREATE UNIQUE INDEX IF NOT EXISTS uq_annotation_client_mutation
  ON ia.annotation (annotation_set_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_annotation_study_uid ON ia.annotation (study_instance_uid);
CREATE INDEX IF NOT EXISTS ix_annotation_series_uid ON ia.annotation (series_instance_uid);
CREATE INDEX IF NOT EXISTS ix_annotation_sop_uid ON ia.annotation (sop_instance_uid);
CREATE INDEX IF NOT EXISTS ix_annotation_set_id ON ia.annotation (annotation_set_id);
CREATE INDEX IF NOT EXISTS ix_annotation_label_code ON ia.annotation (label_code);
CREATE INDEX IF NOT EXISTS ix_annotation_status ON ia.annotation (status);
CREATE INDEX IF NOT EXISTS ix_annotation_source ON ia.annotation (source);
CREATE INDEX IF NOT EXISTS ix_annotation_created_at ON ia.annotation (created_at);
CREATE INDEX IF NOT EXISTS ix_annotation_supersedes ON ia.annotation (supersedes_annotation_id);
CREATE INDEX IF NOT EXISTS ix_annotation_image
  ON ia.annotation (study_instance_uid, series_instance_uid, sop_instance_uid, frame_number);
CREATE INDEX IF NOT EXISTS ix_annotation_set_image
  ON ia.annotation (annotation_set_id, sop_instance_uid, frame_number);
CREATE INDEX IF NOT EXISTS ix_annotation_set_label_status
  ON ia.annotation (annotation_set_id, label_code, status);
CREATE INDEX IF NOT EXISTS ix_annotation_set_study
  ON ia.annotation_set (study_instance_uid, status, updated_at);

CREATE OR REPLACE FUNCTION ia.touch_annotation_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_annotation_set_updated_at ON ia.annotation_set;
CREATE TRIGGER trg_annotation_set_updated_at
BEFORE UPDATE ON ia.annotation_set
FOR EACH ROW EXECUTE FUNCTION ia.touch_annotation_updated_at();

DROP TRIGGER IF EXISTS trg_annotation_updated_at ON ia.annotation;
CREATE TRIGGER trg_annotation_updated_at
BEFORE UPDATE ON ia.annotation
FOR EACH ROW EXECUTE FUNCTION ia.touch_annotation_updated_at();
`;
