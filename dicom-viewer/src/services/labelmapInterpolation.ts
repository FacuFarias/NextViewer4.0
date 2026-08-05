export type LabelmapInterpolationAxis = 0 | 1 | 2;

export interface LabelmapInterpolationRequest {
  scalarData: Uint8Array;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  segmentIndex: number;
  axis: LabelmapInterpolationAxis;
  anchorSlices: Iterable<number>;
  previousGeneratedOffsets?: ReadonlySet<number>;
}

export interface LabelmapInterpolationResult {
  generatedOffsets: Set<number>;
  modifiedNativeSlices: number[];
  changedVoxelCount: number;
  interpolatedVoxelCount: number;
  interpolatedSliceCount: number;
  anchorPairCount: number;
}

const LARGE_DISTANCE = 1e20;

function getPlaneAxes(axis: LabelmapInterpolationAxis): [LabelmapInterpolationAxis, LabelmapInterpolationAxis] {
  if (axis === 0) return [1, 2];
  if (axis === 1) return [0, 2];
  return [0, 1];
}

function getVoxelOffset(
  dimensions: [number, number, number],
  axis: LabelmapInterpolationAxis,
  slice: number,
  u: number,
  v: number
): number {
  const planeAxes = getPlaneAxes(axis);
  const coordinates: [number, number, number] = [0, 0, 0];
  coordinates[axis] = slice;
  coordinates[planeAxes[0]] = u;
  coordinates[planeAxes[1]] = v;
  return coordinates[0] + dimensions[0] * (
    coordinates[1] + dimensions[1] * coordinates[2]
  );
}

function getAxisCoordinateFromOffset(
  offset: number,
  dimensions: [number, number, number],
  axis: LabelmapInterpolationAxis
): number {
  if (axis === 0) return offset % dimensions[0];
  if (axis === 1) return Math.floor(offset / dimensions[0]) % dimensions[1];
  return Math.floor(offset / (dimensions[0] * dimensions[1]));
}

function getNativeSliceFromOffset(
  offset: number,
  dimensions: [number, number, number]
): number {
  return Math.floor(offset / (dimensions[0] * dimensions[1]));
}

function distanceTransform1D(
  source: Float64Array,
  spacing: number
): Float64Array {
  const length = source.length;
  const output = new Float64Array(length);
  if (length === 0) return output;

  const parabolaLocations = new Int32Array(length);
  const boundaries = new Float64Array(length + 1);
  const spacingSquared = spacing * spacing;
  let envelopeIndex = 0;

  parabolaLocations[0] = 0;
  boundaries[0] = Number.NEGATIVE_INFINITY;
  boundaries[1] = Number.POSITIVE_INFINITY;

  for (let q = 1; q < length; q += 1) {
    let previous = parabolaLocations[envelopeIndex];
    let intersection = (
      (source[q] + spacingSquared * q * q) -
      (source[previous] + spacingSquared * previous * previous)
    ) / (2 * spacingSquared * (q - previous));

    while (intersection <= boundaries[envelopeIndex] && envelopeIndex > 0) {
      envelopeIndex -= 1;
      previous = parabolaLocations[envelopeIndex];
      intersection = (
        (source[q] + spacingSquared * q * q) -
        (source[previous] + spacingSquared * previous * previous)
      ) / (2 * spacingSquared * (q - previous));
    }

    envelopeIndex += 1;
    parabolaLocations[envelopeIndex] = q;
    boundaries[envelopeIndex] = intersection;
    boundaries[envelopeIndex + 1] = Number.POSITIVE_INFINITY;
  }

  envelopeIndex = 0;
  for (let q = 0; q < length; q += 1) {
    while (boundaries[envelopeIndex + 1] < q) envelopeIndex += 1;
    const sourceIndex = parabolaLocations[envelopeIndex];
    const delta = q - sourceIndex;
    output[q] = spacingSquared * delta * delta + source[sourceIndex];
  }

  return output;
}

function squaredDistanceToFeature(
  mask: Uint8Array,
  width: number,
  height: number,
  spacingU: number,
  spacingV: number,
  featureValue: 0 | 1
): Float64Array {
  const pixelCount = width * height;
  const initial = new Float64Array(pixelCount);
  let hasFeature = false;

  for (let index = 0; index < pixelCount; index += 1) {
    const matches = mask[index] === featureValue;
    initial[index] = matches ? 0 : LARGE_DISTANCE;
    hasFeature ||= matches;
  }

  if (!hasFeature) {
    initial.fill(LARGE_DISTANCE);
    return initial;
  }

  const columnPass = new Float64Array(pixelCount);
  const column = new Float64Array(height);
  for (let u = 0; u < width; u += 1) {
    for (let v = 0; v < height; v += 1) column[v] = initial[v * width + u];
    const transformed = distanceTransform1D(column, spacingV);
    for (let v = 0; v < height; v += 1) columnPass[v * width + u] = transformed[v];
  }

  const output = new Float64Array(pixelCount);
  const row = new Float64Array(width);
  for (let v = 0; v < height; v += 1) {
    const rowOffset = v * width;
    for (let u = 0; u < width; u += 1) row[u] = columnPass[rowOffset + u];
    const transformed = distanceTransform1D(row, spacingU);
    for (let u = 0; u < width; u += 1) output[rowOffset + u] = transformed[u];
  }

  return output;
}

function createSignedDistanceField(
  mask: Uint8Array,
  width: number,
  height: number,
  spacingU: number,
  spacingV: number
): Float64Array | null {
  let foregroundCount = 0;
  for (let index = 0; index < mask.length; index += 1) foregroundCount += mask[index];
  if (foregroundCount === 0) return null;

  const distanceToForeground = squaredDistanceToFeature(
    mask,
    width,
    height,
    spacingU,
    spacingV,
    1
  );
  const distanceToBackground = squaredDistanceToFeature(
    mask,
    width,
    height,
    spacingU,
    spacingV,
    0
  );
  const signedDistance = new Float64Array(mask.length);

  for (let index = 0; index < mask.length; index += 1) {
    signedDistance[index] = Math.sqrt(distanceToForeground[index]) -
      Math.sqrt(distanceToBackground[index]);
  }
  return signedDistance;
}

function extractSegmentMask(
  scalarData: Uint8Array,
  dimensions: [number, number, number],
  segmentIndex: number,
  axis: LabelmapInterpolationAxis,
  slice: number
): Uint8Array {
  const planeAxes = getPlaneAxes(axis);
  const width = dimensions[planeAxes[0]];
  const height = dimensions[planeAxes[1]];
  const mask = new Uint8Array(width * height);

  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      const planeOffset = v * width + u;
      const voxelOffset = getVoxelOffset(dimensions, axis, slice, u, v);
      mask[planeOffset] = scalarData[voxelOffset] === segmentIndex ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Morphologically interpolates one segment between manually edited planes.
 *
 * Endpoint masks are converted to signed Euclidean distance fields. Linear
 * interpolation of those fields gives smooth translations and size changes,
 * while preserving holes better than blending binary pixels directly.
 */
export function interpolateLabelmapSegment(
  request: LabelmapInterpolationRequest
): LabelmapInterpolationResult {
  const {
    scalarData,
    dimensions,
    spacing,
    segmentIndex,
    axis,
    previousGeneratedOffsets = new Set<number>(),
  } = request;
  const maxSlice = dimensions[axis] - 1;
  const anchors = Array.from(new Set(Array.from(request.anchorSlices)))
    .map(value => Math.round(value))
    .filter(value => value >= 0 && value <= maxSlice)
    .sort((left, right) => left - right);
  const anchorSet = new Set(anchors);
  const planeAxes = getPlaneAxes(axis);
  const width = dimensions[planeAxes[0]];
  const height = dimensions[planeAxes[1]];
  const spacingU = Math.max(Number.EPSILON, Math.abs(spacing[planeAxes[0]]));
  const spacingV = Math.max(Number.EPSILON, Math.abs(spacing[planeAxes[1]]));
  const desiredOffsets = new Set<number>();
  const interpolatedSlices = new Set<number>();
  const distanceFields = new Map<number, Float64Array | null>();
  let anchorPairCount = 0;

  const getDistanceField = (slice: number) => {
    if (!distanceFields.has(slice)) {
      const mask = extractSegmentMask(scalarData, dimensions, segmentIndex, axis, slice);
      distanceFields.set(
        slice,
        createSignedDistanceField(mask, width, height, spacingU, spacingV)
      );
    }
    return distanceFields.get(slice) || null;
  };

  for (let anchorIndex = 0; anchorIndex + 1 < anchors.length; anchorIndex += 1) {
    const lowerSlice = anchors[anchorIndex];
    const upperSlice = anchors[anchorIndex + 1];
    if (upperSlice - lowerSlice <= 1) continue;

    const lowerDistance = getDistanceField(lowerSlice);
    const upperDistance = getDistanceField(upperSlice);
    // An explicitly erased/empty anchor creates a hard stop instead of
    // allowing interpolation to bridge across a region the user removed.
    if (!lowerDistance || !upperDistance) continue;
    anchorPairCount += 1;

    for (let slice = lowerSlice + 1; slice < upperSlice; slice += 1) {
      const interpolationFraction = (slice - lowerSlice) / (upperSlice - lowerSlice);
      let hasInterpolatedVoxel = false;
      for (let pixelOffset = 0; pixelOffset < lowerDistance.length; pixelOffset += 1) {
        const interpolatedDistance =
          lowerDistance[pixelOffset] * (1 - interpolationFraction) +
          upperDistance[pixelOffset] * interpolationFraction;
        if (interpolatedDistance > 0) continue;

        const u = pixelOffset % width;
        const v = Math.floor(pixelOffset / width);
        desiredOffsets.add(getVoxelOffset(dimensions, axis, slice, u, v));
        hasInterpolatedVoxel = true;
      }
      if (hasInterpolatedVoxel) interpolatedSlices.add(slice);
    }
  }

  const generatedOffsets = new Set<number>();
  const modifiedNativeSlices = new Set<number>();
  let changedVoxelCount = 0;

  previousGeneratedOffsets.forEach(offset => {
    const isNowManualAnchor = anchorSet.has(
      getAxisCoordinateFromOffset(offset, dimensions, axis)
    );
    if (isNowManualAnchor) return;

    if (desiredOffsets.has(offset)) {
      if (scalarData[offset] === segmentIndex) generatedOffsets.add(offset);
      return;
    }

    if (scalarData[offset] === segmentIndex) {
      scalarData[offset] = 0;
      changedVoxelCount += 1;
      modifiedNativeSlices.add(getNativeSliceFromOffset(offset, dimensions));
    }
  });

  desiredOffsets.forEach(offset => {
    const currentValue = scalarData[offset];
    if (currentValue !== 0 && currentValue !== segmentIndex) return;

    if (currentValue === 0) {
      scalarData[offset] = segmentIndex;
      changedVoxelCount += 1;
      modifiedNativeSlices.add(getNativeSliceFromOffset(offset, dimensions));
      generatedOffsets.add(offset);
      return;
    }

    // Keep ownership only for voxels generated by an earlier interpolation.
    // Existing voxels of this segment may be manual and must never be erased
    // by a later recalculation.
    if (previousGeneratedOffsets.has(offset)) generatedOffsets.add(offset);
  });

  return {
    generatedOffsets,
    modifiedNativeSlices: Array.from(modifiedNativeSlices).sort((left, right) => left - right),
    changedVoxelCount,
    interpolatedVoxelCount: desiredOffsets.size,
    interpolatedSliceCount: interpolatedSlices.size,
    anchorPairCount,
  };
}
