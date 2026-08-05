import { getUsLosslessImageId } from './usLosslessImageLoader';

export type ViewerModality = 'ct' | 'us' | 'stack';

function normalizeModalities(values: Array<string | undefined>): string[] {
  return values
    .flatMap(value => value?.split(',') || [])
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
}

export function resolveViewerModality(
  ...values: Array<string | undefined>
): ViewerModality {
  // Values are ordered from the selected series to broader study fallbacks.
  // Never let another modality in the study override the active series.
  for (const value of values) {
    const modalities = normalizeModalities([value]);
    if (modalities.includes('CT')) return 'ct';
    if (modalities.includes('US')) return 'us';
  }
  return 'stack';
}

export function getViewerImageId(modality: ViewerModality, imageUrl: string): string {
  return modality === 'us' ? getUsLosslessImageId(imageUrl) : `wadouri:${imageUrl}`;
}

export function viewerUsesMpr(modality: ViewerModality): boolean {
  return modality === 'ct';
}
