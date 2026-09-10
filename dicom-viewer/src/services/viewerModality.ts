import type { DicomInstance, DicomSeries } from '../types/dicom';

export type ViewerModality = 'ct' | 'mr' | 'us' | 'stack';

export const CLINICAL_IMAGE_MODALITIES = new Set([
  'CT', 'MR', 'CR', 'DX', 'MG', 'US', 'XA', 'RF', 'NM', 'PT', 'SC', 'OT',
]);

const NON_VISUAL_SOP_CLASS_PREFIXES = [
  '1.2.840.10008.5.1.4.1.1.88.', // Structured Reports
  '1.2.840.10008.5.1.4.1.1.104.', // Encapsulated PDF/CDA
];
const NON_VISUAL_SOP_CLASSES = new Set([
  '1.2.840.10008.5.1.4.1.1.66.4', // Segmentation Storage
  '1.2.840.10008.5.1.4.1.1.77.1.2.1', // Video Microscopic Image Storage
  '1.2.840.10008.5.1.4.1.1.77.1.4.1', // Video Endoscopic Image Storage
  '1.2.840.10008.5.1.4.1.1.77.1.4.2', // Video Photographic Image Storage
]);
const VIDEO_TRANSFER_SYNTAXES = new Set([
  '1.2.840.10008.1.2.4.100',
  '1.2.840.10008.1.2.4.101',
  '1.2.840.10008.1.2.4.102',
  '1.2.840.10008.1.2.4.103',
  '1.2.840.10008.1.2.4.104',
  '1.2.840.10008.1.2.4.105',
  '1.2.840.10008.1.2.4.106',
  '1.2.840.10008.1.2.4.107',
  '1.2.840.10008.1.2.4.108',
]);

function normalize(values: Array<string | undefined>): string[] {
  return values
    .flatMap(entry => entry?.split(',') || [])
    .map(entry => entry.trim().toUpperCase())
    .filter(Boolean);
}

export function resolveViewerModality(...values: Array<string | undefined>): ViewerModality {
  for (const entry of values) {
    const modalities = normalize([entry]);
    if (modalities.includes('CT')) return 'ct';
    if (modalities.includes('MR')) return 'mr';
    if (modalities.includes('US')) return 'us';
  }
  return 'stack';
}

export function isClinicalImageModality(value: string | undefined): boolean {
  const modalities = normalize([value]);
  return modalities.length > 0 && modalities.every(modality => CLINICAL_IMAGE_MODALITIES.has(modality));
}

export function isSupportedVisualInstance(instance: Partial<DicomInstance>): boolean {
  const sopClassUID = instance.sopClassUID?.trim();
  if (sopClassUID && (NON_VISUAL_SOP_CLASSES.has(sopClassUID) ||
      NON_VISUAL_SOP_CLASS_PREFIXES.some(prefix => sopClassUID.startsWith(prefix)))) return false;
  const transferSyntaxUID = instance.transferSyntaxUID?.trim();
  return !transferSyntaxUID || !VIDEO_TRANSFER_SYNTAXES.has(transferSyntaxUID);
}

function validVector(value: number[] | undefined, length: number): boolean {
  return Boolean(value && value.length === length && value.every(Number.isFinite));
}

function approximatelyEqual(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function vectorLength(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function cross(left: number[], right: number[]): number[] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

export function isSeriesMprCapable(series: DicomSeries): boolean {
  const modality = resolveViewerModality(series.modality);
  if (!['ct', 'mr'].includes(modality) || series.instances.length < 3) return false;
  if (series.instances.some(instance => (instance.numberOfFrames || 1) > 1)) return false;

  const frameOfReference = series.instances[0]?.frameOfReferenceUID;
  if (!frameOfReference) return false;

  const referenceOrientation = series.instances[0].imageOrientationPatient;
  const referenceSpacing = series.instances[0].pixelSpacing;
  if (!validVector(referenceOrientation, 6) || !validVector(referenceSpacing, 2)) return false;

  const row = referenceOrientation!.slice(0, 3);
  const column = referenceOrientation!.slice(3, 6);
  if (!approximatelyEqual(vectorLength(row), 1, 0.01) ||
      !approximatelyEqual(vectorLength(column), 1, 0.01) ||
      Math.abs(dot(row, column)) > 0.01) return false;

  const normal = cross(row, column);
  const projectedPositions: number[] = [];
  for (const instance of series.instances) {
    if (instance.frameOfReferenceUID !== frameOfReference) return false;
    if (!validVector(instance.imagePositionPatient, 3)) return false;
    if (!validVector(instance.imageOrientationPatient, 6)) return false;
    if (!validVector(instance.pixelSpacing, 2)) return false;
    if (instance.pixelSpacing!.some(value => value <= 0)) return false;
    if (instance.imageOrientationPatient!.some((value, index) =>
      !approximatelyEqual(value, referenceOrientation![index], 0.001))) return false;
    if (instance.pixelSpacing!.some((value, index) => {
      const tolerance = Math.max(0.0001, referenceSpacing![index] * 0.01);
      return !approximatelyEqual(value, referenceSpacing![index], tolerance);
    })) return false;
    projectedPositions.push(dot(instance.imagePositionPatient!, normal));
  }

  const sortedPositions = [...new Set(projectedPositions.map(value => Number(value.toFixed(4))))]
    .sort((left, right) => left - right);
  if (sortedPositions.length !== series.instances.length) return false;
  const gaps = sortedPositions.slice(1).map((value, index) => value - sortedPositions[index]);
  const sortedGaps = [...gaps].sort((left, right) => left - right);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  if (!Number.isFinite(medianGap) || medianGap <= 0) return false;
  const gapTolerance = Math.max(0.2, medianGap * 0.1);
  return gaps.every(gap => approximatelyEqual(gap, medianGap, gapTolerance));
}
