export type RegionGrowConnectivity = 6 | 18 | 26;

export interface LabelmapRegionGrowingRequest {
  sourceScalarData: ArrayLike<number>;
  labelmapScalarData: Uint8Array;
  dimensions: [number, number, number];
  seedIJK: [number, number, number];
  segmentIndex: number;
  toleranceHU: number;
  connectivity: RegionGrowConnectivity;
  maxVoxels: number;
  setLabelValue?: (offset: number, value: number) => void;
}

export interface LabelmapRegionEraseRequest {
  sourceScalarData: ArrayLike<number>;
  labelmapScalarData: Uint8Array;
  dimensions: [number, number, number];
  seedIJK: [number, number, number];
  seedIJKs?: Array<[number, number, number]>;
  segmentIndex: number;
  toleranceHU: number;
  connectivity: RegionGrowConnectivity;
  maxVoxels: number;
  setLabelValue?: (offset: number, value: number) => void;
}

export interface LabelmapRegionGrowingResult {
  seedValue: number;
  lowerThreshold: number;
  upperThreshold: number;
  selectedVoxelCount: number;
  changedVoxelCount: number;
  changedVoxelOffsets: number[];
  modifiedNativeSlices: number[];
  stoppedByLimit: boolean;
}

function getNeighborOffsets(connectivity: RegionGrowConnectivity): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = [];
  for (let k = -1; k <= 1; k += 1) {
    for (let j = -1; j <= 1; j += 1) {
      for (let i = -1; i <= 1; i += 1) {
        const distance = Math.abs(i) + Math.abs(j) + Math.abs(k);
        if (distance === 0) continue;
        if (connectivity === 6 && distance !== 1) continue;
        if (connectivity === 18 && distance > 2) continue;
        offsets.push([i, j, k]);
      }
    }
  }
  return offsets;
}

function toOffset(
  dimensions: [number, number, number],
  i: number,
  j: number,
  k: number
): number {
  return i + dimensions[0] * (j + dimensions[1] * k);
}

/**
 * Grows a labelmap from one CT voxel using a seed-relative HU interval.
 * Other non-zero segments are treated as barriers and are never overwritten.
 */
export function growLabelmapRegion(
  request: LabelmapRegionGrowingRequest
): LabelmapRegionGrowingResult {
  const {
    sourceScalarData,
    labelmapScalarData,
    dimensions,
    seedIJK,
    segmentIndex,
    toleranceHU,
    connectivity,
    maxVoxels,
    setLabelValue,
  } = request;
  const [width, height, depth] = dimensions;
  const [seedI, seedJ, seedK] = seedIJK;
  if (
    seedI < 0 || seedI >= width ||
    seedJ < 0 || seedJ >= height ||
    seedK < 0 || seedK >= depth
  ) {
    throw new Error('La semilla está fuera del volumen CT');
  }

  const seedOffset = toOffset(dimensions, seedI, seedJ, seedK);
  const seedValue = Number(sourceScalarData[seedOffset]);
  if (!Number.isFinite(seedValue)) {
    throw new Error('El voxel seleccionado no contiene un valor CT válido');
  }

  const existingLabel = labelmapScalarData[seedOffset];
  if (existingLabel !== 0 && existingLabel !== segmentIndex) {
    throw new Error('El voxel seleccionado pertenece a otra estructura bloqueada');
  }

  const safeTolerance = Math.max(0, Number(toleranceHU) || 0);
  const lowerThreshold = seedValue - safeTolerance;
  const upperThreshold = seedValue + safeTolerance;
  const safeMaxVoxels = Math.max(1, Math.floor(maxVoxels));
  const visited = new Uint8Array(width * height * depth);
  const queue = new Int32Array(safeMaxVoxels);
  const neighborOffsets = getNeighborOffsets(connectivity);
  const modifiedNativeSlices = new Set<number>();
  let head = 0;
  let tail = 0;
  let selectedVoxelCount = 0;
  let changedVoxelCount = 0;
  const changedVoxelOffsets: number[] = [];
  let stoppedByLimit = false;

  visited[seedOffset] = 1;
  queue[tail] = seedOffset;
  tail += 1;

  while (head < tail) {
    const offset = queue[head];
    head += 1;
    selectedVoxelCount += 1;

    if (labelmapScalarData[offset] === 0) {
      labelmapScalarData[offset] = segmentIndex;
      setLabelValue?.(offset, segmentIndex);
      changedVoxelCount += 1;
      changedVoxelOffsets.push(offset);
      modifiedNativeSlices.add(Math.floor(offset / (width * height)));
    }

    const k = Math.floor(offset / (width * height));
    const remainder = offset - k * width * height;
    const j = Math.floor(remainder / width);
    const i = remainder - j * width;

    for (const [di, dj, dk] of neighborOffsets) {
      const ni = i + di;
      const nj = j + dj;
      const nk = k + dk;
      if (ni < 0 || ni >= width || nj < 0 || nj >= height || nk < 0 || nk >= depth) {
        continue;
      }

      const neighborOffset = toOffset(dimensions, ni, nj, nk);
      if (visited[neighborOffset]) continue;
      visited[neighborOffset] = 1;

      const neighborLabel = labelmapScalarData[neighborOffset];
      if (neighborLabel !== 0 && neighborLabel !== segmentIndex) continue;

      const neighborValue = Number(sourceScalarData[neighborOffset]);
      if (!Number.isFinite(neighborValue) ||
          neighborValue < lowerThreshold || neighborValue > upperThreshold) {
        continue;
      }

      if (tail >= safeMaxVoxels) {
        stoppedByLimit = true;
        continue;
      }
      queue[tail] = neighborOffset;
      tail += 1;
    }
  }

  return {
    seedValue,
    lowerThreshold,
    upperThreshold,
    selectedVoxelCount,
    changedVoxelCount,
    changedVoxelOffsets,
    modifiedNativeSlices: Array.from(modifiedNativeSlices).sort((left, right) => left - right),
    stoppedByLimit,
  };
}

/**
 * Removes only the active segment from a CT-connected region. The seed must
 * already belong to that segment, so an accidental click on an unsegmented
 * voxel cannot erase unrelated labelmap data.
 */
export function eraseLabelmapRegion(
  request: LabelmapRegionEraseRequest
): LabelmapRegionGrowingResult {
  const {
    sourceScalarData,
    labelmapScalarData,
    dimensions,
    seedIJK,
    seedIJKs,
    segmentIndex,
    toleranceHU,
    connectivity,
    maxVoxels,
    setLabelValue,
  } = request;
  const [width, height, depth] = dimensions;
  const candidateSeeds = seedIJKs?.length ? seedIJKs : [seedIJK];
  const validSeedOffsets: number[] = [];
  for (const [seedI, seedJ, seedK] of candidateSeeds) {
    if (
      seedI < 0 || seedI >= width ||
      seedJ < 0 || seedJ >= height ||
      seedK < 0 || seedK >= depth
    ) continue;
    const offset = toOffset(dimensions, seedI, seedJ, seedK);
    if (labelmapScalarData[offset] === segmentIndex) {
      validSeedOffsets.push(offset);
    }
  }
  if (!validSeedOffsets.length) {
    throw new Error('Seleccioná un voxel perteneciente al segmento activo para borrarlo');
  }

  const seedOffset = validSeedOffsets[0];
  const seedValue = Number(sourceScalarData[seedOffset]);
  if (!Number.isFinite(seedValue)) {
    throw new Error('El voxel seleccionado no contiene un valor CT válido');
  }

  const safeTolerance = Math.max(0, Number(toleranceHU) || 0);
  const lowerThreshold = seedValue - safeTolerance;
  const upperThreshold = seedValue + safeTolerance;
  const safeMaxVoxels = Math.max(1, Math.floor(maxVoxels));
  const visited = new Uint8Array(width * height * depth);
  const queue = new Int32Array(safeMaxVoxels);
  const neighborOffsets = getNeighborOffsets(connectivity);
  const modifiedNativeSlices = new Set<number>();
  const changedVoxelOffsets: number[] = [];
  let head = 0;
  let tail = 0;
  let selectedVoxelCount = 0;
  let changedVoxelCount = 0;
  let stoppedByLimit = false;

  for (const offset of validSeedOffsets) {
    if (visited[offset]) continue;
    const value = Number(sourceScalarData[offset]);
    if (!Number.isFinite(value) || value < lowerThreshold || value > upperThreshold) continue;
    if (tail >= safeMaxVoxels) {
      stoppedByLimit = true;
      break;
    }
    visited[offset] = 1;
    queue[tail] = offset;
    tail += 1;
  }

  while (head < tail) {
    const offset = queue[head];
    head += 1;
    selectedVoxelCount += 1;

    if (labelmapScalarData[offset] === segmentIndex) {
      labelmapScalarData[offset] = 0;
      setLabelValue?.(offset, 0);
      changedVoxelCount += 1;
      changedVoxelOffsets.push(offset);
      modifiedNativeSlices.add(Math.floor(offset / (width * height)));
    }

    const k = Math.floor(offset / (width * height));
    const remainder = offset - k * width * height;
    const j = Math.floor(remainder / width);
    const i = remainder - j * width;

    for (const [di, dj, dk] of neighborOffsets) {
      const ni = i + di;
      const nj = j + dj;
      const nk = k + dk;
      if (ni < 0 || ni >= width || nj < 0 || nj >= height || nk < 0 || nk >= depth) {
        continue;
      }

      const neighborOffset = toOffset(dimensions, ni, nj, nk);
      if (visited[neighborOffset]) continue;
      visited[neighborOffset] = 1;

      if (labelmapScalarData[neighborOffset] !== segmentIndex) continue;
      const neighborValue = Number(sourceScalarData[neighborOffset]);
      if (!Number.isFinite(neighborValue) ||
          neighborValue < lowerThreshold || neighborValue > upperThreshold) {
        continue;
      }

      if (tail >= safeMaxVoxels) {
        stoppedByLimit = true;
        continue;
      }
      queue[tail] = neighborOffset;
      tail += 1;
    }
  }

  return {
    seedValue,
    lowerThreshold,
    upperThreshold,
    selectedVoxelCount,
    changedVoxelCount,
    changedVoxelOffsets,
    modifiedNativeSlices: Array.from(modifiedNativeSlices).sort((left, right) => left - right),
    stoppedByLimit,
  };
}
