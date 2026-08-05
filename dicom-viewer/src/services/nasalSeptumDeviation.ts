export const NASAL_SEPTUM_DEVIATION_TOOL_NAME = 'NasalSeptumDeviationTool';
export const NASAL_SEPTUM_DEVIATION_LABEL = 'Nasal Septum Deviation';
export const NASAL_SEPTUM_DEVIATION_CODE = 'nasal_septum_deviation';
export const NASAL_SEPTUM_DEVIATION_COLOR = '#ff6f00';

export interface PixelPoint {
  x: number;
  y: number;
}

export interface NasalSeptumDeviationMeasurement {
  measurement: typeof NASAL_SEPTUM_DEVIATION_CODE;
  axis_start: PixelPoint;
  axis_end: PixelPoint;
  deviation_point: PixelPoint;
  projection_point: PixelPoint;
  axis_length_mm: number;
  deviation_length_mm: number;
  pixel_spacing: [number, number];
}

export interface NasalSeptumDeviationCalculation {
  projectionPoint: PixelPoint;
  axisLengthMm: number;
  deviationLengthMm: number;
  pixelSpacing: [number, number];
}

export interface WorldNasalSeptumDeviationCalculation {
  projectionPoint: [number, number, number];
  axisLengthMm: number;
  deviationLengthMm: number;
}

function finitePoint(point: PixelPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validPixelSpacing(pixelSpacing: number[] | undefined): pixelSpacing is [number, number] {
  return Boolean(
    pixelSpacing &&
      pixelSpacing.length >= 2 &&
      Number.isFinite(pixelSpacing[0]) &&
      Number.isFinite(pixelSpacing[1]) &&
      pixelSpacing[0] > 0 &&
      pixelSpacing[1] > 0
  );
}

function toPhysical(point: PixelPoint, pixelSpacing: [number, number]): PixelPoint {
  // DICOM Pixel Spacing is [rowSpacing, columnSpacing].
  return {
    x: point.x * pixelSpacing[1],
    y: point.y * pixelSpacing[0],
  };
}

function toPixel(point: PixelPoint, pixelSpacing: [number, number]): PixelPoint {
  return {
    x: point.x / pixelSpacing[1],
    y: point.y / pixelSpacing[0],
  };
}

function distance(first: PixelPoint, second: PixelPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function isValidPixelSpacing(pixelSpacing: number[] | undefined): pixelSpacing is [number, number] {
  return validPixelSpacing(pixelSpacing);
}

export function calculateNasalSeptumDeviation(
  axisStart: PixelPoint,
  axisEnd: PixelPoint,
  deviationPoint: PixelPoint,
  pixelSpacing: number[] | undefined
): NasalSeptumDeviationCalculation {
  if (!finitePoint(axisStart) || !finitePoint(axisEnd) || !finitePoint(deviationPoint)) {
    throw new Error('Los puntos de Nasal Septum Deviation deben ser numéricos');
  }

  if (!validPixelSpacing(pixelSpacing)) {
    throw new Error('La imagen no tiene Pixel Spacing válido para calcular milímetros');
  }

  const spacing: [number, number] = [pixelSpacing[0], pixelSpacing[1]];
  const physicalStart = toPhysical(axisStart, spacing);
  const physicalEnd = toPhysical(axisEnd, spacing);
  const physicalDeviation = toPhysical(deviationPoint, spacing);
  const axisVector = {
    x: physicalEnd.x - physicalStart.x,
    y: physicalEnd.y - physicalStart.y,
  };
  const axisSquaredLength = axisVector.x ** 2 + axisVector.y ** 2;

  if (!Number.isFinite(axisSquaredLength) || axisSquaredLength <= Number.EPSILON) {
    throw new Error('El eje del tabique debe tener una longitud mayor que cero');
  }

  // Projection on the infinite physical axis. This preserves the 90° angle
  // even when the projected point falls outside the two selected endpoints.
  const deviationVector = {
    x: physicalDeviation.x - physicalStart.x,
    y: physicalDeviation.y - physicalStart.y,
  };
  const projectionFactor =
    (deviationVector.x * axisVector.x + deviationVector.y * axisVector.y) /
    axisSquaredLength;
  const physicalProjection = {
    x: physicalStart.x + projectionFactor * axisVector.x,
    y: physicalStart.y + projectionFactor * axisVector.y,
  };
  const projectionPoint = toPixel(physicalProjection, spacing);

  return {
    projectionPoint,
    axisLengthMm: distance(physicalStart, physicalEnd),
    deviationLengthMm: distance(physicalDeviation, physicalProjection),
    pixelSpacing: spacing,
  };
}

/**
 * Calculates the same measurement directly in patient/world coordinates.
 * Volume viewports (MPR) do not represent a single DICOM image plane, so
 * using an image's row/column Pixel Spacing would be incorrect there. World
 * coordinates are already expressed in millimetres by Cornerstone.
 */
export function calculateNasalSeptumDeviationInWorld(
  axisStart: number[],
  axisEnd: number[],
  deviationPoint: number[]
): WorldNasalSeptumDeviationCalculation {
  const points = [axisStart, axisEnd, deviationPoint];
  if (points.some(point => !Array.isArray(point) || point.length < 3 ||
      point.slice(0, 3).some(value => !Number.isFinite(value)))) {
    throw new Error('Los puntos de Nasal Septum Deviation deben ser numéricos');
  }

  const vector = [
    axisEnd[0] - axisStart[0],
    axisEnd[1] - axisStart[1],
    axisEnd[2] - axisStart[2],
  ];
  const squaredLength = vector.reduce((sum, value) => sum + value ** 2, 0);
  if (!Number.isFinite(squaredLength) || squaredLength <= Number.EPSILON) {
    throw new Error('El eje del tabique debe tener una longitud mayor que cero');
  }

  const toDeviation = [
    deviationPoint[0] - axisStart[0],
    deviationPoint[1] - axisStart[1],
    deviationPoint[2] - axisStart[2],
  ];
  const factor = toDeviation.reduce((sum, value, index) => sum + value * vector[index], 0) / squaredLength;
  const projectionPoint: [number, number, number] = [
    axisStart[0] + factor * vector[0],
    axisStart[1] + factor * vector[1],
    axisStart[2] + factor * vector[2],
  ];

  const distance = (first: number[], second: number[]) => Math.sqrt(
    first.reduce((sum, value, index) => sum + (value - second[index]) ** 2, 0)
  );

  return {
    projectionPoint,
    axisLengthMm: distance(axisStart, axisEnd),
    deviationLengthMm: distance(deviationPoint, projectionPoint),
  };
}
