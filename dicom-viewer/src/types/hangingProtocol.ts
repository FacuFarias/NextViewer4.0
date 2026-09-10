import type { DicomSeries } from './dicom';

export const HANGING_MODALITIES = [
  'CT', 'MR', 'CR', 'DX', 'MG', 'US', 'XA', 'RF', 'NM', 'PT', 'SC', 'OT',
] as const;

export type HangingModality = typeof HANGING_MODALITIES[number];
export type GridLayout =
  | '1x1' | '1x2' | '1x3'
  | '2x1' | '2x2' | '2x3'
  | '3x1' | '3x2' | '3x3';
export type HangingLayout = GridLayout | 'mpr';

export interface SeriesMatchRule {
  modality?: HangingModality;
  descriptionIncludes?: string[];
  descriptionExcludes?: string[];
  laterality?: string[];
  viewPosition?: string[];
  bodyPart?: string[];
  seriesNumberMin?: number;
  seriesNumberMax?: number;
}

export interface HangingViewportRule {
  slot: number;
  label?: string;
  match: SeriesMatchRule;
}

export interface HangingProtocol {
  id: string;
  name: string;
  modality: HangingModality;
  layout: HangingLayout;
  isActive: boolean;
  source: 'system' | 'user';
  viewportRules: HangingViewportRule[];
}

export interface HangingAssignment {
  slot: number;
  label?: string;
  series?: DicomSeries;
}
