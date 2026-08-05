export const SEGMENTATION_OBJECT_MIGRATION_VERSION = '003_segmentation_objects';

export const SEGMENTATION_OBJECT_MIGRATION_SQL = `
CREATE SCHEMA IF NOT EXISTS ia;

CREATE TABLE IF NOT EXISTS ia.segmentation_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_instance_uid varchar(128) NOT NULL,
  source_series_instance_uid varchar(128) NOT NULL,
  segmentation_series_instance_uid varchar(128) NOT NULL,
  segmentation_sop_instance_uid varchar(128) NOT NULL,
  name text NOT NULL,
  description text,
  ontology_version text NOT NULL,
  dimensions jsonb NOT NULL,
  spacing jsonb NOT NULL,
  frame_of_reference_uid varchar(128),
  version integer NOT NULL DEFAULT 1,
  supersedes_object_id uuid REFERENCES ia.segmentation_object(id) ON DELETE RESTRICT,
  created_by text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_segmentation_object_status
    CHECK (status IN ('draft', 'superseded', 'archived')),
  CONSTRAINT ck_segmentation_object_version CHECK (version > 0),
  CONSTRAINT ck_segmentation_object_dimensions
    CHECK (jsonb_typeof(dimensions) = 'array'),
  CONSTRAINT ck_segmentation_object_spacing
    CHECK (jsonb_typeof(spacing) = 'array')
);

CREATE INDEX IF NOT EXISTS ix_segmentation_object_study
  ON ia.segmentation_object (study_instance_uid, source_series_instance_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_segmentation_object_status
  ON ia.segmentation_object (status);
CREATE INDEX IF NOT EXISTS ix_segmentation_object_supersedes
  ON ia.segmentation_object (supersedes_object_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_segmentation_object_sop
  ON ia.segmentation_object (segmentation_sop_instance_uid);

CREATE OR REPLACE FUNCTION ia.touch_segmentation_object_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_segmentation_object_updated_at ON ia.segmentation_object;
CREATE TRIGGER trg_segmentation_object_updated_at
BEFORE UPDATE ON ia.segmentation_object
FOR EACH ROW EXECUTE FUNCTION ia.touch_segmentation_object_updated_at();
`;
