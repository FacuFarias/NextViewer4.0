import React, { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  RenderingEngine,
  Enums,
  metaData,
  volumeLoader,
  cache,
  setVolumesForViewports,
  eventTarget,
  utilities as csUtils,
} from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import * as polySeg from '@cornerstonejs/polymorphic-segmentation';
import vtkCellPicker from '@kitware/vtk.js/Rendering/Core/CellPicker';
import { DicomInstance, DicomSeries } from '../types/dicom';
import { dicomWebService, mergeDefinedDicomMetadata } from '../services/dicomWeb';
import { localizeError, useTranslation } from '../i18n';
import { CT_SINUSES_FEATURES } from '../services/ctSinusesMeasurements';
import {
  destroyMinicatSegmentation,
  ensureMinicatLabelmap,
  getMinicatLabelmapData,
  importMinicatDICOMSEG,
  isMinicatSegmentLocked,
  MINICAT_VOXEL_SEGMENTATION_ONTOLOGY_VERSION,
  readMinicatDicomSegIdentifiers,
  serializeMinicatSegmentation,
  setActiveMinicatSegment,
  setMinicatSegmentLocked,
  setMinicatSegmentVisibility,
} from '../services/minicatVoxelSegmentation';
import { segmentationObjectService } from '../services/segmentationObjects';
import { SegmentationObject } from '../types/segmentationObjects';
import {
  interpolateLabelmapSegment,
  LabelmapInterpolationAxis,
} from '../services/labelmapInterpolation';
import {
  eraseLabelmapRegion,
  growLabelmapRegion,
  RegionGrowConnectivity,
} from '../services/labelmapRegionGrowing';

interface MPRViewProps {
  studyInstanceUID: string;
  series: DicomSeries;
  onBack: () => void;
  embedded?: boolean;
  nativeImageIndex?: number;
  onNativeSliceChange?: (imageIndex: number) => void;
  voxelSegmentationEnabled?: boolean;
  activeCtSinusesFeatureKey?: string | null;
  onVoxelSegmentationDirty?: (dirty: boolean) => void;
}

const AXIAL_VIEWPORT_ID = 'mpr-axial';
const SAGITTAL_VIEWPORT_ID = 'mpr-sagittal';
const CORONAL_VIEWPORT_ID = 'mpr-coronal';
const VOLUME_3D_VIEWPORT_ID = 'mpr-volume-3d';
const TOOL_GROUP_ID = 'mpr-tool-group';
const VOLUME_3D_TOOL_GROUP_ID = 'mpr-volume-3d-tool-group';
const REGION_GROW_CLICK_DELAY_MS = 250;

type ViewportId = 'axial' | 'sagittal' | 'coronal';

interface SegmentInterpolationTracker {
  axis: LabelmapInterpolationAxis;
  plane: ViewportId;
  anchors: Set<number>;
  generatedOffsets: Set<number>;
}

interface RegionGrowHistoryEntry {
  segmentationId: string;
  segmentIndex: number;
  operation: 'grow' | 'erase';
  changedVoxelOffsets: number[];
  modifiedNativeSlices: number[];
}

interface RegionEraserCursor {
  plane: ViewportId;
  left: number;
  top: number;
  radius: number;
}

const VIEWPORT_CONFIG: Record<ViewportId, {
  id: string;
  label: string;
  orientation: Enums.OrientationAxis;
}> = {
  axial: {
    id: AXIAL_VIEWPORT_ID,
    label: 'Axial',
    orientation: Enums.OrientationAxis.AXIAL,
  },
  sagittal: {
    id: SAGITTAL_VIEWPORT_ID,
    label: 'Sagital',
    orientation: Enums.OrientationAxis.SAGITTAL,
  },
  coronal: {
    id: CORONAL_VIEWPORT_ID,
    label: 'Coronal',
    orientation: Enums.OrientationAxis.CORONAL,
  },
};

const VIEWPORT_ORDER: ViewportId[] = ['axial', 'sagittal', 'coronal'];
const MPR_VIEWPORT_IDS = VIEWPORT_ORDER.map(plane => VIEWPORT_CONFIG[plane].id);
const ALL_VIEWPORT_IDS = [...MPR_VIEWPORT_IDS, VOLUME_3D_VIEWPORT_ID];

function getLabelmapOffset(
  dimensions: [number, number, number],
  i: number,
  j: number,
  k: number
): number {
  return i + dimensions[0] * (j + dimensions[1] * k);
}

function findClosestActiveLabelmapVoxel(
  imageData: any,
  dimensions: [number, number, number],
  scalarData: Uint8Array,
  segmentIndex: number,
  worldPoint: [number, number, number],
  maxIndexRadius = 3
): [number, number, number] | null {
  const continuousIJK = csUtils.transformWorldToIndexContinuous(imageData, worldPoint);
  if (!continuousIJK?.every(Number.isFinite)) return null;

  const center: [number, number, number] = [
    Math.round(continuousIJK[0]),
    Math.round(continuousIJK[1]),
    Math.round(continuousIJK[2]),
  ];
  let closest: [number, number, number] | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let dk = -maxIndexRadius; dk <= maxIndexRadius; dk += 1) {
    for (let dj = -maxIndexRadius; dj <= maxIndexRadius; dj += 1) {
      for (let di = -maxIndexRadius; di <= maxIndexRadius; di += 1) {
        const i = center[0] + di;
        const j = center[1] + dj;
        const k = center[2] + dk;
        if (
          i < 0 || i >= dimensions[0] ||
          j < 0 || j >= dimensions[1] ||
          k < 0 || k >= dimensions[2]
        ) continue;

        if (scalarData[getLabelmapOffset(dimensions, i, j, k)] !== segmentIndex) continue;
        const candidateIJK: [number, number, number] = [i, j, k];
        const candidateWorld = imageData.indexToWorld?.(candidateIJK) as number[] | undefined;
        const distance = candidateWorld?.length === 3
          ? (candidateWorld[0] - worldPoint[0]) ** 2 +
            (candidateWorld[1] - worldPoint[1]) ** 2 +
            (candidateWorld[2] - worldPoint[2]) ** 2
          : di ** 2 + dj ** 2 + dk ** 2;
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = candidateIJK;
        }
      }
    }
  }

  return closest;
}

const mprImagePlaneMetadata = new Map<string, Record<string, any>>();
let mprMetadataProviderRegistered = false;

function registerMprImagePlaneMetadata(
  imageIds: string[],
  instances: DicomInstance[]
): void {
  if (!mprMetadataProviderRegistered) {
    metaData.addProvider((type: string, imageId: string) => {
      if (type !== 'imagePlaneModule') return undefined;
      return mprImagePlaneMetadata.get(imageId);
    }, 10000);
    mprMetadataProviderRegistered = true;
  }

  imageIds.forEach((imageId, index) => {
    const instance = instances[index];
    if (!instance) return;
    mprImagePlaneMetadata.set(imageId, {
      frameOfReferenceUID: instance.frameOfReferenceUID,
      rows: instance.rows,
      columns: instance.columns,
      imagePositionPatient: instance.imagePositionPatient,
      imageOrientationPatient: instance.imageOrientationPatient,
      rowCosines: instance.imageOrientationPatient?.slice(0, 3),
      columnCosines: instance.imageOrientationPatient?.slice(3, 6),
      pixelSpacing: instance.pixelSpacing,
      sliceThickness: instance.pixelSpacing?.[2],
    });
  });
}

function validVector(values: number[] | undefined, length: number): values is number[] {
  return Boolean(values && values.length >= length && values.slice(0, length).every(Number.isFinite));
}

function hasCompleteImageGeometry(instance: DicomInstance | undefined): boolean {
  return Boolean(
    instance &&
    validVector(instance.imagePositionPatient, 3) &&
    validVector(instance.imageOrientationPatient, 6) &&
    validVector(instance.pixelSpacing, 2)
  );
}

function crossProduct(a: number[], b: number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dotProduct(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeVector(vector: number[]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function getImageCenterWorld(instance: DicomInstance): [number, number, number] | null {
  const position = instance.imagePositionPatient;
  const orientation = instance.imageOrientationPatient;
  const spacing = instance.pixelSpacing;
  if (!validVector(position, 3) || !validVector(orientation, 6) || !validVector(spacing, 2)) {
    return null;
  }

  const row = orientation.slice(0, 3);
  const column = orientation.slice(3, 6);
  // In DICOM, the first PixelSpacing value belongs to the column direction
  // (the second IOP triplet) and the second value to the row direction (the
  // first IOP triplet). Keeping those paired correctly is important when the
  // native stack is itself coronal or sagittal.
  const rowOffset = ((instance.columns || 0) - 1) * spacing[1] / 2;
  const columnOffset = ((instance.rows || 0) - 1) * spacing[0] / 2;
  return [
    position[0] + row[0] * rowOffset + column[0] * columnOffset,
    position[1] + row[1] * rowOffset + column[1] * columnOffset,
    position[2] + row[2] * rowOffset + column[2] * columnOffset,
  ];
}

function getNearestSliceIndex(worldPoint: number[], instances: DicomInstance[], fallback: number): number {
  const reference = instances.find(instance =>
    validVector(instance.imagePositionPatient, 3) &&
    validVector(instance.imageOrientationPatient, 6)
  );
  if (!reference?.imagePositionPatient || !reference.imageOrientationPatient) return fallback;

  const normal = normalizeVector(crossProduct(
    reference.imageOrientationPatient.slice(0, 3),
    reference.imageOrientationPatient.slice(3, 6)
  ));
  let nearestIndex = fallback;
  let nearestDistance = Number.POSITIVE_INFINITY;
  instances.forEach((instance, index) => {
    const position = instance.imagePositionPatient;
    if (!validVector(position, 3)) return;
    const distance = Math.abs(dotProduct(
      worldPoint.map((value, component) => value - position[component]),
      normal
    ));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

async function prepareMprInstances(
  studyInstanceUID: string,
  series: DicomSeries
): Promise<DicomInstance[]> {
  const sourceInstances = series.instances;
  let enriched = sourceInstances;

  const completeMissingGeometryFromInstances = async (
    instances: DicomInstance[]
  ): Promise<DicomInstance[]> => {
    const missingIndexes = instances
      .map((instance, index) => hasCompleteImageGeometry(instance) ? -1 : index)
      .filter(index => index >= 0);
    if (missingIndexes.length === 0) return instances;

    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < missingIndexes.length) {
        const index = missingIndexes[nextIndex++];
        const instance = instances[index];
        const metadata = await dicomWebService.getInstanceMetadata(
          studyInstanceUID,
          series.seriesInstanceUID,
          instance.sopInstanceUID
        );
        instances[index] = mergeDefinedDicomMetadata(instance, metadata);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(8, missingIndexes.length) }, () => worker())
    );
    return instances;
  };

  // ImagePositionPatient is different for every slice. If QIDO omitted it,
  // copying the first slice position to the whole volume (or interpolating
  // with an arbitrary 1 mm spacing) produces visibly stretched MPR planes.
  // Prefer the WADO-RS series metadata endpoint, which returns all positions
  // in one HTTP response.
  const needsSeriesMetadata = sourceInstances.some(instance =>
    !validVector(instance.imagePositionPatient, 3) ||
    !validVector(instance.imageOrientationPatient, 6) ||
    !validVector(instance.pixelSpacing, 2)
  );
  if (needsSeriesMetadata) {
    try {
      const seriesMetadata = await dicomWebService.getSeriesMetadata(
        studyInstanceUID,
        series.seriesInstanceUID
      );
      const metadataBySop = new Map(
        seriesMetadata
          .filter(metadata => Boolean(metadata.sopInstanceUID))
          .map(metadata => [metadata.sopInstanceUID, metadata])
      );
      enriched = sourceInstances.map((instance, index) => mergeDefinedDicomMetadata(
        instance,
        metadataBySop.get(instance.sopInstanceUID) || seriesMetadata[index]
      ));
      console.info('[MPR] metadata de serie cargada', {
        requested: sourceInstances.length,
        received: seriesMetadata.length,
        complete: enriched.filter(hasCompleteImageGeometry).length,
      });
    } catch (error) {
      console.warn('[MPR] no se pudo cargar metadata completa de la serie; se usará fallback', error);
    }

    // Some PACS implementations expose the series endpoint but return only
    // partial datasets. Complete only the missing slices, with bounded
    // concurrency, so the common path remains a single fast request while
    // the fallback still preserves the real slice positions.
    if (enriched.some(instance => !hasCompleteImageGeometry(instance))) {
      enriched = await completeMissingGeometryFromInstances([...enriched]);
    }
  }

  let referenceIndex = enriched.findIndex(hasCompleteImageGeometry);
  let reference = referenceIndex >= 0 ? enriched[referenceIndex] : undefined;

  // QIDO normally contains all image-plane attributes because the request
  // asks for them explicitly.  Some DICOMweb deployments still omit them,
  // though.  One metadata request is enough to obtain the series geometry;
  // requesting metadata for all 300-400 slices makes the viewer feel frozen
  // and provides no additional information for a regular single-frame CT.
  if (!reference && enriched[0]) {
    const firstInstance = enriched[0];
    try {
      const metadata = await dicomWebService.getInstanceMetadata(
        studyInstanceUID,
        series.seriesInstanceUID,
        firstInstance.sopInstanceUID
      );
      const candidate = { ...firstInstance, ...metadata };

      if (hasCompleteImageGeometry(candidate)) {
        reference = candidate;
        referenceIndex = 0;
      } else {
        // If the first metadata response is incomplete, combine its useful
        // orientation/spacing with a valid position from QIDO when possible.
        const orientation = validVector(candidate.imageOrientationPatient, 6)
          ? candidate.imageOrientationPatient
          : enriched.find(instance => validVector(instance.imageOrientationPatient, 6))?.imageOrientationPatient;
        const pixelSpacing = validVector(candidate.pixelSpacing, 2)
          ? candidate.pixelSpacing
          : enriched.find(instance => validVector(instance.pixelSpacing, 2))?.pixelSpacing;
        const positionIndex = validVector(candidate.imagePositionPatient, 3)
          ? 0
          : enriched.findIndex(instance => validVector(instance.imagePositionPatient, 3));
        const position = positionIndex >= 0
          ? (positionIndex === 0 ? candidate.imagePositionPatient : enriched[positionIndex].imagePositionPatient)
          : undefined;

        if (validVector(position, 3) && validVector(orientation, 6) && validVector(pixelSpacing, 2)) {
          reference = {
            ...enriched[positionIndex],
            ...(positionIndex === 0 ? candidate : {}),
            imagePositionPatient: position,
            imageOrientationPatient: orientation,
            pixelSpacing,
          };
          referenceIndex = positionIndex;
        }
      }
    } catch (error) {
      console.warn('[MPR] no se pudo completar la geometría con el primer slice', {
        sopInstanceUID: firstInstance.sopInstanceUID,
        error,
      });
    }
  }

  if (!reference) {
    throw new Error('La serie no contiene ImagePositionPatient, ImageOrientationPatient y PixelSpacing válidos para MPR');
  }

  const completed = enriched.map((instance, index) => {
    const merged = index === referenceIndex ? { ...instance, ...reference } : instance;
    return {
      ...merged,
      imageOrientationPatient: validVector(merged.imageOrientationPatient, 6)
        ? merged.imageOrientationPatient
        : [...reference!.imageOrientationPatient!],
      pixelSpacing: validVector(merged.pixelSpacing, 2)
        ? merged.pixelSpacing
        : [...reference!.pixelSpacing!],
    };
  });

  const orientation = reference.imageOrientationPatient!;
  const row = orientation.slice(0, 3);
  const column = orientation.slice(3, 6);
  const normal = normalizeVector(crossProduct(row, column));
  const positions = completed.map(instance => instance.imagePositionPatient);
  const validPositionIndexes = positions
    .map((position, index) => validVector(position, 3) ? index : -1)
    .filter(index => index >= 0);

  const spacingCandidates: number[] = [];
  for (let index = 1; index < validPositionIndexes.length; index += 1) {
    const previousIndex = validPositionIndexes[index - 1];
    const currentIndex = validPositionIndexes[index];
    const previous = positions[previousIndex]!;
    const current = positions[currentIndex]!;
    const distance = Math.abs(dotProduct(
      current.map((value, component) => value - previous[component]),
      normal
    ));
    const indexDistance = currentIndex - previousIndex;
    if (distance > 0 && indexDistance > 0) spacingCandidates.push(distance / indexDistance);
  }
  const sliceSpacing = spacingCandidates.length
    ? spacingCandidates.reduce((sum, value) => sum + value, 0) / spacingCandidates.length
    : 1;

  let interpolatedPositionCount = 0;
  const repaired = completed.map((instance, index) => {
    const position = positions[index];
    if (validVector(position, 3)) {
      return {
        ...instance,
      };
    }

    const previousIndex = validPositionIndexes.filter(validIndex => validIndex < index).pop();
    const nextIndex = validPositionIndexes.find(validIndex => validIndex > index);
    let repairedPosition: number[];
    if (previousIndex !== undefined && nextIndex !== undefined) {
      const previous = positions[previousIndex]!;
      const next = positions[nextIndex]!;
      const ratio = (index - previousIndex) / (nextIndex - previousIndex);
      repairedPosition = previous.map((value, component) =>
        value + (next[component] - value) * ratio
      );
    } else {
      const anchorIndex = previousIndex ?? nextIndex ?? validPositionIndexes[0];
      const anchor = positions[anchorIndex!]!;
      const delta = index - anchorIndex!;
      repairedPosition = anchor.map((value, component) =>
        value + normal[component] * sliceSpacing * delta
      );
    }

    interpolatedPositionCount += 1;
    return {
      ...instance,
      imagePositionPatient: repairedPosition,
    };
  });

  if (interpolatedPositionCount > 0) {
    console.info('[MPR] posiciones de slices interpoladas', {
      interpolated: interpolatedPositionCount,
      total: repaired.length,
    });
  }

  return repaired;
}

function getMprVolumeId(studyInstanceUID: string, seriesInstanceUID: string): string {
  return `mpr-volume:${studyInstanceUID}:${seriesInstanceUID}`;
}

const MPRView: React.FC<MPRViewProps> = ({
  studyInstanceUID,
  series,
  onBack,
  embedded = false,
  nativeImageIndex = 0,
  onNativeSliceChange,
  voxelSegmentationEnabled = false,
  activeCtSinusesFeatureKey = null,
  onVoxelSegmentationDirty,
}) => {
  const { t } = useTranslation();
  const viewportRefs = useRef<Record<ViewportId, HTMLDivElement | null>>({
    axial: null,
    sagittal: null,
    coronal: null,
  });
  const preparedInstancesRef = useRef<DicomInstance[]>([]);
  const sourceImageIdsRef = useRef<string[]>([]);
  const focusedViewportRef = useRef<ViewportId>('axial');
  const volume3DViewportRef = useRef<HTMLDivElement | null>(null);
  const regionGrowClickTimerRef = useRef<number | null>(null);
  const lastNativeSliceRef = useRef<number>(nativeImageIndex);
  const synchronizingMprRef = useRef(false);
  const renderingEngineRef = useRef<RenderingEngine | null>(null);
  const toolGroupRef = useRef<any>(null);
  const volume3DToolGroupRef = useRef<any>(null);
  const initializationGenerationRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maximizedViewport, setMaximizedViewport] = useState<ViewportId | null>(null);
  const [showVolume3D, setShowVolume3D] = useState(false);
  const [activeTool, setActiveTool] = useState<string>('WindowLevel');
  const [brushSize, setBrushSize] = useState(25);
  const [autoInterpolationEnabled, setAutoInterpolationEnabled] = useState(true);
  const [interpolationBusy, setInterpolationBusy] = useState(false);
  const [interpolationStatus, setInterpolationStatus] = useState<string | null>(null);
  const [regionGrowTolerance, setRegionGrowTolerance] = useState(50);
  const [regionGrowConnectivity, setRegionGrowConnectivity] = useState<RegionGrowConnectivity>(6);
  const [regionGrowBusy, setRegionGrowBusy] = useState(false);
  const [regionGrowStatus, setRegionGrowStatus] = useState<string | null>(null);
  const [regionEraserCursor, setRegionEraserCursor] = useState<RegionEraserCursor | null>(null);
  const [segmentationReady, setSegmentationReady] = useState(false);
  const [segmentationError, setSegmentationError] = useState<string | null>(null);
  const [segmentationDirty, setSegmentationDirty] = useState(false);
  const [savedSegmentations, setSavedSegmentations] = useState<SegmentationObject[]>([]);
  const [selectedSavedSegmentationId, setSelectedSavedSegmentationId] = useState('');
  const [segmentationBusy, setSegmentationBusy] = useState(false);
  const [segmentationOperationError, setSegmentationOperationError] = useState<string | null>(null);
  const [activeSegmentLocked, setActiveSegmentLocked] = useState(false);
  const [activeSegmentVisible, setActiveSegmentVisible] = useState(true);
  const [surface3DStatus, setSurface3DStatus] = useState<'idle' | 'building' | 'ready'>('idle');
  const [annotationToolbarHost, setAnnotationToolbarHost] = useState<HTMLElement | null>(null);
  const segmentationIdRef = useRef<string | null>(null);
  const interpolationTrackersRef = useRef<Map<number, SegmentInterpolationTracker>>(new Map());
  const interpolationInProgressRef = useRef(false);
  const regionGrowUndoStackRef = useRef<RegionGrowHistoryEntry[]>([]);
  const regionGrowRedoStackRef = useRef<RegionGrowHistoryEntry[]>([]);
  const volumeId = getMprVolumeId(studyInstanceUID, series.seriesInstanceUID);

  const activeCtSinusesFeature = CT_SINUSES_FEATURES.find(feature =>
    feature.key === activeCtSinusesFeatureKey
  ) || CT_SINUSES_FEATURES[0];

  useEffect(() => {
    setRegionGrowTolerance(activeCtSinusesFeature.regionGrowToleranceHU);
    setRegionGrowStatus(null);
    if (regionGrowClickTimerRef.current !== null) {
      window.clearTimeout(regionGrowClickTimerRef.current);
      regionGrowClickTimerRef.current = null;
    }
  }, [activeCtSinusesFeature.key, activeCtSinusesFeature.regionGrowToleranceHU]);

  useEffect(() => {
    if (activeTool !== 'RegionGrow' && activeTool !== 'Eraser' && regionGrowClickTimerRef.current !== null) {
      window.clearTimeout(regionGrowClickTimerRef.current);
      regionGrowClickTimerRef.current = null;
    }
  }, [activeTool]);

  useEffect(() => () => {
    if (regionGrowClickTimerRef.current !== null) {
      window.clearTimeout(regionGrowClickTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!embedded) return;
    const host = document.getElementById('mpr-annotation-toolbar-slot');
    setAnnotationToolbarHost(host);
    return () => setAnnotationToolbarHost(null);
  }, [embedded]);

  const handleDoubleClick = useCallback((viewportId: ViewportId) => {
    if (regionGrowClickTimerRef.current !== null) {
      window.clearTimeout(regionGrowClickTimerRef.current);
      regionGrowClickTimerRef.current = null;
    }
    focusedViewportRef.current = viewportId;
    setMaximizedViewport(prev => prev === viewportId ? null : viewportId);
    if (activeTool === 'RegionGrow' || activeTool === 'Eraser') {
      setRegionGrowStatus(
        activeTool === 'Eraser'
          ? 'Doble clic: zoom aplicado, sin borrar la segmentación'
          : 'Doble clic: zoom aplicado, sin modificar la segmentación'
      );
    }
  }, [activeTool]);

  useEffect(() => {
    if (isLoading) return;

    const timer = window.setTimeout(() => {
      const renderingEngine = renderingEngineRef.current;
      if (!renderingEngine) return;

      renderingEngine.resize(false, true);
      VIEWPORT_ORDER.forEach(plane => {
        const viewport = renderingEngine.getViewport(VIEWPORT_CONFIG[plane].id) as any;
        if (!viewport) return;

        if (maximizedViewport === plane) {
          // resize() preserves the old parallel scale. A plane rendered in a
          // small tile would otherwise remain tiny after maximization.
          viewport.resetCamera({ resetPan: true, resetZoom: true });
        } else {
          viewport.resetCameraForResize?.();
        }
      });
      if (showVolume3D) {
        const volumeViewport = renderingEngine.getViewport(VOLUME_3D_VIEWPORT_ID) as any;
        volumeViewport?.resetCameraForResize?.();
      }
      renderingEngine.renderViewports(ALL_VIEWPORT_IDS);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [isLoading, maximizedViewport, showVolume3D]);

  const adjustStandardZoom = useCallback((factor: number) => {
    const renderingEngine = renderingEngineRef.current;
    if (!renderingEngine) return;

    const viewportId = showVolume3D
      ? VOLUME_3D_VIEWPORT_ID
      : VIEWPORT_CONFIG[maximizedViewport || focusedViewportRef.current].id;
    const viewport = renderingEngine.getViewport(viewportId) as any;
    if (!viewport?.getZoom || !viewport?.setZoom) return;

    const currentZoom = Number(viewport.getZoom()) || 1;
    viewport.setZoom(Math.max(0.1, Math.min(20, currentZoom * factor)));
    viewport.render();
  }, [maximizedViewport, showVolume3D]);

  const resetStandardZoom = useCallback(() => {
    const renderingEngine = renderingEngineRef.current;
    if (!renderingEngine) return;

    const viewportId = showVolume3D
      ? VOLUME_3D_VIEWPORT_ID
      : VIEWPORT_CONFIG[maximizedViewport || focusedViewportRef.current].id;
    const viewport = renderingEngine.getViewport(viewportId) as any;
    viewport?.resetCamera?.({ resetPan: true, resetZoom: true });
    viewport?.render?.();
  }, [maximizedViewport, showVolume3D]);

  const toggleVolume3D = useCallback(() => {
    if (showVolume3D) {
      setShowVolume3D(false);
      return;
    }

    const segmentationId = segmentationIdRef.current;
    if (!segmentationReady || !segmentationId) return;

    const { scalarData } = getMinicatLabelmapData(segmentationId);
    const hasPaintedVoxels = scalarData.some(value => value !== 0);
    if (!hasPaintedVoxels) {
      setSegmentationOperationError('Pinta al menos un voxel antes de generar el volumen 3D.');
      return;
    }

    setSegmentationOperationError(null);
    setSurface3DStatus('building');
    setShowVolume3D(true);
  }, [segmentationReady, showVolume3D]);

  const setActiveAnnotationTool = useCallback((toolName: string) => {
    if (!toolGroupRef.current) return;

    const { WindowLevelTool, BrushTool } = cornerstoneTools;
    const supportedTools = [WindowLevelTool.toolName, BrushTool.toolName];
    const nextTool = supportedTools.includes(toolName)
      ? toolName
      : WindowLevelTool.toolName;

    supportedTools.forEach(candidate => toolGroupRef.current.setToolPassive(candidate));
    toolGroupRef.current.setToolActive(nextTool, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });

    if (nextTool === BrushTool.toolName) {
      const brush = toolGroupRef.current.getToolInstance?.(BrushTool.toolName);
      brush?.setActiveStrategy?.('FILL_INSIDE_CIRCLE');
    }

    setActiveTool(nextTool);
  }, []);

  const setVoxelSegmentationTool = useCallback((toolName: 'Brush' | 'Eraser' | 'BrushEraser' | 'WindowLevel' | 'RegionGrow') => {
    if (!toolGroupRef.current || !segmentationReady) return;
    const { WindowLevelTool, BrushTool } = cornerstoneTools;
    const brush = toolGroupRef.current.getToolInstance?.(BrushTool.toolName);
    if (toolName === 'RegionGrow' || toolName === 'Eraser') {
      [WindowLevelTool.toolName, BrushTool.toolName].forEach(candidate => {
        toolGroupRef.current?.setToolPassive(candidate);
      });
      setActiveTool(toolName);
      setRegionGrowStatus(
        toolName === 'Eraser'
          ? 'Un clic sobre un segmento en MPR o 3D para borrarlo · doble clic reservado para zoom'
          : 'Un clic para crecer · doble clic reservado para zoom'
      );
      setSegmentationOperationError(null);
      return;
    }
    const nextTool = toolName === 'BrushEraser' ? BrushTool.toolName : toolName;

    [WindowLevelTool.toolName, BrushTool.toolName].forEach(candidate => {
      toolGroupRef.current.setToolPassive(candidate);
    });

    if (nextTool === BrushTool.toolName) {
      brush?.setActiveStrategy?.(
        toolName === 'BrushEraser' ? 'ERASE_INSIDE_CIRCLE' : 'FILL_INSIDE_CIRCLE'
      );
    }
    toolGroupRef.current.setToolActive(nextTool, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
    setActiveTool(toolName);
  }, [segmentationReady]);

  const updateBrushSize = useCallback((value: number) => {
    const safeValue = Math.max(1, Math.min(256, Math.round(value)));
    setBrushSize(safeValue);
    cornerstoneTools.utilities.segmentation.setBrushSizeForToolGroup(
      TOOL_GROUP_ID,
      safeValue,
      cornerstoneTools.BrushTool.toolName
    );
  }, []);

  useEffect(() => {
    const volume3DToolGroup = volume3DToolGroupRef.current;
    if (!volume3DToolGroup) return;

    const { TrackballRotateTool } = cornerstoneTools;
    volume3DToolGroup.setToolPassive(TrackballRotateTool.toolName);
    if (activeTool !== 'RegionGrow' && activeTool !== 'Eraser') {
      volume3DToolGroup.setToolActive(TrackballRotateTool.toolName, {
        bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
      });
    }
  }, [activeTool, segmentationReady, showVolume3D]);

  const applyRegionGrowHistory = useCallback((
    entry: RegionGrowHistoryEntry,
    forward: boolean
  ): boolean => {
    if (segmentationIdRef.current !== entry.segmentationId) return false;
    const labelmap = getMinicatLabelmapData(entry.segmentationId);
    const growsSegment = entry.operation === 'grow';
    const targetValue = forward === growsSegment ? entry.segmentIndex : 0;
    const expectedValue = forward === growsSegment ? 0 : entry.segmentIndex;
    let changed = false;

    entry.changedVoxelOffsets.forEach(offset => {
      if (labelmap.scalarData[offset] !== expectedValue) return;
      labelmap.scalarData[offset] = targetValue;
      labelmap.volume.voxelManager.setAtIndex(offset, targetValue);
      changed = true;
    });

    if (!changed) return false;
    labelmap.volume.modified();
    cornerstoneTools.segmentation.triggerSegmentationEvents
      .triggerSegmentationDataModified(
        entry.segmentationId,
        entry.modifiedNativeSlices,
        entry.segmentIndex
      );
    renderingEngineRef.current?.renderViewports(MPR_VIEWPORT_IDS);
    return true;
  }, []);

  const undoRegionGrow = useCallback(() => {
    const entry = regionGrowUndoStackRef.current.pop();
    if (!entry) {
      setRegionGrowStatus('No hay un Grow para deshacer');
      return;
    }

    if (applyRegionGrowHistory(entry, false)) {
      regionGrowRedoStackRef.current.push(entry);
      const operationLabel = entry.operation === 'erase' ? 'Eraser' : 'Grow';
      setRegionGrowStatus(`${operationLabel} deshecho · ${entry.changedVoxelOffsets.length.toLocaleString()} voxels`);
    } else {
      setRegionGrowStatus('No se pudo deshacer el Grow porque sus voxels cambiaron');
    }
  }, [applyRegionGrowHistory]);

  const redoRegionGrow = useCallback(() => {
    const entry = regionGrowRedoStackRef.current.pop();
    if (!entry) {
      setRegionGrowStatus('No hay un Grow para rehacer');
      return;
    }

    if (applyRegionGrowHistory(entry, true)) {
      regionGrowUndoStackRef.current.push(entry);
      const operationLabel = entry.operation === 'erase' ? 'Eraser' : 'Grow';
      setRegionGrowStatus(`${operationLabel} rehecho · ${entry.changedVoxelOffsets.length.toLocaleString()} voxels`);
    } else {
      setRegionGrowStatus('No se pudo rehacer el Grow porque sus voxels cambiaron');
    }
  }, [applyRegionGrowHistory]);

  const undoVoxelEdit = useCallback(() => {
    if (activeTool === 'RegionGrow' || activeTool === 'Eraser') {
      undoRegionGrow();
      return;
    }
    const brush = toolGroupRef.current?.getToolInstance?.(cornerstoneTools.BrushTool.toolName);
    brush?.undo?.();
  }, [activeTool, undoRegionGrow]);

  const redoVoxelEdit = useCallback(() => {
    if (activeTool === 'RegionGrow' || activeTool === 'Eraser') {
      redoRegionGrow();
      return;
    }
    const brush = toolGroupRef.current?.getToolInstance?.(cornerstoneTools.BrushTool.toolName);
    brush?.redo?.();
  }, [activeTool, redoRegionGrow]);

  const handleRegionGrow = useCallback((
    plane: ViewportId,
    element: HTMLDivElement,
    clientX: number,
    clientY: number,
    worldPointOverride?: [number, number, number],
    eraseSeedIJKsOverride?: Array<[number, number, number]>
  ) => {
    focusedViewportRef.current = plane;

    const segmentationId = segmentationIdRef.current;
    const eraseMode = activeTool === 'Eraser';
    if (!segmentationId || !segmentationReady || regionGrowBusy) return;
    if (activeSegmentLocked) {
      setSegmentationOperationError(
        'El segmento activo está bloqueado. Desbloquéalo antes de crecer la región.'
      );
      return;
    }

    try {
      setRegionGrowBusy(true);
      setSegmentationOperationError(null);
      const sourceVolume = cache.getVolume(volumeId) as any;
      const labelmap = getMinicatLabelmapData(segmentationId);
      if (!sourceVolume?.imageData || !labelmap.volume?.imageData) {
        throw new Error('El volumen CT o el Labelmap todavía no están disponibles');
      }
      if (sourceVolume.dimensions.some(
        (value: number, index: number) => value !== labelmap.dimensions[index]
      )) {
        throw new Error('El volumen CT y el Labelmap no tienen la misma geometría');
      }

      const viewport = renderingEngineRef.current?.getViewport(VIEWPORT_CONFIG[plane].id) as any;
      let worldPoint = worldPointOverride;
      if (!worldPoint) {
        const rect = element.getBoundingClientRect();
        const canvas = viewport?.canvas;
        if (!canvas || rect.width <= 0 || rect.height <= 0) {
          throw new Error('El viewport MPR todavía no tiene un canvas válido');
        }

        const canvasPoint: [number, number] = [
          (clientX - rect.left) * (canvas.width / rect.width),
          (clientY - rect.top) * (canvas.height / rect.height),
        ];
        worldPoint = viewport.canvasToWorld(canvasPoint) as [number, number, number];
      }
      const seedIJK = csUtils.transformWorldToIndex(
        labelmap.volume.imageData,
        worldPoint
      ) as [number, number, number];
      const sourceScalarData = sourceVolume.voxelManager.getCompleteScalarDataArray();
      let eraseSeedIJKs: Array<[number, number, number]> | undefined = eraseSeedIJKsOverride;
      if (eraseMode && !eraseSeedIJKsOverride) {
        const centerIJK = csUtils.transformWorldToIndexContinuous(
          labelmap.volume.imageData,
          worldPoint
        );
        const camera = viewport.getCamera?.();
        let sliceAxis: number = plane === 'axial' ? 2 : plane === 'sagittal' ? 0 : 1;
        if (camera) {
          const { ijkVecSliceDir } = csUtils.getVolumeDirectionVectors(
            labelmap.volume.imageData,
            camera
          );
          const absoluteDirection = Array.from(ijkVecSliceDir, value => Math.abs(Number(value)));
          sliceAxis = absoluteDirection.indexOf(Math.max(...absoluteDirection));
        }

        const inPlaneAxes = [0, 1, 2].filter(axis => axis !== sliceAxis);
        const [firstAxis, secondAxis] = inPlaneAxes;
        const spacing = labelmap.spacing;
        const radiusWorld = Math.max(0.5, brushSize);
        const firstRadius = Math.ceil(radiusWorld / Math.max(Number(spacing[firstAxis]) || 0.001, 0.001));
        const secondRadius = Math.ceil(radiusWorld / Math.max(Number(spacing[secondAxis]) || 0.001, 0.001));
        const seeds = new Map<number, [number, number, number]>();

        for (let firstOffset = -firstRadius; firstOffset <= firstRadius; firstOffset += 1) {
          for (let secondOffset = -secondRadius; secondOffset <= secondRadius; secondOffset += 1) {
            const distanceWorld = Math.sqrt(
              (firstOffset * Number(spacing[firstAxis])) ** 2 +
              (secondOffset * Number(spacing[secondAxis])) ** 2
            );
            if (distanceWorld > radiusWorld) continue;

            const candidate: [number, number, number] = [
              Math.round(centerIJK[0]),
              Math.round(centerIJK[1]),
              Math.round(centerIJK[2]),
            ];
            candidate[firstAxis] = Math.round(centerIJK[firstAxis] + firstOffset);
            candidate[secondAxis] = Math.round(centerIJK[secondAxis] + secondOffset);
            candidate[sliceAxis] = Math.round(centerIJK[sliceAxis]);
            if (
              candidate[0] < 0 || candidate[0] >= labelmap.dimensions[0] ||
              candidate[1] < 0 || candidate[1] >= labelmap.dimensions[1] ||
              candidate[2] < 0 || candidate[2] >= labelmap.dimensions[2]
            ) continue;

            const offset = candidate[0] + labelmap.dimensions[0] * (
              candidate[1] + labelmap.dimensions[1] * candidate[2]
            );
            if (labelmap.scalarData[offset] === activeCtSinusesFeature.segmentIndex) {
              seeds.set(offset, candidate);
            }
          }
        }
        eraseSeedIJKs = Array.from(seeds.values());
      }

      const regionRequest = {
        sourceScalarData,
        labelmapScalarData: labelmap.scalarData,
        dimensions: labelmap.dimensions,
        seedIJK,
        segmentIndex: activeCtSinusesFeature.segmentIndex,
        toleranceHU: regionGrowTolerance,
        connectivity: regionGrowConnectivity,
        maxVoxels: 500_000,
        ...(eraseSeedIJKs ? { seedIJKs: eraseSeedIJKs } : {}),
        setLabelValue: (offset: number, value: number) => {
          labelmap.volume.voxelManager.setAtIndex(offset, value);
        },
      };
      const result = eraseMode
        ? eraseLabelmapRegion(regionRequest)
        : growLabelmapRegion(regionRequest);

      if (result.changedVoxelCount > 0) {
        regionGrowUndoStackRef.current.push({
          segmentationId,
          segmentIndex: activeCtSinusesFeature.segmentIndex,
          operation: eraseMode ? 'erase' : 'grow',
          changedVoxelOffsets: result.changedVoxelOffsets,
          modifiedNativeSlices: result.modifiedNativeSlices,
        });
        regionGrowRedoStackRef.current = [];
        labelmap.volume.modified();
        cornerstoneTools.segmentation.triggerSegmentationEvents
          .triggerSegmentationDataModified(
            segmentationId,
            result.modifiedNativeSlices,
            activeCtSinusesFeature.segmentIndex
          );
        renderingEngineRef.current?.renderViewports(MPR_VIEWPORT_IDS);
      }

      const operationLabel = eraseMode ? 'Borrados' : 'Pintados';
      setRegionGrowStatus(
        `${operationLabel}: ${result.changedVoxelCount.toLocaleString()} voxels · HU ${Math.round(result.lowerThreshold)}–${Math.round(result.upperThreshold)}${result.stoppedByLimit ? ' · límite alcanzado' : ''}`
      );
      console.info('[MPR][RegionGrow] completed', {
        segmentationId,
        plane,
        source: worldPointOverride ? '3d' : 'mpr',
        mode: eraseMode ? 'erase' : 'grow',
        seedIJK,
        segmentIndex: activeCtSinusesFeature.segmentIndex,
        connectivity: regionGrowConnectivity,
        toleranceHU: regionGrowTolerance,
        seedValue: result.seedValue,
        lowerThreshold: result.lowerThreshold,
        upperThreshold: result.upperThreshold,
        selectedVoxelCount: result.selectedVoxelCount,
        changedVoxelCount: result.changedVoxelCount,
        modifiedNativeSlices: result.modifiedNativeSlices,
        stoppedByLimit: result.stoppedByLimit,
      });
    } catch (error) {
      console.error('[MPR][RegionGrow] failed', error);
      setRegionGrowStatus(null);
      setSegmentationOperationError(
        error instanceof Error ? error.message : 'No se pudo crecer la región'
      );
    } finally {
      setRegionGrowBusy(false);
    }
  }, [
    activeCtSinusesFeature,
    activeSegmentLocked,
    activeTool,
    brushSize,
    regionGrowBusy,
    regionGrowConnectivity,
    regionGrowTolerance,
    segmentationReady,
    volumeId,
  ]);

  const handleVolume3DClick = useCallback((
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (activeTool !== 'RegionGrow' && activeTool !== 'Eraser') return;

    const segmentationId = segmentationIdRef.current;
    const renderingEngine = renderingEngineRef.current;
    const viewport = renderingEngine?.getViewport(VOLUME_3D_VIEWPORT_ID) as any;
    const canvas = viewport?.canvas;
    const renderer = viewport?.getRenderer?.();
    if (!segmentationId || !segmentationReady || !canvas || !renderer) {
      setSegmentationOperationError('El viewport 3D todavía no está listo para seleccionar voxels.');
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const element = event.currentTarget;
    if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return;

    const canvasX = (event.clientX - rect.left) * (canvas.width / rect.width);
    const canvasY = (rect.bottom - event.clientY) * (canvas.height / rect.height);
    const picker = vtkCellPicker.newInstance({ tolerance: 0.005 });
    picker.pick([canvasX, canvasY, 0], renderer);
    const pickedPositions = picker.getPickedPositions?.() || [];
    const pickedWorldPoint = pickedPositions[0] as [number, number, number] | undefined;
    if (!pickedWorldPoint || pickedWorldPoint.length < 3 || !pickedWorldPoint.every(Number.isFinite)) {
      setSegmentationOperationError('No se seleccionó una superficie de la segmentación 3D.');
      return;
    }

    const labelmap = getMinicatLabelmapData(segmentationId);
    const seedIJK = findClosestActiveLabelmapVoxel(
      labelmap.volume?.imageData,
      labelmap.dimensions,
      labelmap.scalarData,
      activeCtSinusesFeature.segmentIndex,
      pickedWorldPoint
    );
    if (!seedIJK) {
      setSegmentationOperationError(
        'La superficie seleccionada no pertenece al segmento activo. Seleccioná primero esa estructura.'
      );
      return;
    }

    if (regionGrowClickTimerRef.current !== null) {
      window.clearTimeout(regionGrowClickTimerRef.current);
      regionGrowClickTimerRef.current = null;
      setRegionGrowStatus('Doble clic: selección 3D cancelada sin modificar la segmentación');
      return;
    }

    setSegmentationOperationError(null);
    setRegionGrowStatus(
      activeTool === 'Eraser'
        ? 'Esperando… doble clic cancela el borrado 3D'
        : 'Esperando… doble clic cancela el crecimiento 3D'
    );
    regionGrowClickTimerRef.current = window.setTimeout(() => {
      regionGrowClickTimerRef.current = null;
      handleRegionGrow(
        focusedViewportRef.current,
        element,
        0,
        0,
        pickedWorldPoint,
        activeTool === 'Eraser' ? [seedIJK] : undefined
      );
    }, REGION_GROW_CLICK_DELAY_MS);
  }, [
    activeCtSinusesFeature.segmentIndex,
    activeTool,
    handleRegionGrow,
    segmentationReady,
  ]);

  const handleMprClick = useCallback((
    plane: ViewportId,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (activeTool !== 'RegionGrow' && activeTool !== 'Eraser') return;

    const element = event.currentTarget;
    const { clientX, clientY } = event;
    if (regionGrowClickTimerRef.current !== null) {
      // The second click belongs to the double-click zoom gesture. The first
      // click was deliberately deferred, so neither click paints a seed.
      window.clearTimeout(regionGrowClickTimerRef.current);
      regionGrowClickTimerRef.current = null;
      return;
    }

    setRegionGrowStatus(
      activeTool === 'Eraser'
        ? 'Esperando… doble clic hace zoom sin borrar'
        : 'Esperando… doble clic hace zoom sin marcar'
    );
    regionGrowClickTimerRef.current = window.setTimeout(() => {
      regionGrowClickTimerRef.current = null;
      if (activeTool === 'RegionGrow' || activeTool === 'Eraser') {
        handleRegionGrow(plane, element, clientX, clientY);
      }
    }, REGION_GROW_CLICK_DELAY_MS);
  }, [activeTool, handleRegionGrow]);

  const updateRegionEraserCursor = useCallback((
    plane: ViewportId,
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (activeTool !== 'Eraser') return;

    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = renderingEngineRef.current?.getViewport(VIEWPORT_CONFIG[plane].id) as any;
    const canvas = viewport?.canvas;
    const camera = viewport?.getCamera?.();
    if (!canvas || !camera || rect.width <= 0 || rect.height <= 0) return;

    const canvasPoint: [number, number] = [
      (event.clientX - rect.left) * (canvas.width / rect.width),
      (event.clientY - rect.top) * (canvas.height / rect.height),
    ];
    const worldPoint = viewport.canvasToWorld(canvasPoint) as [number, number, number];
    const viewUp = camera.viewUp as [number, number, number];
    const normal = camera.viewPlaneNormal as [number, number, number];
    const right: [number, number, number] = [
      viewUp[1] * normal[2] - viewUp[2] * normal[1],
      viewUp[2] * normal[0] - viewUp[0] * normal[2],
      viewUp[0] * normal[1] - viewUp[1] * normal[0],
    ];
    const rightLength = Math.sqrt(
      right[0] ** 2 + right[1] ** 2 + right[2] ** 2
    ) || 1;
    const edgeWorld: [number, number, number] = [
      worldPoint[0] + (right[0] / rightLength) * brushSize,
      worldPoint[1] + (right[1] / rightLength) * brushSize,
      worldPoint[2] + (right[2] / rightLength) * brushSize,
    ];
    const centerCanvas = viewport.worldToCanvas?.(worldPoint) as [number, number] | undefined;
    const edgeCanvas = viewport.worldToCanvas?.(edgeWorld) as [number, number] | undefined;
    if (!centerCanvas || !edgeCanvas) return;

    const radiusCanvas = Math.sqrt(
      (edgeCanvas[0] - centerCanvas[0]) ** 2 +
      (edgeCanvas[1] - centerCanvas[1]) ** 2
    );
    const cssScale = canvas.width > 0 ? rect.width / canvas.width : 1;
    setRegionEraserCursor({
      plane,
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
      radius: Math.max(4, radiusCanvas * cssScale),
    });
  }, [activeTool, brushSize]);

  useEffect(() => {
    if (!voxelSegmentationEnabled) {
      setSavedSegmentations([]);
      setSelectedSavedSegmentationId('');
      return;
    }

    let cancelled = false;
    setSegmentationOperationError(null);
    void segmentationObjectService.list(studyInstanceUID, series.seriesInstanceUID)
      .then(objects => {
        if (!cancelled) setSavedSegmentations(objects);
      })
      .catch(error => {
        if (!cancelled) {
          setSegmentationOperationError(error instanceof Error ? error.message : 'No se pudieron cargar las segmentaciones');
        }
      });
    return () => { cancelled = true; };
  }, [studyInstanceUID, series.seriesInstanceUID, voxelSegmentationEnabled]);

  useEffect(() => {
    if (!segmentationReady || !segmentationIdRef.current || !activeCtSinusesFeature) return;
    setActiveSegmentLocked(isMinicatSegmentLocked(segmentationIdRef.current, activeCtSinusesFeature));
    setActiveSegmentVisible(true);
  }, [activeCtSinusesFeature, segmentationReady]);

  const toggleActiveSegmentLock = useCallback(() => {
    const segmentationId = segmentationIdRef.current;
    if (!segmentationId || !activeCtSinusesFeature) return;
    const nextLocked = !activeSegmentLocked;
    setMinicatSegmentLocked(segmentationId, activeCtSinusesFeature, nextLocked);
    setActiveSegmentLocked(nextLocked);
  }, [activeCtSinusesFeature, activeSegmentLocked]);

  const toggleActiveSegmentVisibility = useCallback(() => {
    const segmentationId = segmentationIdRef.current;
    if (!segmentationId || !activeCtSinusesFeature) return;
    const nextVisible = !activeSegmentVisible;
    setMinicatSegmentVisibility(
      ALL_VIEWPORT_IDS,
      segmentationId,
      activeCtSinusesFeature,
      nextVisible
    );
    setActiveSegmentVisible(nextVisible);
  }, [activeCtSinusesFeature, activeSegmentVisible]);

  const saveVoxelSegmentation = useCallback(async () => {
    const segmentationId = segmentationIdRef.current;
    if (!segmentationId || !segmentationReady || segmentationBusy) return;

    try {
      setSegmentationBusy(true);
      setSegmentationOperationError(null);
      const labelmap = getMinicatLabelmapData(segmentationId);
      if (!labelmap.scalarData.some(value => value > 0)) {
        throw new Error('La segmentación está vacía; pinta al menos un voxel antes de guardar');
      }

      const dicomBuffer = serializeMinicatSegmentation(segmentationId, volumeId);
      const identifiers = readMinicatDicomSegIdentifiers(dicomBuffer);
      await dicomWebService.storeDicomObject(dicomBuffer);

      const previous = savedSegmentations.find(object => object.id === selectedSavedSegmentationId);
      const sourceFrameOfReferenceUID = preparedInstancesRef.current.find(instance => instance.frameOfReferenceUID)
        ?.frameOfReferenceUID;
      const created = await segmentationObjectService.create({
        studyInstanceUID,
        sourceSeriesInstanceUID: series.seriesInstanceUID,
        segmentationSeriesInstanceUID: identifiers.seriesInstanceUID,
        segmentationSOPInstanceUID: identifiers.sopInstanceUID,
        name: 'MINICAT SINUS · Segmentación voxel 3D',
        description: 'Segmentación volumétrica editable de las 19 estructuras de MINICAT SINUS',
        ontologyVersion: MINICAT_VOXEL_SEGMENTATION_ONTOLOGY_VERSION,
        dimensions: labelmap.dimensions,
        spacing: labelmap.spacing,
        frameOfReferenceUID: identifiers.frameOfReferenceUID || sourceFrameOfReferenceUID || null,
        version: previous ? previous.version + 1 : 1,
        supersedesObjectId: previous?.id || null,
        status: 'draft',
      });

      setSavedSegmentations(current => [created, ...current.filter(object => object.id !== created.id)]);
      setSelectedSavedSegmentationId(created.id);
      setSegmentationDirty(false);
      onVoxelSegmentationDirty?.(false);
    } catch (error) {
      console.error('[MPR] failed to save DICOM SEG', error);
      setSegmentationOperationError(error instanceof Error ? error.message : 'No se pudo guardar el DICOM SEG');
    } finally {
      setSegmentationBusy(false);
    }
  }, [
    segmentationReady,
    segmentationBusy,
    volumeId,
    studyInstanceUID,
    series.seriesInstanceUID,
    savedSegmentations,
    selectedSavedSegmentationId,
    onVoxelSegmentationDirty,
  ]);

  const openSavedSegmentation = useCallback(async () => {
    const segmentationId = segmentationIdRef.current;
    const selected = savedSegmentations.find(object => object.id === selectedSavedSegmentationId);
    if (!segmentationId || !selected || !segmentationReady || segmentationBusy) return;
    if (segmentationDirty && !window.confirm('Hay cambios no guardados. ¿Deseas reemplazarlos con esta segmentación?')) {
      return;
    }

    try {
      setSegmentationBusy(true);
      setSegmentationOperationError(null);
      if (!sourceImageIdsRef.current.length) throw new Error('La serie CT fuente aún no está preparada');
      const dicomBuffer = await dicomWebService.getInstanceDicom(
        studyInstanceUID,
        selected.segmentationSeriesInstanceUID,
        selected.segmentationSOPInstanceUID
      );
      await importMinicatDICOMSEG(segmentationId, volumeId, sourceImageIdsRef.current, dicomBuffer);
      interpolationTrackersRef.current.clear();
      regionGrowUndoStackRef.current = [];
      regionGrowRedoStackRef.current = [];
      setInterpolationStatus(null);
      setSegmentationDirty(false);
      onVoxelSegmentationDirty?.(false);
    } catch (error) {
      console.error('[MPR] failed to open DICOM SEG', error);
      setSegmentationOperationError(error instanceof Error ? error.message : 'No se pudo abrir el DICOM SEG');
    } finally {
      setSegmentationBusy(false);
    }
  }, [
    selectedSavedSegmentationId,
    savedSegmentations,
    segmentationReady,
    segmentationBusy,
    segmentationDirty,
    studyInstanceUID,
    volumeId,
    onVoxelSegmentationDirty,
  ]);

  const initMPR = useCallback(async () => {
    if (!VIEWPORT_ORDER.every(plane => viewportRefs.current[plane])) {
      return;
    }

    const generation = ++initializationGenerationRef.current;

    try {
      regionGrowUndoStackRef.current = [];
      regionGrowRedoStackRef.current = [];
      setIsLoading(true);
      setError(null);

      const {
        WindowLevelTool,
        StackScrollTool,
        CrosshairsTool,
        PanTool,
        ZoomTool,
        BrushTool,
        TrackballRotateTool,
        ToolGroupManager,
        addTool,
      } = cornerstoneTools;

      addTool(PanTool);
      addTool(ZoomTool);
      addTool(WindowLevelTool);
      addTool(StackScrollTool);
      addTool(CrosshairsTool);
      addTool(BrushTool);
      addTool(TrackballRotateTool);

      // MPR is a volume reconstructed from the currently selected series.
      // Complete the image-plane metadata before Cornerstone builds that
      // volume; QIDO responses can omit ImagePositionPatient on individual
      // instances even though the series is otherwise reconstructable.
      const mprInstances = await prepareMprInstances(studyInstanceUID, series);
      if (generation !== initializationGenerationRef.current) return;
      preparedInstancesRef.current = mprInstances;
      const imageIds = mprInstances
        .map((instance) => {
          const imageUrl = dicomWebService.getInstanceWadoUriUrl(
            studyInstanceUID,
            series.seriesInstanceUID,
            instance.sopInstanceUID
          );
          return `wadouri:${imageUrl}`;
        });
      sourceImageIdsRef.current = imageIds;

      registerMprImagePlaneMetadata(imageIds, mprInstances);

      const volume = await volumeLoader.createAndCacheVolume(volumeId, {
        imageIds,
      });

      await volume.load();
      if (generation !== initializationGenerationRef.current) return;

      // Do not allocate the engine until the asynchronous volume preparation
      // is complete. If React replaces the series while the volume is loading,
      // the stale initialization exits above instead of creating an engine
      // with the same ID after its cleanup already destroyed one.
      const renderingEngineId = 'mpr-rendering-engine';
      const renderingEngine = new RenderingEngine(renderingEngineId);
      renderingEngineRef.current = renderingEngine;

      const viewportInputs = [
        ...VIEWPORT_ORDER.map(plane => ({
          viewportId: VIEWPORT_CONFIG[plane].id,
          element: viewportRefs.current[plane]!,
          type: Enums.ViewportType.ORTHOGRAPHIC,
          defaultOptions: {
            orientation: VIEWPORT_CONFIG[plane].orientation,
          },
        })),
        {
          viewportId: VOLUME_3D_VIEWPORT_ID,
          element: volume3DViewportRef.current!,
          type: Enums.ViewportType.VOLUME_3D,
          defaultOptions: {
            background: [0, 0, 0] as [number, number, number],
          },
        },
      ];

      renderingEngine.setViewports(viewportInputs);
      // The MPR component is mounted beside the native Stack. Give
      // Cornerstone the actual CSS dimensions before attaching the volume.
      renderingEngine.resize(false, true);

      const toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
      toolGroupRef.current = toolGroup;

      if (toolGroup) {
        toolGroup.addTool(PanTool.toolName);
        toolGroup.addTool(ZoomTool.toolName);
        toolGroup.addTool(WindowLevelTool.toolName);
        toolGroup.addTool(StackScrollTool.toolName);
        toolGroup.addTool(CrosshairsTool.toolName);
        if (voxelSegmentationEnabled) {
          toolGroup.addTool(BrushTool.toolName);
        }

        VIEWPORT_ORDER.forEach(plane => {
          toolGroup.addViewport(VIEWPORT_CONFIG[plane].id, renderingEngineId);
        });

        toolGroup.setToolActive(WindowLevelTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });

        toolGroup.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
        });

        toolGroup.setToolActive(ZoomTool.toolName, {
          bindings: [
            { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
            {
              mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel,
              modifierKey: cornerstoneTools.Enums.KeyboardBindings.Ctrl,
            },
          ],
        });

        toolGroup.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
        });

        toolGroup.setToolActive(CrosshairsTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Ctrl }],
        });

      }

      const volume3DToolGroup = ToolGroupManager.createToolGroup(VOLUME_3D_TOOL_GROUP_ID);
      volume3DToolGroupRef.current = volume3DToolGroup;
      if (volume3DToolGroup) {
        volume3DToolGroup.addTool(TrackballRotateTool.toolName);
        volume3DToolGroup.addTool(PanTool.toolName);
        volume3DToolGroup.addTool(ZoomTool.toolName);
        volume3DToolGroup.addViewport(VOLUME_3D_VIEWPORT_ID, renderingEngineId);
        volume3DToolGroup.setToolActive(TrackballRotateTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
        volume3DToolGroup.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
        });
        volume3DToolGroup.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
        });
      }

      await setVolumesForViewports(
        renderingEngine,
        [{ volumeId }],
        ALL_VIEWPORT_IDS
      );
      const volume3DViewport = renderingEngine.getViewport(VOLUME_3D_VIEWPORT_ID) as any;
      const sourceVolumeActorUIDs = (volume3DViewport?.getActors?.() || [])
        .filter((entry: any) => entry.referencedId === volumeId)
        .map((entry: any) => entry.uid);
      if (sourceVolumeActorUIDs.length) {
        volume3DViewport.removeActors(sourceVolumeActorUIDs);
      }
      console.info('[MPR][3D] source CT actors removed from surface-only viewport', {
        volumeId,
        removedActorUIDs: sourceVolumeActorUIDs,
        remainingActors: volume3DViewport?.getActors?.().map((entry: any) => ({
          uid: entry.uid,
          referencedId: entry.referencedId,
          representationUID: entry.representationUID,
        })),
      });
      if (generation !== initializationGenerationRef.current) return;

      if (voxelSegmentationEnabled) {
        try {
          const segmentationId = await ensureMinicatLabelmap({
            studyInstanceUID,
            seriesInstanceUID: series.seriesInstanceUID,
            volumeId,
            viewportIds: MPR_VIEWPORT_IDS,
          });
          segmentationIdRef.current = segmentationId;
          interpolationTrackersRef.current.clear();
          setInterpolationStatus(null);
          setActiveMinicatSegment(segmentationId, CT_SINUSES_FEATURES[0]);
          cornerstoneTools.utilities.segmentation.setBrushSizeForToolGroup(
            TOOL_GROUP_ID,
            25,
            BrushTool.toolName
          );
          setSegmentationReady(true);
          setSegmentationError(null);
        } catch (error) {
          console.error('[MPR] failed to initialize voxel segmentation', error);
          setSegmentationError(error instanceof Error ? error.message : 'No se pudo inicializar el Labelmap');
          setSegmentationReady(false);
        }
      }

      const activeViewportIds = ALL_VIEWPORT_IDS;
      renderingEngine.renderViewports(activeViewportIds);
      renderingEngine.resize(false, true);
      renderingEngine.renderViewports(activeViewportIds);

      setIsLoading(false);
    } catch (err) {
      if (generation !== initializationGenerationRef.current) return;
      console.error('Failed to initialize MPR:', err);
      setError(err instanceof Error ? err.message : 'Failed to initialize MPR');
      setIsLoading(false);
    }
  }, [studyInstanceUID, series, volumeId, voxelSegmentationEnabled]);

  useEffect(() => {
    const segmentationId = segmentationIdRef.current;
    if (!segmentationId || !segmentationReady || !activeCtSinusesFeature) return;
    setActiveMinicatSegment(segmentationId, activeCtSinusesFeature);
  }, [activeCtSinusesFeature, segmentationReady]);

  useEffect(() => {
    if (!segmentationReady || !onVoxelSegmentationDirty) return;
    const segmentationEvent = (cornerstoneTools.Enums.Events as any).SEGMENTATION_DATA_MODIFIED;
    if (!segmentationEvent) return;
    const handleSegmentationModified = (event: any) => {
      if (event.detail?.segmentationId && event.detail.segmentationId !== segmentationIdRef.current) return;
      setSegmentationDirty(true);
      onVoxelSegmentationDirty(true);
    };
    eventTarget.addEventListener(segmentationEvent, handleSegmentationModified);
    return () => eventTarget.removeEventListener(segmentationEvent, handleSegmentationModified);
  }, [onVoxelSegmentationDirty, segmentationReady]);

  useEffect(() => {
    if (!segmentationReady || !autoInterpolationEnabled) return;
    const segmentationEvent = (cornerstoneTools.Enums.Events as any).SEGMENTATION_DATA_MODIFIED;
    if (!segmentationEvent) return;

    const pendingTimers = new Map<number, number>();

    const getInterpolationPlane = (): {
      axis: LabelmapInterpolationAxis;
      plane: ViewportId;
      slice: number;
      alignment: number;
    } | null => {
      const segmentationId = segmentationIdRef.current;
      if (!segmentationId) return null;
      const plane = focusedViewportRef.current;
      const viewport = renderingEngineRef.current?.getViewport(
        VIEWPORT_CONFIG[plane].id
      ) as any;
      const labelmap = getMinicatLabelmapData(segmentationId);
      const imageData = labelmap.volume?.imageData;
      const camera = viewport?.getCamera?.();
      if (!imageData || !camera?.focalPoint) return null;

      const { ijkVecSliceDir } = csUtils.getVolumeDirectionVectors(imageData, camera);
      const absoluteDirection = Array.from(ijkVecSliceDir, value => Math.abs(Number(value)));
      const axis = absoluteDirection.indexOf(Math.max(...absoluteDirection)) as LabelmapInterpolationAxis;
      const alignment = absoluteDirection[axis];
      // Automatic interpolation is safe for the standard orthogonal MPR
      // planes. An oblique plane would require resampling on a non-IJK grid.
      if (!Number.isFinite(alignment) || alignment < 0.98) return null;

      const focalIndex = csUtils.transformWorldToIndexContinuous(
        imageData,
        camera.focalPoint
      );
      const slice = Math.max(
        0,
        Math.min(labelmap.dimensions[axis] - 1, Math.round(focalIndex[axis]))
      );
      return { axis, plane, slice, alignment };
    };

    const interpolateSegment = (segmentIndex: number) => {
      const segmentationId = segmentationIdRef.current;
      const tracker = interpolationTrackersRef.current.get(segmentIndex);
      if (!segmentationId || !tracker) return;

      try {
        setInterpolationBusy(true);
        const labelmap = getMinicatLabelmapData(segmentationId);
        const result = interpolateLabelmapSegment({
          scalarData: labelmap.scalarData,
          dimensions: labelmap.dimensions,
          spacing: labelmap.spacing,
          segmentIndex,
          axis: tracker.axis,
          anchorSlices: tracker.anchors,
          previousGeneratedOffsets: tracker.generatedOffsets,
          setVoxelValue: (offset, value) => {
            labelmap.volume.voxelManager.setAtIndex(offset, value);
          },
        });
        tracker.generatedOffsets = result.generatedOffsets;

        const planeLabel = VIEWPORT_CONFIG[tracker.plane].label;
        const anchorCount = tracker.anchors.size;
        if (anchorCount < 2) {
          setInterpolationStatus(`${planeLabel}: 1 corte ancla`);
        } else if (result.anchorPairCount === 0) {
          setInterpolationStatus(`${planeLabel}: sin espacio para interpolar`);
        } else {
          setInterpolationStatus(
            `${planeLabel}: ${result.interpolatedSliceCount} cortes interpolados`
          );
        }

        console.info('[MPR][Interpolation] completed', {
          segmentationId,
          segmentIndex,
          plane: tracker.plane,
          volumeAxis: tracker.axis,
          anchors: Array.from(tracker.anchors).sort((left, right) => left - right),
          ...result,
          generatedOffsets: result.generatedOffsets.size,
        });

        if (result.changedVoxelCount === 0) return;
        labelmap.volume.modified();
        interpolationInProgressRef.current = true;
        try {
          cornerstoneTools.segmentation.triggerSegmentationEvents
            .triggerSegmentationDataModified(
              segmentationId,
              result.modifiedNativeSlices,
              segmentIndex
            );
        } finally {
          interpolationInProgressRef.current = false;
        }
        renderingEngineRef.current?.renderViewports(MPR_VIEWPORT_IDS);
      } catch (error) {
        console.error('[MPR][Interpolation] failed', error);
        setInterpolationStatus('Error de interpolación');
        setSegmentationOperationError(
          error instanceof Error ? error.message : 'No se pudo interpolar la segmentación'
        );
      } finally {
        setInterpolationBusy(false);
      }
    };

    const handleSegmentationModified = (event: any) => {
      if (interpolationInProgressRef.current) return;
      if (event.detail?.segmentationId !== segmentationIdRef.current) return;
      if (activeTool !== 'Brush') return;

      const segmentIndex = Number(event.detail?.segmentIndex);
      if (!Number.isInteger(segmentIndex) || segmentIndex <= 0) return;
      const interpolationPlane = getInterpolationPlane();
      if (!interpolationPlane) {
        console.warn('[MPR][Interpolation] skipped non-orthogonal or unavailable plane');
        setInterpolationStatus('Vista oblicua: interpolación omitida');
        return;
      }

      let tracker = interpolationTrackersRef.current.get(segmentIndex);
      if (!tracker || tracker.axis !== interpolationPlane.axis) {
        // Changing editing plane starts a new sequence of anchors. Previously
        // generated voxels stay in the Labelmap and are treated as baseline;
        // this prevents a plane switch from erasing valid work.
        tracker = {
          axis: interpolationPlane.axis,
          plane: interpolationPlane.plane,
          anchors: new Set<number>(),
          generatedOffsets: new Set<number>(),
        };
        interpolationTrackersRef.current.set(segmentIndex, tracker);
      }
      tracker.plane = interpolationPlane.plane;
      tracker.anchors.add(interpolationPlane.slice);

      console.info('[MPR][Interpolation] anchor registered', {
        segmentIndex,
        plane: interpolationPlane.plane,
        volumeAxis: interpolationPlane.axis,
        slice: interpolationPlane.slice,
        alignment: interpolationPlane.alignment,
        anchors: Array.from(tracker.anchors).sort((left, right) => left - right),
        cornerstoneModifiedNativeSlices: event.detail?.modifiedSlicesToUse,
      });

      const previousTimer = pendingTimers.get(segmentIndex);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      pendingTimers.set(segmentIndex, window.setTimeout(() => {
        pendingTimers.delete(segmentIndex);
        interpolateSegment(segmentIndex);
      }, 300));
    };

    eventTarget.addEventListener(segmentationEvent, handleSegmentationModified);
    return () => {
      eventTarget.removeEventListener(segmentationEvent, handleSegmentationModified);
      pendingTimers.forEach(timer => window.clearTimeout(timer));
      pendingTimers.clear();
    };
  }, [activeTool, autoInterpolationEnabled, segmentationReady]);

  useEffect(() => {
    if (!showVolume3D || !segmentationReady) return;
    const segmentationId = segmentationIdRef.current;
    if (!segmentationId) return;

    // Wait until the CSS layout has exposed and resized the 3D viewport before
    // asking PolySeg to build the mesh. This also avoids computing an empty
    // surface while the user is still painting the first voxels.
    const timer = window.setTimeout(() => {
      const buildSurface = async () => {
        const renderingEngine = renderingEngineRef.current;
        renderingEngine?.resize(false, true);
        const viewport = renderingEngine?.getViewport(VOLUME_3D_VIEWPORT_ID) as any;
        if (!viewport) throw new Error('El viewport 3D no está disponible');

        const segmentation = cornerstoneTools.segmentation.state.getSegmentation(segmentationId) as any;
        let surfaceData = segmentation?.representationData?.Surface;
        const labelmap = getMinicatLabelmapData(segmentationId);
        const [dimX, dimY] = labelmap.dimensions;
        const segmentVoxelSummary = new Map<number, {
          segmentIndex: number;
          label: string;
          voxelCount: number;
          minIJK: [number, number, number];
          maxIJK: [number, number, number];
        }>();
        for (let offset = 0; offset < labelmap.scalarData.length; offset += 1) {
          const segmentIndex = labelmap.scalarData[offset];
          if (!segmentIndex) continue;
          const i = offset % dimX;
          const j = Math.floor(offset / dimX) % dimY;
          const k = Math.floor(offset / (dimX * dimY));
          let summary = segmentVoxelSummary.get(segmentIndex);
          if (!summary) {
            summary = {
              segmentIndex,
              label: CT_SINUSES_FEATURES.find(feature => feature.segmentIndex === segmentIndex)?.label || 'Unknown',
              voxelCount: 0,
              minIJK: [i, j, k],
              maxIJK: [i, j, k],
            };
            segmentVoxelSummary.set(segmentIndex, summary);
          }
          summary.voxelCount += 1;
          summary.minIJK = [
            Math.min(summary.minIJK[0], i),
            Math.min(summary.minIJK[1], j),
            Math.min(summary.minIJK[2], k),
          ];
          summary.maxIJK = [
            Math.max(summary.maxIJK[0], i),
            Math.max(summary.maxIJK[1], j),
            Math.max(summary.maxIJK[2], k),
          ];
        }
        console.info('[MPR][3D] voxel input', {
          segmentationId,
          dimensions: labelmap.dimensions,
          spacing: labelmap.spacing,
          origin: labelmap.origin,
          direction: labelmap.direction,
          nonZeroVoxelCount: Array.from(segmentVoxelSummary.values())
            .reduce((total, item) => total + item.voxelCount, 0),
          viewport: {
            id: viewport.id,
            type: viewport.type,
            clientWidth: viewport.element?.clientWidth,
            clientHeight: viewport.element?.clientHeight,
            canvasWidth: viewport.canvas?.width,
            canvasHeight: viewport.canvas?.height,
          },
        });
        console.table(Array.from(segmentVoxelSummary.values()));

        // Surface conversion reads its color from the target viewport. Add an
        // empty data holder first, then register the colored representation.
        // SurfaceDisplay sees the holder and therefore does not start a second
        // concurrent conversion while PolySeg is building the actual mesh.
        if (!surfaceData) {
          surfaceData = { geometryIds: new Map<number, string>() };
          cornerstoneTools.segmentation.addRepresentationData({
            segmentationId,
            type: cornerstoneTools.Enums.SegmentationRepresentations.Surface,
            data: surfaceData,
          });
        }

        const existingSurface = cornerstoneTools.segmentation.state.getSegmentationRepresentation(
          VOLUME_3D_VIEWPORT_ID,
          {
            segmentationId,
            type: cornerstoneTools.Enums.SegmentationRepresentations.Surface,
          }
        );
        if (!existingSurface) {
          const axialLabelmapRepresentation = cornerstoneTools.segmentation.state.getSegmentationRepresentation(
            AXIAL_VIEWPORT_ID,
            {
              segmentationId,
              type: cornerstoneTools.Enums.SegmentationRepresentations.Labelmap,
            }
          );
          cornerstoneTools.segmentation.addSurfaceRepresentationToViewport(
            VOLUME_3D_VIEWPORT_ID,
            [{
              segmentationId,
              config: axialLabelmapRepresentation?.colorLUTIndex !== undefined
                ? { colorLUTOrIndex: axialLabelmapRepresentation.colorLUTIndex }
                : undefined,
            }]
          );
        }

        // addSurfaceRepresentationToViewport clones the segmentation state.
        // Re-read the holder so the computed geometry is attached to the
        // current state rather than to the pre-clone object kept above.
        surfaceData = (cornerstoneTools.segmentation.state.getSegmentation(segmentationId) as any)
          ?.representationData?.Surface;
        if (!surfaceData) {
          throw new Error('No se pudo preparar la representación de superficie 3D');
        }

        if (!surfaceData.geometryIds?.size) {
          const computedSurfaceData = await polySeg.computeSurfaceData(segmentationId, { viewport });
          const geometryDiagnostics = Array.from(computedSurfaceData?.geometryIds?.entries?.() || [])
            .map((entry: unknown) => {
              const [segmentIndex, geometryId] = entry as [number, string];
              const surface = (cache.getGeometry(geometryId) as any)?.data;
              const points = surface?.points || [];
              const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
              let finitePointCount = 0;
              for (let index = 0; index + 2 < points.length; index += 3) {
                const x = Number(points[index]);
                const y = Number(points[index + 1]);
                const z = Number(points[index + 2]);
                if (![x, y, z].every(Number.isFinite)) continue;
                finitePointCount += 1;
                bounds[0] = Math.min(bounds[0], x);
                bounds[1] = Math.max(bounds[1], x);
                bounds[2] = Math.min(bounds[2], y);
                bounds[3] = Math.max(bounds[3], y);
                bounds[4] = Math.min(bounds[4], z);
                bounds[5] = Math.max(bounds[5], z);
              }
              return {
                segmentIndex,
                geometryId,
                pointCount: Math.floor(points.length / 3),
                finitePointCount,
                polysLength: surface?.polys?.length || 0,
                bounds,
                color: surface?.color,
              };
            });
          console.info('[MPR][3D] PolySeg geometry computed', {
            geometryIds: Array.from(computedSurfaceData?.geometryIds?.entries?.() || []),
            geometryDiagnostics,
          });
          console.table(geometryDiagnostics);
          const hasRenderableGeometry = geometryDiagnostics
            .some(item => item.finitePointCount >= 3 && item.polysLength >= 4);
          if (!hasRenderableGeometry) {
            throw new Error('No se generó una superficie. Pinta una región más amplia en uno o más cortes.');
          }
          surfaceData.geometryIds = computedSurfaceData.geometryIds;
        }

        cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationModified(
          segmentationId
        );
        window.setTimeout(() => {
          const surfaceActors = (viewport.getActors?.() || []).filter((entry: any) =>
            entry.representationUID?.startsWith(`${segmentationId}-Surface-`)
          );
          const cameraBefore = viewport.getCamera?.();
          const actorDiagnostics = surfaceActors.map((entry: any) => {
            const property = entry.actor?.getProperty?.();
            const mapperInput = entry.actor?.getMapper?.()?.getInputData?.();
            entry.actor?.setVisibility?.(true);
            property?.setOpacity?.(1);
            property?.setAmbient?.(0.35);
            property?.setDiffuse?.(0.65);
            return {
              uid: entry.uid,
              representationUID: entry.representationUID,
              visible: entry.actor?.getVisibility?.(),
              bounds: entry.actor?.getBounds?.(),
              color: property?.getColor?.(),
              opacity: property?.getOpacity?.(),
              mapperPointCount: mapperInput?.getPoints?.()?.getNumberOfPoints?.(),
              mapperCellCount: mapperInput?.getNumberOfCells?.(),
            };
          });
          console.info('[MPR][3D] render state before camera fit', {
            actorDiagnostics,
            camera: cameraBefore,
            viewportActors: (viewport.getActors?.() || []).map((entry: any) => ({
              uid: entry.uid,
              referencedId: entry.referencedId,
              representationUID: entry.representationUID,
              visible: entry.actor?.getVisibility?.(),
              bounds: entry.actor?.getBounds?.(),
            })),
          });
          console.table(actorDiagnostics);
          if (!surfaceActors.length) {
            console.error('[MPR] 3D surface geometry exists but no surface actor was rendered');
            setSurface3DStatus('idle');
            setSegmentationOperationError('La geometría 3D se generó, pero Cornerstone no creó su actor visual.');
            setShowVolume3D(false);
            return;
          }
          // Start the 3D surface in the same patient-facing orientation as
          // the coronal MPR: front view, head up. Reusing the MPR camera
          // keeps this correct even when the CT acquisition is not aligned
          // with the default world axes.
          const coronalViewport = renderingEngine?.getViewport(CORONAL_VIEWPORT_ID) as any;
          const coronalCamera = coronalViewport?.getCamera?.();
          const frontViewPlaneNormal = coronalCamera?.viewPlaneNormal || [0, -1, 0];
          const frontViewUp = coronalCamera?.viewUp || [0, 0, 1];
          viewport.setCamera?.({
            viewPlaneNormal: frontViewPlaneNormal,
            viewUp: frontViewUp,
          });
          viewport.resetCamera?.({ resetOrientation: false, resetRotation: false });
          viewport.getRenderer?.().resetCameraClippingRange?.();
          viewport.render?.();
          console.info('[MPR][3D] render state after camera fit', {
            camera: viewport.getCamera?.(),
            frontViewPlaneNormal,
            frontViewUp,
            rendererBounds: viewport.getRenderer?.().computeVisiblePropBounds?.(),
          });
          setSurface3DStatus('ready');
        }, 300);
      };

      void buildSurface().catch(error => {
        console.error('[MPR] failed to build 3D segmentation surface', error);
        setSurface3DStatus('idle');
        setSegmentationOperationError(
          error instanceof Error ? error.message : 'No se pudo generar la superficie 3D'
        );
        setShowVolume3D(false);
      });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [segmentationReady, showVolume3D]);

  useEffect(() => {
    if (!segmentationReady) return;
    const segmentationEvent = (cornerstoneTools.Enums.Events as any).SEGMENTATION_DATA_MODIFIED;
    if (!segmentationEvent) return;

    let timer: number | null = null;
    let updateInFlight = false;
    let updateQueued = false;

    const updateSurface = async () => {
      if (updateInFlight) {
        updateQueued = true;
        return;
      }
      updateInFlight = true;
      try {
        do {
          updateQueued = false;
          const segmentationId = segmentationIdRef.current;
          const segmentation = segmentationId
            ? cornerstoneTools.segmentation.state.getSegmentation(segmentationId) as any
            : null;
          if (!segmentationId || !segmentation?.representationData?.Surface) return;
          await polySeg.updateSurfaceData(segmentationId);
        } while (updateQueued);
      } catch (error) {
        console.error('[MPR] failed to update 3D segmentation surface', error);
        setSegmentationOperationError('La máscara se editó, pero no se pudo actualizar su superficie 3D.');
      } finally {
        updateInFlight = false;
      }
    };

    const handleSegmentationModified = (event: any) => {
      if (event.detail?.segmentationId !== segmentationIdRef.current) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void updateSurface();
      }, 350);
    };

    eventTarget.addEventListener(segmentationEvent, handleSegmentationModified);
    return () => {
      eventTarget.removeEventListener(segmentationEvent, handleSegmentationModified);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [segmentationReady]);

  const setMprCrosshairCenter = useCallback((
    worldPoint: number[],
    sourceViewportId?: string,
    suppressEvents = true
  ) => {
    const crosshairsTool = toolGroupRef.current?.getToolInstance?.(
      cornerstoneTools.CrosshairsTool.toolName
    );
    if (!crosshairsTool?.setToolCenter || worldPoint.length < 3) return;

    const renderingEngine = renderingEngineRef.current;
    const previousCenter = Array.isArray(crosshairsTool.toolCenter) &&
      crosshairsTool.toolCenter.length >= 3
      ? crosshairsTool.toolCenter
      : worldPoint;
    const delta = worldPoint.slice(0, 3).map((value, index) => value - previousCenter[index]);
    const viewportsToRender: string[] = [];

    // CrosshairsTool moves linked cameras when the user Ctrl-clicks, but a
    // volume scroll only changes the active viewport. Apply the same spatial
    // delta here so all three planes continue to show one common location.
    synchronizingMprRef.current = true;
    try {
      if (renderingEngine) {
        VIEWPORT_ORDER.forEach(plane => {
          const viewportId = VIEWPORT_CONFIG[plane].id;
          if (viewportId === sourceViewportId) return;

          const viewport = renderingEngine.getViewport(viewportId);
          const camera = viewport?.getCamera?.();
          const normal = camera?.viewPlaneNormal;
          if (!camera || !Array.isArray(normal) || normal.length < 3) return;

          const distance = dotProduct(delta, normal);
          const projectedDelta = normal.slice(0, 3).map(value => value * distance);
          if (Math.hypot(...projectedDelta) < 1e-3) return;

          const shiftedFocalPoint: [number, number, number] = [
            camera.focalPoint[0] + projectedDelta[0],
            camera.focalPoint[1] + projectedDelta[1],
            camera.focalPoint[2] + projectedDelta[2],
          ];
          const shiftedPosition: [number, number, number] = [
            camera.position[0] + projectedDelta[0],
            camera.position[1] + projectedDelta[1],
            camera.position[2] + projectedDelta[2],
          ];
          viewport.setCamera({
            focalPoint: shiftedFocalPoint,
            position: shiftedPosition,
          });
          viewportsToRender.push(viewportId);
        });

        if (viewportsToRender.length) {
          renderingEngine.renderViewports(viewportsToRender);
        }
      }

      crosshairsTool.setToolCenter([...worldPoint.slice(0, 3)], suppressEvents);
    } finally {
      // Camera updates can dispatch their volume event synchronously. Keep the
      // guard through the current task so those internal updates are ignored.
      window.setTimeout(() => {
        synchronizingMprRef.current = false;
      }, 0);
    }
  }, []);

  const setMprCrosshairFromNativeSlice = useCallback((imageIndex: number) => {
    const instance = preparedInstancesRef.current[imageIndex];
    const worldCenter = instance && getImageCenterWorld(instance);
    if (!worldCenter) return;

    lastNativeSliceRef.current = imageIndex;
    setMprCrosshairCenter(worldCenter);
  }, [setMprCrosshairCenter]);

  // Stack navigation -> MPR reference position. Suppressing the Crosshairs
  // event here prevents a feedback loop when the source of the change was the
  // native Stack itself.
  useEffect(() => {
    if (!isLoading) {
      setMprCrosshairFromNativeSlice(nativeImageIndex);
    }
  }, [isLoading, nativeImageIndex, setMprCrosshairFromNativeSlice]);

  // MPR crosshair drag -> nearest stored DICOM slice. The crosshair point is
  // expressed in patient/world coordinates, so this remains correct for
  // reversed slice order and non-zero ImagePositionPatient origins.
  useEffect(() => {
    if (isLoading || !onNativeSliceChange) return;

    const handleCrosshairChanged = (event: any) => {
      const detail = event.detail || {};
      if (detail.toolGroupId && detail.toolGroupId !== TOOL_GROUP_ID) return;
      const worldPoint = detail.toolCenter;
      if (!Array.isArray(worldPoint) || worldPoint.length < 3 ||
          !worldPoint.slice(0, 3).every(Number.isFinite)) return;

      const imageIndex = getNearestSliceIndex(
        worldPoint,
        preparedInstancesRef.current,
        nativeImageIndex
      );
      if (imageIndex === lastNativeSliceRef.current) return;
      lastNativeSliceRef.current = imageIndex;
      onNativeSliceChange(imageIndex);
    };

    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
      handleCrosshairChanged
    );
    return () => {
      eventTarget.removeEventListener(
        cornerstoneTools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
        handleCrosshairChanged
      );
    };
  }, [isLoading, nativeImageIndex, onNativeSliceChange]);

  // Volume scrolling changes the camera focal point, but it does not move
  // CrosshairsTool's center by itself. Publish that point so scrolling in any
  // MPR plane (especially coronal) updates the other reconstructions and the
  // native stack as well.
  useEffect(() => {
    if (isLoading || !onNativeSliceChange) return;

    const handleVolumeSliceChanged = (event: any) => {
      const viewportId = event.detail?.viewportId;
      const plane = VIEWPORT_ORDER.find(
        candidate => VIEWPORT_CONFIG[candidate].id === viewportId
      );
      if (!plane) return;
      if (synchronizingMprRef.current) return;

      const viewport = renderingEngineRef.current?.getViewport(viewportId);
      const focalPoint = viewport?.getCamera?.().focalPoint;
      if (!Array.isArray(focalPoint) || focalPoint.length < 3 ||
          !focalPoint.slice(0, 3).every(Number.isFinite)) {
        return;
      }

      setMprCrosshairCenter(
        [...focalPoint.slice(0, 3)],
        viewportId,
        false
      );
    };

    const elements = VIEWPORT_ORDER
      .map(plane => viewportRefs.current[plane])
      .filter((element): element is HTMLDivElement => Boolean(element));
    elements.forEach(element => {
      element.addEventListener(Enums.Events.VOLUME_NEW_IMAGE, handleVolumeSliceChanged);
    });

    return () => {
      elements.forEach(element => {
        element.removeEventListener(Enums.Events.VOLUME_NEW_IMAGE, handleVolumeSliceChanged);
      });
    };
  }, [isLoading, onNativeSliceChange, setMprCrosshairCenter]);

  useEffect(() => {
    // Let the native stack render and receive user navigation first. MPR is a
    // background enhancement and must not compete with the first native image
    // when a preloaded study is opened.
    const interpolationTrackers = interpolationTrackersRef.current;
    const timer = window.setTimeout(() => {
      void initMPR();
    }, 500);

    return () => {
      window.clearTimeout(timer);
      // Invalidate any in-flight prepare/load sequence before destroying the
      // current engine. This prevents a stale async initializer from using a
      // RenderingEngine instance after cleanup.
      initializationGenerationRef.current += 1;
      setSegmentationReady(false);
      setSegmentationDirty(false);
      interpolationTrackers.clear();
      interpolationInProgressRef.current = false;
      setInterpolationBusy(false);
      setInterpolationStatus(null);
      destroyMinicatSegmentation(segmentationIdRef.current);
      segmentationIdRef.current = null;
      // MPR annotations are bound to the current volume rendering engine and
      // viewport elements.  Keeping them in the global Cornerstone state
      // makes the next MPR instance incorrectly treat stale annotations as
      // already restored, so remove only the MPR-bound entries on teardown.
      cornerstoneTools.annotation.state.getAllAnnotations()
        .filter((annotation: any) => annotation.metadata?.mpr === true)
        .forEach((annotation: any) => {
          cornerstoneTools.annotation.state.removeAnnotation(annotation.annotationUID);
        });
      if (toolGroupRef.current) {
        cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
        toolGroupRef.current = null;
      }
      if (volume3DToolGroupRef.current) {
        cornerstoneTools.ToolGroupManager.destroyToolGroup(VOLUME_3D_TOOL_GROUP_ID);
        volume3DToolGroupRef.current = null;
      }
      if (renderingEngineRef.current) {
        renderingEngineRef.current.destroy();
        renderingEngineRef.current = null;
      }
      try {
          cache.removeVolumeLoadObject(volumeId);
      } catch {
        // Ignore
      }
    };
  }, [initMPR, volumeId]);

  // Keep Cornerstone's camera synchronized with the CSS layout. The engine
  // recalculates the canvas aspect ratio when the window or sidebars change.
  useEffect(() => {
    const elements = [
      ...VIEWPORT_ORDER.map(plane => viewportRefs.current[plane]),
      volume3DViewportRef.current,
    ].filter(
      (element): element is HTMLDivElement => Boolean(element)
    );
    const resizeObserver = new ResizeObserver(() => {
      const engine = renderingEngineRef.current;
      if (!engine) return;

      engine.resize(false, true);
      engine.renderViewports(ALL_VIEWPORT_IDS);
    });

    elements.forEach(element => resizeObserver.observe(element));
    return () => resizeObserver.disconnect();
  }, []);

  const getViewportClass = (viewportId: ViewportId) => {
    if (showVolume3D) return 'mpr-viewport-container hidden';
    if (maximizedViewport === null) return 'mpr-viewport-container';
    if (maximizedViewport === viewportId) return 'mpr-viewport-container maximized';
    return 'mpr-viewport-container hidden';
  };

  const renderViewports = () => (
    <>
      {VIEWPORT_ORDER.map(plane => {
        return (
          <div key={plane} className={getViewportClass(plane)}>
            <div className="mpr-viewport-label">{t(`mpr.${plane}`)} · {t('mpr.reconstruction')}</div>
            <div
              ref={element => { viewportRefs.current[plane] = element; }}
              className="mpr-viewport"
              onPointerDown={() => {
                focusedViewportRef.current = plane;
              }}
              onPointerMove={event => updateRegionEraserCursor(plane, event)}
              onPointerLeave={() => {
                setRegionEraserCursor(current => current?.plane === plane ? null : current);
              }}
              onClick={event => handleMprClick(plane, event)}
              onDoubleClick={() => handleDoubleClick(plane)}
            >
              {activeTool === 'Eraser' && regionEraserCursor?.plane === plane && (
                <div
                  className="mpr-region-eraser-cursor"
                  style={{
                    left: `${regionEraserCursor.left}px`,
                    top: `${regionEraserCursor.top}px`,
                    width: `${regionEraserCursor.radius * 2}px`,
                    height: `${regionEraserCursor.radius * 2}px`,
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </>
  );

  const renderAnnotationToolbar = () => {
    const toolbar = (
    <div className="mpr-annotation-toolbar">
      <button
        className={`annotation-tool-btn ${activeTool === 'WindowLevel' ? 'active' : ''}`}
        onClick={() => setActiveAnnotationTool('WindowLevel')}
        title={t('toolbar.windowLevel')}
      >
        🖱️ W/L
      </button>
      <div className="mpr-standard-zoom" title="Zoom estándar">
        <button
          className="annotation-tool-btn"
          disabled={isLoading}
          onClick={() => adjustStandardZoom(0.8)}
          title="Alejar"
        >
          −
        </button>
        <button
          className="annotation-tool-btn"
          disabled={isLoading}
          onClick={resetStandardZoom}
          title="Restablecer zoom"
        >
          100%
        </button>
        <button
          className="annotation-tool-btn"
          disabled={isLoading}
          onClick={() => adjustStandardZoom(1.25)}
          title="Acercar"
        >
          +
        </button>
      </div>
      {voxelSegmentationEnabled && (
        <button
          className={`annotation-tool-btn ${showVolume3D ? 'active' : ''}`}
          disabled={isLoading || !segmentationReady}
          onClick={toggleVolume3D}
          title={showVolume3D ? 'Volver a MPR' : 'Mostrar bloque 3D de la segmentación'}
        >
          {showVolume3D ? '▣ MPR' : '▣ 3D'}
        </button>
      )}
      {voxelSegmentationEnabled && (
        <>
          <button
            className={`annotation-tool-btn ${activeTool === 'Brush' ? 'active' : ''}`}
            disabled={!segmentationReady}
            onClick={() => setVoxelSegmentationTool('Brush')}
            title="Pincel voxel"
          >
            🖌 Brush
          </button>
          <button
            className={`annotation-tool-btn ${activeTool === 'Eraser' ? 'active' : ''}`}
            disabled={!segmentationReady || regionGrowBusy}
            onClick={() => setVoxelSegmentationTool('Eraser')}
            title="Borrar la región segmentada conectada al voxel seleccionado"
          >
            ◌ Eraser
          </button>
          <button
            className={`annotation-tool-btn ${activeTool === 'BrushEraser' ? 'active' : ''}`}
            disabled={!segmentationReady}
            onClick={() => setVoxelSegmentationTool('BrushEraser')}
            title="Borrador circular voxel a voxel"
          >
            ◌ Circle
          </button>
          <button
            className={`annotation-tool-btn ${activeTool === 'RegionGrow' ? 'active' : ''}`}
            disabled={!segmentationReady || regionGrowBusy}
            onClick={() => setVoxelSegmentationTool('RegionGrow')}
            title="Crecimiento de región 3D por valores HU"
          >
            {regionGrowBusy ? '… Grow' : '◉ Grow'}
          </button>
          {(activeTool === 'RegionGrow' || activeTool === 'Eraser') && (
            <>
              <label className="mpr-region-grow-control">
                <span>HU ±</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={regionGrowTolerance}
                  onChange={event => setRegionGrowTolerance(
                    Math.max(1, Math.min(500, Number(event.target.value) || 1))
                  )}
                  disabled={regionGrowBusy}
                />
              </label>
              <label className="mpr-region-grow-control">
                <span>Conn.</span>
                <select
                  value={regionGrowConnectivity}
                  onChange={event => setRegionGrowConnectivity(
                    Number(event.target.value) as RegionGrowConnectivity
                  )}
                  disabled={regionGrowBusy}
                >
                  <option value={6}>6</option>
                  <option value={18}>18</option>
                  <option value={26}>26</option>
                </select>
              </label>
            </>
          )}
          <label className="mpr-brush-size-control">
            <span>Size</span>
            <input
              type="range"
              min="1"
              max="128"
              value={brushSize}
              onChange={event => updateBrushSize(Number(event.target.value))}
              disabled={!segmentationReady}
            />
            <span>{brushSize}</span>
          </label>
          <button
            className={`annotation-tool-btn ${autoInterpolationEnabled ? 'active' : ''}`}
            disabled={!segmentationReady || interpolationBusy}
            onClick={() => {
              setAutoInterpolationEnabled(enabled => !enabled);
              setInterpolationStatus(null);
            }}
            title="Interpolar automáticamente entre cortes pintados en la vista activa"
          >
            {interpolationBusy ? '… Interp.' : '↕ Auto'}
          </button>
          <button
            className="annotation-tool-btn"
            disabled={!segmentationReady}
            onClick={undoVoxelEdit}
            title={
              activeTool === 'RegionGrow'
                ? 'Deshacer último Grow'
                : activeTool === 'Eraser'
                  ? 'Deshacer último Eraser'
                  : 'Deshacer edición voxel'
            }
          >
            ↶
          </button>
          <button
            className="annotation-tool-btn"
            disabled={!segmentationReady}
            onClick={redoVoxelEdit}
            title={
              activeTool === 'RegionGrow'
                ? 'Rehacer último Grow'
                : activeTool === 'Eraser'
                  ? 'Rehacer último Eraser'
                  : 'Rehacer edición voxel'
            }
          >
            ↷
          </button>
          <span className="mpr-segmentation-status">
            {segmentationDirty ? '● unsaved' : '✓ saved'}
          </span>
          {autoInterpolationEnabled && interpolationStatus && (
            <span className="mpr-interpolation-status" title={interpolationStatus}>
              {interpolationStatus}
            </span>
          )}
          {(activeTool === 'RegionGrow' || activeTool === 'Eraser') && regionGrowStatus && (
            <span className="mpr-interpolation-status" title={regionGrowStatus}>
              {regionGrowStatus}
            </span>
          )}
          <span className="mpr-active-segment" title="Estructura voxel activa">
            <span
              className="mpr-segment-color"
              style={{ backgroundColor: activeCtSinusesFeature.color }}
            />
            {activeCtSinusesFeature.label}
          </span>
          <button
            className={`annotation-tool-btn ${activeSegmentLocked ? 'active' : ''}`}
            disabled={!segmentationReady}
            onClick={toggleActiveSegmentLock}
            title={activeSegmentLocked ? 'Desbloquear segmento' : 'Bloquear segmento'}
          >
            {activeSegmentLocked ? '🔒' : '🔓'}
          </button>
          <button
            className={`annotation-tool-btn ${activeSegmentVisible ? 'active' : ''}`}
            disabled={!segmentationReady}
            onClick={toggleActiveSegmentVisibility}
            title={activeSegmentVisible ? 'Ocultar segmento' : 'Mostrar segmento'}
          >
            {activeSegmentVisible ? '◉' : '○'}
          </button>
          <button
            className="annotation-tool-btn"
            disabled={!segmentationReady || segmentationBusy}
            onClick={() => void saveVoxelSegmentation()}
            title="Guardar como nuevo DICOM SEG"
          >
            {segmentationBusy ? '…' : '💾 Nueva versión'}
          </button>
          <select
            className="mpr-segmentation-select"
            value={selectedSavedSegmentationId}
            onChange={event => setSelectedSavedSegmentationId(event.target.value)}
            disabled={segmentationBusy}
            aria-label="Segmentaciones guardadas"
          >
            <option value="">Abrir segmentación guardada…</option>
            {savedSegmentations.map(object => (
              <option key={object.id} value={object.id}>
                v{object.version} · {new Date(object.createdAt).toLocaleString()} · {object.createdBy || 'usuario'}
                {object.status === 'superseded' ? ' · supersedida' : ''}
              </option>
            ))}
          </select>
          <button
            className="annotation-tool-btn"
            disabled={!selectedSavedSegmentationId || !segmentationReady || segmentationBusy}
            onClick={() => void openSavedSegmentation()}
            title="Reconstruir el Labelmap desde el DICOM SEG"
          >
            Abrir
          </button>
        </>
      )}
      {!voxelSegmentationEnabled && <span className="mpr-readonly-indicator">🔒 {t('viewer.spatialOnly')}</span>}
      {segmentationError && <span className="mpr-segmentation-error">⚠ {segmentationError}</span>}
      {segmentationOperationError && <span className="mpr-segmentation-error">⚠ {segmentationOperationError}</span>}
    </div>
    );

    if (annotationToolbarHost) {
      return createPortal(toolbar, annotationToolbarHost);
    }
    // The standalone MPR route has no global viewer header. Keep its local
    // toolbar in that context; embedded MPR uses the global AnnotationToolbar.
    return embedded ? null : toolbar;
  };

  if (embedded) {
    return (
      <div className="mpr-view-embedded">
        {error && (
          <div className="mpr-error">
            <span>⚠ {localizeError(t, error, 'errors.mprInit')}</span>
          </div>
        )}

        {isLoading && (
          <div className="mpr-loading">
            <div className="loading-spinner"></div>
            <p>{t('mpr.loading')}</p>
          </div>
        )}

        {renderAnnotationToolbar()}

        <div className={`mpr-grid ${maximizedViewport || showVolume3D ? 'single-viewport' : ''} ${showVolume3D ? 'volume-3d-active' : ''}`}>
          {renderViewports()}
          <div className={`mpr-viewport-container mpr-volume-3d-container ${showVolume3D ? 'active' : 'hidden'}`}>
            <div className="mpr-viewport-label">
              Volumen 3D · {surface3DStatus === 'building' ? 'generando…' : 'segmentación'}
            </div>
            <div
              ref={volume3DViewportRef}
              className="mpr-viewport"
              onPointerDown={() => setShowVolume3D(true)}
              onClick={handleVolume3DClick}
            />
          </div>
        </div>

        <div className="mpr-tools-info">
          <span>{t('mpr.left', { tool: t('mpr.windowLevel') })}</span>
          <span>{t('mpr.right')}</span>
          <span>{t('mpr.middle')}</span>
          <span>Ctrl + rueda: Zoom</span>
          <span>{t('mpr.wheel')}</span>
          <span>{t('mpr.ctrl')}</span>
          <span>{t('mpr.doubleClick')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mpr-view">
      <div className="mpr-header">
        <button className="mpr-back-btn" onClick={onBack}>
          {t('mpr.back')}
        </button>
        <h3>{t('mpr.title', {
          series: series.seriesDescription || t('series.label', { number: series.seriesNumber }),
        })}</h3>
        <span className="mpr-info">{t('mpr.images', { count: series.instances.length })}</span>
      </div>

      {error && (
        <div className="mpr-error">
          <span>⚠ {localizeError(t, error, 'errors.mprInit')}</span>
        </div>
      )}

      {isLoading && (
        <div className="mpr-loading">
          <div className="loading-spinner"></div>
          <p>{t('mpr.loading')}</p>
        </div>
      )}

      {renderAnnotationToolbar()}

      <div className={`mpr-grid ${maximizedViewport || showVolume3D ? 'single-viewport' : ''} ${showVolume3D ? 'volume-3d-active' : ''}`}>
        {renderViewports()}
        <div className={`mpr-viewport-container mpr-volume-3d-container ${showVolume3D ? 'active' : 'hidden'}`}>
          <div className="mpr-viewport-label">
            Volumen 3D · {surface3DStatus === 'building' ? 'generando…' : 'segmentación'}
          </div>
          <div
            ref={volume3DViewportRef}
            className="mpr-viewport"
            onPointerDown={() => setShowVolume3D(true)}
            onClick={handleVolume3DClick}
          />
        </div>
      </div>

      <div className="mpr-tools-info">
        <span>{t('mpr.left', { tool: t('mpr.windowLevel') })}</span>
        <span>{t('mpr.right')}</span>
        <span>{t('mpr.middle')}</span>
        <span>{t('mpr.wheel')}</span>
        <span>{t('mpr.ctrl')}</span>
        <span>{t('mpr.doubleClick')}</span>
      </div>
    </div>
  );
};

export default MPRView;
