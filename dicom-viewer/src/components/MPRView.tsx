import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  RenderingEngine,
  Enums,
  metaData,
  volumeLoader,
  cache,
  setVolumesForViewports,
  eventTarget,
} from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import * as polySeg from '@cornerstonejs/polymorphic-segmentation';
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

type ViewportId = 'axial' | 'sagittal' | 'coronal';

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
  const segmentationIdRef = useRef<string | null>(null);
  const volumeId = getMprVolumeId(studyInstanceUID, series.seriesInstanceUID);

  const activeCtSinusesFeature = CT_SINUSES_FEATURES.find(feature =>
    feature.key === activeCtSinusesFeatureKey
  ) || CT_SINUSES_FEATURES[0];

  const handleDoubleClick = useCallback((viewportId: ViewportId) => {
    focusedViewportRef.current = viewportId;
    setMaximizedViewport(prev => prev === viewportId ? null : viewportId);
  }, []);

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

  const setVoxelSegmentationTool = useCallback((toolName: 'Brush' | 'Eraser' | 'WindowLevel') => {
    if (!toolGroupRef.current || !segmentationReady) return;
    const { WindowLevelTool, BrushTool } = cornerstoneTools;
    const brush = toolGroupRef.current.getToolInstance?.(BrushTool.toolName);
    const nextTool = toolName === 'Eraser' ? BrushTool.toolName : toolName;

    [WindowLevelTool.toolName, BrushTool.toolName].forEach(candidate => {
      toolGroupRef.current.setToolPassive(candidate);
    });

    if (nextTool === BrushTool.toolName) {
      brush?.setActiveStrategy?.(
        toolName === 'Eraser' ? 'ERASE_INSIDE_CIRCLE' : 'FILL_INSIDE_CIRCLE'
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

  const undoVoxelEdit = useCallback(() => {
    const brush = toolGroupRef.current?.getToolInstance?.(cornerstoneTools.BrushTool.toolName);
    brush?.undo?.();
  }, []);

  const redoVoxelEdit = useCallback(() => {
    const brush = toolGroupRef.current?.getToolInstance?.(cornerstoneTools.BrushTool.toolName);
    brush?.redo?.();
  }, []);

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

        if (!surfaceData.geometryIds?.size) {
          const computedSurfaceData = await polySeg.computeSurfaceData(segmentationId, { viewport });
          const hasRenderableGeometry = Array.from(computedSurfaceData?.geometryIds?.values?.() || [])
            .some((geometryId: unknown) => {
              if (typeof geometryId !== 'string') return false;
              const surface = (cache.getGeometry(geometryId) as any)?.data;
              return surface?.points?.length >= 9 && surface?.polys?.length >= 4;
            });
          if (!hasRenderableGeometry) {
            throw new Error('No se generó una superficie. Pinta una región más amplia en uno o más cortes.');
          }
          surfaceData.geometryIds = computedSurfaceData.geometryIds;
        }

        cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationModified(
          segmentationId
        );
        window.setTimeout(() => {
          viewport.resetCamera?.();
          viewport.getRenderer?.().resetCameraClippingRange?.();
          viewport.render?.();
          setSurface3DStatus('ready');
        }, 120);
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
              onPointerDown={() => { focusedViewportRef.current = plane; }}
              onDoubleClick={() => handleDoubleClick(plane)}
            />
          </div>
        );
      })}
    </>
  );

  const renderAnnotationToolbar = () => (
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
            disabled={!segmentationReady}
            onClick={() => setVoxelSegmentationTool('Eraser')}
            title="Borrador voxel"
          >
            ◌ Eraser
          </button>
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
            className="annotation-tool-btn"
            disabled={!segmentationReady}
            onClick={undoVoxelEdit}
            title="Undo voxel"
          >
            ↶
          </button>
          <button
            className="annotation-tool-btn"
            disabled={!segmentationReady}
            onClick={redoVoxelEdit}
            title="Redo voxel"
          >
            ↷
          </button>
          <span className="mpr-segmentation-status">
            {segmentationDirty ? '● unsaved' : '✓ saved'}
          </span>
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
