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
import { DicomInstance, DicomSeries } from '../types/dicom';
import { dicomWebService, mergeDefinedDicomMetadata } from '../services/dicomWeb';
import { localizeError, useTranslation } from '../i18n';

interface MPRViewProps {
  studyInstanceUID: string;
  series: DicomSeries;
  onBack: () => void;
  embedded?: boolean;
  nativeImageIndex?: number;
  onNativeSliceChange?: (imageIndex: number) => void;
}

const AXIAL_VIEWPORT_ID = 'mpr-axial';
const SAGITTAL_VIEWPORT_ID = 'mpr-sagittal';
const CORONAL_VIEWPORT_ID = 'mpr-coronal';
const TOOL_GROUP_ID = 'mpr-tool-group';

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
}) => {
  const { t } = useTranslation();
  const viewportRefs = useRef<Record<ViewportId, HTMLDivElement | null>>({
    axial: null,
    sagittal: null,
    coronal: null,
  });
  const preparedInstancesRef = useRef<DicomInstance[]>([]);
  const lastNativeSliceRef = useRef<number>(nativeImageIndex);
  const synchronizingMprRef = useRef(false);
  const renderingEngineRef = useRef<RenderingEngine | null>(null);
  const toolGroupRef = useRef<any>(null);
  const initializationGenerationRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maximizedViewport, setMaximizedViewport] = useState<ViewportId | null>(null);
  const [activeTool, setActiveTool] = useState<string>('WindowLevel');
  const volumeId = getMprVolumeId(studyInstanceUID, series.seriesInstanceUID);

  const handleDoubleClick = useCallback((viewportId: ViewportId) => {
    setMaximizedViewport(prev => prev === viewportId ? null : viewportId);
    
    setTimeout(() => {
      if (renderingEngineRef.current) {
        renderingEngineRef.current.resize(false, true);
      }
    }, 100);
  }, []);

  const setActiveAnnotationTool = useCallback((toolName: string) => {
    if (!toolGroupRef.current) return;

    // MPR panes are reconstructed views.  They remain useful for orientation
    // and crosshair navigation, but never become annotation targets.
    if (toolName !== cornerstoneTools.WindowLevelTool.toolName) {
      setActiveTool(cornerstoneTools.WindowLevelTool.toolName);
      return;
    }

    const { WindowLevelTool } = cornerstoneTools;

    toolGroupRef.current.setToolPassive(WindowLevelTool.toolName);

    toolGroupRef.current.setToolActive(toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });

    setActiveTool(toolName);
  }, []);

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
        ToolGroupManager,
        addTool,
      } = cornerstoneTools;

      addTool(PanTool);
      addTool(ZoomTool);
      addTool(WindowLevelTool);
      addTool(StackScrollTool);
      addTool(CrosshairsTool);

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

      const viewportInputs = VIEWPORT_ORDER.map(plane => ({
        viewportId: VIEWPORT_CONFIG[plane].id,
        element: viewportRefs.current[plane]!,
        type: Enums.ViewportType.ORTHOGRAPHIC,
        defaultOptions: {
          orientation: VIEWPORT_CONFIG[plane].orientation,
        },
      }));

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
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
        });

        toolGroup.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
        });

        toolGroup.setToolActive(CrosshairsTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Ctrl }],
        });

      }

      await setVolumesForViewports(
        renderingEngine,
        [{ volumeId }],
        VIEWPORT_ORDER.map(plane => VIEWPORT_CONFIG[plane].id)
      );
      if (generation !== initializationGenerationRef.current) return;

      const activeViewportIds = VIEWPORT_ORDER.map(plane => VIEWPORT_CONFIG[plane].id);
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
  }, [studyInstanceUID, series.seriesInstanceUID, volumeId]);

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
      if (renderingEngineRef.current) {
        renderingEngineRef.current.destroy();
        renderingEngineRef.current = null;
      }
      try {
          cache.removeVolumeLoadObject(volumeId);
      } catch (e) {
        // Ignore
      }
    };
  }, [initMPR]);

  // Keep Cornerstone's camera synchronized with the CSS layout. The engine
  // recalculates the canvas aspect ratio when the window or sidebars change.
  useEffect(() => {
    const activeViewportIds = VIEWPORT_ORDER.map(plane => VIEWPORT_CONFIG[plane].id);
    const elements = VIEWPORT_ORDER.map(plane => viewportRefs.current[plane]).filter(
      (element): element is HTMLDivElement => Boolean(element)
    );
    const resizeObserver = new ResizeObserver(() => {
      const engine = renderingEngineRef.current;
      if (!engine) return;

      engine.resize(false, true);
      engine.renderViewports(activeViewportIds);
    });

    elements.forEach(element => resizeObserver.observe(element));
    return () => resizeObserver.disconnect();
  }, []);

  const getViewportClass = (viewportId: ViewportId) => {
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
      <span className="mpr-readonly-indicator">🔒 {t('viewer.spatialOnly')}</span>
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

        <div className={`mpr-grid ${maximizedViewport ? 'single-viewport' : ''}`}>
          {renderViewports()}
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

      <div className={`mpr-grid ${maximizedViewport ? 'single-viewport' : ''}`}>
        {renderViewports()}
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
