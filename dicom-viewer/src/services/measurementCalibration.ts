export type MeasurementUnit = 'mm' | 'px';

export function getMeasurementUnit(pixelSpacing?: number[]): MeasurementUnit {
  return pixelSpacing?.length === 2 && pixelSpacing.every(value => Number.isFinite(value) && value > 0)
    ? 'mm'
    : 'px';
}

export function calibratedLength(
  start: [number, number],
  end: [number, number],
  pixelSpacing?: number[]
): number {
  const rowSpacing = getMeasurementUnit(pixelSpacing) === 'mm' ? pixelSpacing![0] : 1;
  const columnSpacing = getMeasurementUnit(pixelSpacing) === 'mm' ? pixelSpacing![1] : 1;
  return Math.hypot(
    (end[0] - start[0]) * columnSpacing,
    (end[1] - start[1]) * rowSpacing
  );
}

export function angleDegrees(
  first: [number, number],
  vertex: [number, number],
  second: [number, number]
): number {
  const a = [first[0] - vertex[0], first[1] - vertex[1]];
  const b = [second[0] - vertex[0], second[1] - vertex[1]];
  const denominator = Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]);
  if (!denominator) return 0;
  const cosine = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / denominator));
  return Math.acos(cosine) * 180 / Math.PI;
}
