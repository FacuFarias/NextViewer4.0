import { useState, useEffect, useCallback, useRef } from 'react';
import { ViewerState, DicomStudy, DicomSeries } from '../types/dicom';
import type { AnnotationImageMetadata, AnnotationSet, CreateAnnotationPayload, PersistedAnnotation } from '../types/annotations';
import { dicomWebService } from '../services/dicomWeb';
import { getAccessToken } from '../services/auth';
import { annotationService } from '../services/annotations';
import { getViewerImageId, resolveViewerModality } from '../services/viewerModality';
import {
  annotationToGeometry,
  geometryToWorldPoints,
  geometryTypeForTool,
  getReferencedImageId,
} from '../services/annotationGeometry';
import { getConfig } from '../services/config';
import {
  CT_SINUSES_TOOL_NAME,
  CtSinusesFeature,
  CT_SINUSES_FEATURES,
  clearCtSinusesSegmentation,
  initializeCtSinusesSegmentation,
  setActiveCtSinusesFeature as activateCtSinusesFeature,
} from '../services/ctSinusesMeasurements';
import {
  NASAL_SEPTUM_DEVIATION_CODE,
  NASAL_SEPTUM_DEVIATION_COLOR,
  NASAL_SEPTUM_DEVIATION_LABEL,
  NASAL_SEPTUM_DEVIATION_TOOL_NAME,
} from '../services/nasalSeptumDeviation';
import {
  initializeCornerstone,
  configureDicomLoader,
  createRenderingEngine,
  createToolGroup,
  setupToolGroup,
  registerTools,
  loadImageToCache,
  isImageCached,
  cornerstoneTools,
  Enums,
  eventTarget,
} from '../services/cornerstone';
import {
  cancelStudyPreload,
  clearPreloadQueue,
  enqueueStudiesPreload,
  getPreloadQueue,
  resumePersistedPreloadQueue,
  subscribeToPreloadQueue,
  toggleStudyPreload,
} from '../services/preloadQueue';
import type { PreloadQueueState } from '../services/preloadQueue';

const PRELOAD_RANGE = 10;
const STACK_NEW_IMAGE = 'CORNERSTONE_STACK_NEW_IMAGE';

export interface SeriesPreloadProgress {
  loaded: number;
  total: number;
  failed: number;
  done: boolean;
}

export interface ExternalAnnotationContext {
  viewport?: any;
  isMpr?: boolean;
  mprViewportId?: string;
  referenceImageIndex?: number;
}

export interface ViewerMeasurement {
  annotationUID: string;
  persistentId?: string;
  toolName: string;
  labelCode?: string;
  imageIndex: number;
  seriesInstanceUID?: string;
  seriesNumber?: number;
  instanceNumber?: number;
  sopInstanceUID?: string;
  measurementType?: string;
  axisLengthMm?: number;
  deviationLengthMm?: number;
  pixelPoints?: Array<{ x: number; y: number }>;
  value: string;
  color: string;
  source?: string;
  version?: number;
  saveStatus?: 'saving' | 'saved' | 'error';
  saveError?: string;
}

const MEASUREMENT_TOOL_LABELS: Record<string, string> = {
  Length: 'Distancia',
  CircleROI: 'ROI circular',
  Angle: 'Ángulo',
  Bidirectional: 'Bidireccional',
  RectangleROI: 'Rectángulo',
  ArrowAnnotate: 'Flecha',
  [NASAL_SEPTUM_DEVIATION_TOOL_NAME]: NASAL_SEPTUM_DEVIATION_LABEL,
};

const MEASUREMENT_TOOL_COLORS: Record<string, string> = {
  Length: '#42a5f5',
  CircleROI: '#66bb6a',
  Angle: '#ffa726',
  Bidirectional: '#ab47bc',
  RectangleROI: '#26a69a',
  ArrowAnnotate: '#ef5350',
  [NASAL_SEPTUM_DEVIATION_TOOL_NAME]: NASAL_SEPTUM_DEVIATION_COLOR,
};

const GEOMETRY_TOOL_LABELS: Record<string, string> = {
  polyline: 'Distancia',
  circle: 'ROI circular',
  angle: 'Ángulo',
  bidirectional: 'Bidireccional',
  rectangle: 'Rectángulo',
  arrow: 'Flecha',
  polygon: 'Polígono',
  [NASAL_SEPTUM_DEVIATION_CODE]: NASAL_SEPTUM_DEVIATION_LABEL,
};

const GEOMETRY_TOOL_COLORS: Record<string, string> = {
  polyline: '#42a5f5',
  circle: '#66bb6a',
  angle: '#ffa726',
  bidirectional: '#ab47bc',
  rectangle: '#26a69a',
  arrow: '#ef5350',
  polygon: '#90a4ae',
  [NASAL_SEPTUM_DEVIATION_CODE]: NASAL_SEPTUM_DEVIATION_COLOR,
};

function selectDefaultStudySeries(seriesList: DicomSeries[]): DicomSeries | undefined {
  // MINICAT studies conventionally expose Axial, Sagittal and Coronal as
  // series 1, 2 and 3. Prefer an explicit sagittal description when the PACS
  // provides one, then use series number 2, and finally the second item as the
  // compatibility fallback for datasets without descriptions/numbers.
  const sagittalSeries = seriesList.find(series => {
    const description = series.seriesDescription.toLowerCase();
    return description.includes('sagitt') || description.includes('sagital');
  });
  return sagittalSeries ||
    seriesList.find(series => Number(series.seriesNumber) === 2) ||
    seriesList[1] ||
    seriesList[0];
}

function getAnnotationToolName(annotation: any): string {
  return annotation?.toolName || annotation?.metadata?.toolName || annotation?.data?.toolName || '';
}

function getCtFeature(annotation: any): CtSinusesFeature | undefined {
  const featureKey = annotation?.data?.ctSinusesMinicat?.featureKey ||
    annotation?.metadata?.ctSinusesMinicat?.featureKey;
  const segmentIndex = annotation?.data?.segmentation?.segmentIndex ??
    annotation?.metadata?.ctSinusesMinicat?.segmentIndex;

  return (featureKey && CT_SINUSES_FEATURES.find(feature => feature.key === featureKey)) ||
    (typeof segmentIndex === 'number' && CT_SINUSES_FEATURES.find(feature => feature.segmentIndex === segmentIndex));
}

function persistedDisplayMetadata(annotation: PersistedAnnotation): { toolName: string; color: string } {
  const feature = annotation.labelCode && CT_SINUSES_FEATURES.find(item => item.key === annotation.labelCode);
  const legacyGenericPolygon = annotation.geometryType === 'polygon' && annotation.toolName === 'Medición';
  return {
    toolName: feature?.label || (legacyGenericPolygon
      ? 'Polígono'
      : annotation.labelName || annotation.toolName || GEOMETRY_TOOL_LABELS[annotation.geometryType] || 'Medición'),
    color: annotation.color || feature?.color || GEOMETRY_TOOL_COLORS[annotation.geometryType] || '#90a4ae',
  };
}

function formatMeasurementValue(annotation: any): string {
  const nasalSeptum = annotation.data?.nasalSeptumDeviation;
  if (typeof nasalSeptum?.axisLengthMm === 'number' && typeof nasalSeptum?.deviationLengthMm === 'number') {
    return `Eje: ${nasalSeptum.axisLengthMm.toFixed(1)} mm · Desviación: ${nasalSeptum.deviationLengthMm.toFixed(1)} mm`;
  }
  const stats = Object.values(annotation.data?.cachedStats || {})[0] as any;
  if (!stats) return 'Sin valor';

  if (typeof stats.length === 'number') return `${stats.length.toFixed(1)} mm`;
  if (typeof stats.area === 'number') return `${stats.area.toFixed(1)} mm²`;
  if (typeof stats.angle === 'number') return `${stats.angle.toFixed(1)}°`;
  if (typeof stats.width === 'number' && typeof stats.height === 'number') {
    return `${stats.width.toFixed(1)} × ${stats.height.toFixed(1)} mm`;
  }
  return 'Sin valor';
}

function formatPersistedMeasurementValue(annotation: PersistedAnnotation): string {
  const shape = annotation.geometry.shape as Record<string, any> | undefined;
  if (shape?.measurement === NASAL_SEPTUM_DEVIATION_CODE &&
      typeof shape.axis_length_mm === 'number' &&
      typeof shape.deviation_length_mm === 'number') {
    return `Eje: ${shape.axis_length_mm.toFixed(1)} mm · Desviación: ${shape.deviation_length_mm.toFixed(1)} mm`;
  }
  const stats = annotation.geometry.shape?.cachedStats as Record<string, any> | undefined;
  const firstStats = stats ? Object.values(stats)[0] as any : undefined;
  if (!firstStats) return 'Sin valor';
  if (typeof firstStats.length === 'number') return `${firstStats.length.toFixed(1)} mm`;
  if (typeof firstStats.area === 'number') return `${firstStats.area.toFixed(1)} mm²`;
  if (typeof firstStats.angle === 'number') return `${firstStats.angle.toFixed(1)}°`;
  if (typeof firstStats.width === 'number' && typeof firstStats.height === 'number') {
    return `${firstStats.width.toFixed(1)} × ${firstStats.height.toFixed(1)} mm`;
  }
  return 'Sin valor';
}

const initialState: ViewerState = {
  viewMode: 'studies',
  layoutMode: 'stack',
  isLoaded: false,
  isLoading: false,
  error: null,
  currentStudy: null,
  currentSeries: null,
  currentInstance: null,
  windowLevel: {
    windowWidth: 4096,
    windowCenter: 2048,
  },
  imageIndex: 0,
};

export function useDicomViewer() {
  const [state, setState] = useState<ViewerState>(initialState);
  const [studies, setStudies] = useState<DicomStudy[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderingEngineRef = useRef<any>(null);
  const toolGroupRef = useRef<any>(null);
  const imageIdsRef = useRef<string[]>([]);
  const dicomLoaderReadyRef = useRef<Promise<void> | null>(null);
  const preloadTimerRef = useRef<number | null>(null);
  const viewerOperationRef = useRef(0);
  const imageLoadPromisesRef = useRef(new Map<string, Promise<any>>());
  // The persistent preload queue reports raw DICOM availability. Keep this
  // runtime map for the SeriesPanel API; native navigation now decodes on
  // demand instead of decoding every slice when a series opens.
  const preloadProgress: Record<string, SeriesPreloadProgress> = {};
  const [preloadQueue, setPreloadQueue] = useState<PreloadQueueState>(getPreloadQueue());
  const [measurements, setMeasurements] = useState<ViewerMeasurement[]>([]);
  const [persistedAnnotations, setPersistedAnnotations] = useState<PersistedAnnotation[]>([]);
  const [annotationSaveStates, setAnnotationSaveStates] = useState<Record<string, { status: 'saving' | 'saved' | 'error'; error?: string }>>({});
  const [hasPendingAnnotationChanges, setHasPendingAnnotationChanges] = useState(false);
  const ctSinusesSegmentationIdRef = useRef<string | null>(null);
  const activeCtSinusesFeatureRef = useRef<CtSinusesFeature | null>(null);
  const currentStudyUIDRef = useRef<string | null>(null);
  const currentSeriesRef = useRef<DicomSeries | null>(null);
  const annotationSetRef = useRef<AnnotationSet | null>(null);
  const persistedAnnotationsRef = useRef(new Map<string, PersistedAnnotation>());
  const studyPersistedAnnotationsRef = useRef(new Map<string, PersistedAnnotation>());
  const persistedStudyUIDRef = useRef<string | null>(null);
  const pendingAnnotationsRef = useRef(new Map<string, any>());
  const annotationSavePromisesRef = useRef(new Map<string, Promise<void>>());
  const annotationPersistTimersRef = useRef(new Map<string, number>());

  useEffect(() => {
    const unsubscribe = subscribeToPreloadQueue(setPreloadQueue);
    void resumePersistedPreloadQueue();
    return unsubscribe;
  }, []);
  
  const renderingEngineId = 'dicomRenderingEngine';
  const viewportId = 'dicomViewport';
  const toolGroupId = 'dicomToolGroup';

  const ensureDicomLoaderReady = useCallback((): Promise<void> => {
    if (!dicomLoaderReadyRef.current) {
      dicomLoaderReadyRef.current = (async () => {
        await initializeCornerstone();
        registerTools();

        const token = await getAccessToken();
        configureDicomLoader({
          'Authorization': `Bearer ${token}`,
        });
        console.log('DICOM loader configured with auth token');
      })();
    }

    return dicomLoaderReadyRef.current;
  }, []);

  useEffect(() => {
    void ensureDicomLoaderReady().catch(error => {
      console.error('Failed to configure DICOM loader:', error);
    });
  }, [ensureDicomLoaderReady]);

  const preloadAdjacentImages = useCallback((currentIndex: number) => {
    if (!imageIdsRef.current.length) return;

    if (preloadTimerRef.current) {
      clearTimeout(preloadTimerRef.current);
    }

    preloadTimerRef.current = window.setTimeout(() => {
      const start = Math.max(0, currentIndex - PRELOAD_RANGE);
      const end = Math.min(imageIdsRef.current.length - 1, currentIndex + PRELOAD_RANGE);

      let count = 0;
      for (let i = start; i <= end; i++) {
        const imageId = imageIdsRef.current[i];
        if (!isImageCached(imageId) && !imageLoadPromisesRef.current.has(imageId)) {
          const request = loadImageToCache(imageId).finally(() => {
            imageLoadPromisesRef.current.delete(imageId);
          });
          imageLoadPromisesRef.current.set(imageId, request);
          request.catch(() => {});
          count++;
        }
      }

      if (count > 0) {
        console.log(`Pre-loading ${count} images around index ${currentIndex}`);
      }
    }, 50);
  }, []);

  const refreshMeasurements = useCallback(() => {
    const imageIds = imageIdsRef.current;
    const instances = currentSeriesRef.current?.instances || [];
    const currentSeriesUID = currentSeriesRef.current?.seriesInstanceUID;
    const allPersisted = new Map<string, PersistedAnnotation>(studyPersistedAnnotationsRef.current);
    persistedAnnotationsRef.current.forEach(annotation => allPersisted.set(annotation.id, annotation));

    const findPersistedForAnnotation = (annotation: any): PersistedAnnotation | undefined => {
      const annotationId = annotation.metadata?.annotationId;
      return persistedAnnotationsRef.current.get(annotation.annotationUID) ||
        (annotationId ? allPersisted.get(annotationId) : undefined) ||
        Array.from(allPersisted.values()).find(item => item.cornerstoneAnnotationUID === annotation.annotationUID);
    };

    const liveMeasurements = cornerstoneTools.annotation.state
      .getAllAnnotations()
      .map((annotation: any): ViewerMeasurement | null => {
        const referencedImageId = annotation.metadata?.referencedImageId || annotation.data?.referencedImageId;
        const imageIndex = typeof referencedImageId === 'string'
          ? imageIds.indexOf(referencedImageId)
          : -1;
        const annotationSeriesUID = annotation.data?.ctSinusesMinicat?.seriesInstanceUID;

        const persistent = findPersistedForAnnotation(annotation);
        if (imageIndex < 0 && !persistent && annotationSeriesUID !== currentSeriesUID) return null;
        const saveState = annotationSaveStates[annotation.annotationUID] ||
          (persistent ? { status: 'saved' as const } : undefined);
        const persistentDisplay = persistent ? persistedDisplayMetadata(persistent) : undefined;
        const annotationToolName = getAnnotationToolName(annotation);
        const annotationFeature = getCtFeature(annotation);
        const liveNasalSeptum = annotation.data?.nasalSeptumDeviation;
        const persistedShape = persistent?.geometry.shape as Record<string, any> | undefined;
        const measurementType = persistedShape?.measurement ||
          (annotationToolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME ? NASAL_SEPTUM_DEVIATION_CODE : undefined);

        return {
          annotationUID: annotation.annotationUID,
          persistentId: persistent?.id,
          labelCode: persistent?.labelCode || annotation.data?.ctSinusesMinicat?.featureKey,
          toolName: persistentDisplay?.toolName || MEASUREMENT_TOOL_LABELS[annotationToolName] || annotationFeature?.label || annotationToolName || 'Medición',
          imageIndex,
          seriesInstanceUID: persistent?.seriesInstanceUID || annotationSeriesUID || (imageIndex >= 0 ? currentSeriesUID : undefined),
          seriesNumber: persistent?.imageMetadata?.seriesNumber || (imageIndex >= 0 ? currentSeriesRef.current?.seriesNumber : undefined),
          instanceNumber: persistent?.instanceNumber ?? instances[imageIndex]?.instanceNumber,
          sopInstanceUID: persistent?.sopInstanceUID || instances[imageIndex]?.sopInstanceUID,
          measurementType,
          axisLengthMm: typeof persistedShape?.axis_length_mm === 'number'
            ? persistedShape.axis_length_mm
            : liveNasalSeptum?.axisLengthMm,
          deviationLengthMm: typeof persistedShape?.deviation_length_mm === 'number'
            ? persistedShape.deviation_length_mm
            : liveNasalSeptum?.deviationLengthMm,
          pixelPoints: persistent?.geometry.points,
          value: persistent ? formatPersistedMeasurementValue(persistent) : formatMeasurementValue(annotation),
          color: persistentDisplay?.color || (annotationFeature?.color
            || annotation.data?.color || annotation.metadata?.color || MEASUREMENT_TOOL_COLORS[annotationToolName] || '#90a4ae'),
          source: persistent?.source,
          version: persistent?.version,
          saveStatus: saveState?.status,
          saveError: saveState?.error,
        };
      })
      .filter((measurement): measurement is ViewerMeasurement => measurement !== null)
      ;

    const representedPersistentIds = new Set(
      liveMeasurements.map(measurement => measurement.persistentId).filter(Boolean)
    );
    const representedAnnotationUIDs = new Set(liveMeasurements.map(measurement => measurement.annotationUID));
    const persistedOnlyMeasurements = Array.from(allPersisted.values())
      .filter(annotation =>
        !representedPersistentIds.has(annotation.id) &&
        !representedAnnotationUIDs.has(annotation.cornerstoneAnnotationUID || `server-${annotation.id}`)
      )
      .map((annotation): ViewerMeasurement => {
        const shape = annotation.geometry.shape as Record<string, any> | undefined;
        const isCurrentSeries = annotation.seriesInstanceUID === currentSeriesUID;
        const imageIndex = isCurrentSeries
          ? instances.findIndex(instance => instance.sopInstanceUID === annotation.sopInstanceUID)
          : -1;
        const display = persistedDisplayMetadata(annotation);
        return {
          annotationUID: annotation.cornerstoneAnnotationUID || `server-${annotation.id}`,
          persistentId: annotation.id,
          labelCode: annotation.labelCode,
          toolName: display.toolName,
          imageIndex,
          seriesInstanceUID: annotation.seriesInstanceUID,
          seriesNumber: annotation.imageMetadata?.seriesNumber,
          instanceNumber: annotation.instanceNumber ?? undefined,
          sopInstanceUID: annotation.sopInstanceUID,
          measurementType: shape?.measurement,
          axisLengthMm: typeof shape?.axis_length_mm === 'number' ? shape.axis_length_mm : undefined,
          deviationLengthMm: typeof shape?.deviation_length_mm === 'number' ? shape.deviation_length_mm : undefined,
          pixelPoints: annotation.geometry.points,
          value: formatPersistedMeasurementValue(annotation),
          color: display.color,
          source: annotation.source,
          version: annotation.version,
          saveStatus: 'saved',
        };
      });

    const nextMeasurements = [...liveMeasurements, ...persistedOnlyMeasurements]
      .sort((a, b) => {
        const seriesOrder = (a.seriesNumber ?? Number.MAX_SAFE_INTEGER) -
          (b.seriesNumber ?? Number.MAX_SAFE_INTEGER);
        if (seriesOrder !== 0) return seriesOrder;
        return (a.imageIndex < 0 ? Number.MAX_SAFE_INTEGER : a.imageIndex) -
          (b.imageIndex < 0 ? Number.MAX_SAFE_INTEGER : b.imageIndex);
      });

    setMeasurements(nextMeasurements);
  }, [annotationSaveStates]);

  const ensureAnnotationSet = useCallback(async (studyInstanceUID: string): Promise<AnnotationSet | null> => {
    try {
      const sets = await annotationService.listAnnotationSets(studyInstanceUID);
      const draft = sets.find(set => set.status === 'draft');
      const annotationSet = draft || await annotationService.createAnnotationSet({
        studyInstanceUID,
        name: `Anotaciones ${studyInstanceUID}`,
        description: 'Conjunto automático de anotaciones del visor',
        ontologyVersion: 'v1',
        status: 'draft',
        isDefault: true,
      });
      annotationSetRef.current = annotationSet;
      return annotationSet;
    } catch (error) {
      console.error('Failed to initialize annotation set:', error);
      annotationSetRef.current = null;
      return null;
    }
  }, []);

  const loadStudyPersistedAnnotations = useCallback(async (
    studyInstanceUID: string,
    annotationSetId: string
  ): Promise<void> => {
    const items: PersistedAnnotation[] = [];
    let offset = 0;
    const limit = 500;

    do {
      const result = await annotationService.listAnnotations({
        studyInstanceUID,
        annotationSetId,
        latestOnly: true,
        limit,
        offset,
      });
      items.push(...result.items);
      offset += result.items.length;
      if (!result.items.length || offset >= result.total) break;
    } while (offset < 10000);

    studyPersistedAnnotationsRef.current.clear();
    items.forEach(annotation => studyPersistedAnnotationsRef.current.set(annotation.id, annotation));
    persistedStudyUIDRef.current = studyInstanceUID;
    setPersistedAnnotations(items);
    console.info('[Viewer] anotaciones cargadas para todo el estudio', {
      studyInstanceUID,
      annotationSetId,
      total: items.length,
    });
  }, []);

  const restorePersistedAnnotations = useCallback(async (
    annotationSet: AnnotationSet,
    studyInstanceUID: string,
    series: DicomSeries,
    imageIds: string[],
    viewport: any
  ) => {
    try {
      const result = await annotationService.listAnnotations({
        studyInstanceUID,
        seriesInstanceUID: series.seriesInstanceUID,
        annotationSetId: annotationSet.id,
        latestOnly: true,
        limit: 500,
        offset: 0,
      });
      const existingAnnotations = new Map(
        cornerstoneTools.annotation.state.getAllAnnotations().map((item: any) => [item.annotationUID, item])
      );
      const existingUIDs = new Set(existingAnnotations.keys());

      persistedAnnotationsRef.current.clear();
      const viewportFrameOfReferenceUID = viewport.getFrameOfReferenceUID?.();
      const currentImageId = viewport.getCurrentImageId?.();
      const currentImageIndex = typeof currentImageId === 'string'
        ? imageIds.indexOf(currentImageId)
        : -1;
      const initialImageIndex = currentImageIndex >= 0 ? currentImageIndex : 0;
      let conversionImageIndex = initialImageIndex;

      console.info('[Viewer] iniciando restauración de anotaciones', {
        seriesInstanceUID: series.seriesInstanceUID,
        total: result.items.length,
        initialImageIndex,
      });

      try {
        for (const persisted of result.items) {
          const instanceIndex = series.instances.findIndex(instance => instance.sopInstanceUID === persisted.sopInstanceUID);
          const annotationUID = persisted.cornerstoneAnnotationUID || `server-${persisted.id}`;
          const existingAnnotation = existingAnnotations.get(annotationUID);
          if (instanceIndex < 0) {
            console.info('[Viewer] anotación omitida durante restauración', {
              id: persisted.id,
              annotationUID,
              instanceIndex,
              alreadyInCornerstone: Boolean(existingAnnotation),
            });
            continue;
          }

          const imageId = imageIds[instanceIndex];
          if (!imageId) continue;

          // Rebuild persisted annotations even when Cornerstone already has
          // the same UID. The global annotation state survives a viewport
          // remount, but its World points may belong to the previous viewport
          // image data/camera. The persisted patientPoints are authoritative.
          if (existingAnnotation) {
            cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
            existingAnnotations.delete(annotationUID);
            existingUIDs.delete(annotationUID);
          }

          // IMAGE_PIXEL must be converted with the imageData of the target
          // DICOM instance. Using the first stack image here produces valid
          // world coordinates for the wrong slice, so Cornerstone filters the
          // annotation out after navigating to its real SOP Instance UID.
          if (conversionImageIndex !== instanceIndex) {
            console.info('[Viewer] cambiando imagen para convertir anotación', {
              id: persisted.id,
              from: conversionImageIndex,
              to: instanceIndex,
              sopInstanceUID: persisted.sopInstanceUID,
            });
            // Keep the existing StackViewport and change only its current
            // image. Recreating the stack for every annotation resets the
            // image data/camera while the annotation is being converted and
            // can leave the world points attached to the wrong slice.
            if (typeof viewport.setImageIdIndex === 'function') {
              await viewport.setImageIdIndex(instanceIndex);
            } else {
              await viewport.setStack(imageIds, instanceIndex);
            }
            conversionImageIndex = instanceIndex;
          }

          const worldPoints = geometryToWorldPoints(persisted, viewport);
          if (!worldPoints.length) {
            console.warn('[Viewer] anotación sin puntos convertibles', {
              id: persisted.id,
              annotationUID,
              instanceIndex,
              imageId,
            });
            continue;
          }

          const viewReference = typeof viewport.getViewReference === 'function'
            ? viewport.getViewReference({ points: [worldPoints[0]] })
            : {};

          const display = persistedDisplayMetadata(persisted);
          const persistedFeature = persisted.labelCode && CT_SINUSES_FEATURES.find(feature => feature.key === persisted.labelCode);
          const isLegacyPolygon = persisted.geometryType === 'polygon' && persisted.toolName === 'Medición';
          const isNasalSeptumDeviation = persisted.geometryType === NASAL_SEPTUM_DEVIATION_CODE ||
            persisted.toolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME ||
            persisted.labelCode === NASAL_SEPTUM_DEVIATION_CODE;
          const restoredToolName = isNasalSeptumDeviation
            ? NASAL_SEPTUM_DEVIATION_TOOL_NAME
            : (persistedFeature || isLegacyPolygon
            ? CT_SINUSES_TOOL_NAME
            : persisted.toolName || persisted.geometryType);
          const shape = persisted.geometry.shape as Record<string, unknown> | undefined;
          const contourPoints = restoredToolName === CT_SINUSES_TOOL_NAME && worldPoints.length >= 3
            ? [
                ...worldPoints,
                worldPoints[0],
              ]
            : worldPoints;
          const storedSegmentIndex = shape?.segmentIndex;
          const segmentIndex = persistedFeature?.segmentIndex ||
            (typeof storedSegmentIndex === 'number' ? storedSegmentIndex : undefined) ||
            (isLegacyPolygon ? CT_SINUSES_FEATURES[0].segmentIndex : undefined);
          const restoredAnnotation: any = {
            annotationUID,
            toolName: restoredToolName,
            highlighted: false,
            invalidated: false,
            isVisible: true,
            metadata: {
              // The view reference is required by Cornerstone's annotation
              // filtering, especially after changing the stack image.
              ...viewReference,
              toolName: restoredToolName,
              color: display.color,
              referencedImageId: imageId,
              annotationId: persisted.id,
              pixelSpacing: persisted.imageMetadata.pixelSpacing || shape?.pixel_spacing,
              FrameOfReferenceUID: persisted.imageMetadata.frameOfReferenceUID || viewportFrameOfReferenceUID,
            },
            data: {
              handles: {
                points: worldPoints,
                activeHandleIndex: null,
                textBox: { hasMoved: false },
              },
              color: display.color,
              cachedStats: persisted.geometry.shape?.cachedStats || {},
              ...(isNasalSeptumDeviation
                ? {
                    nasalSeptumDeviation: {
                      step: 4,
                      pixelSpacing: Array.isArray(shape?.pixel_spacing)
                        ? [Number(shape.pixel_spacing[0]), Number(shape.pixel_spacing[1])] as [number, number]
                        : persisted.imageMetadata.pixelSpacing,
                      axisLengthMm: typeof shape?.axis_length_mm === 'number' ? shape.axis_length_mm : undefined,
                      deviationLengthMm: typeof shape?.deviation_length_mm === 'number' ? shape.deviation_length_mm : undefined,
                    },
                  }
                : {
                    contour: {
                      // Cornerstone's SVG path renderer fills a closed path
                      // more reliably when the first point is explicitly
                      // repeated, especially for contours hydrated from API
                      // data instead of created interactively.
                      polyline: contourPoints,
                      closed: shape?.closed === true || restoredToolName === CT_SINUSES_TOOL_NAME,
                    },
                  }),
            },
          };

          if (restoredToolName === CT_SINUSES_TOOL_NAME) {
            restoredAnnotation.data.segmentation = {
              segmentationId: ctSinusesSegmentationIdRef.current,
              segmentIndex,
            };
            if (persistedFeature) {
              restoredAnnotation.data.ctSinusesMinicat = { featureKey: persistedFeature.key };
            }
          }

          try {
            cornerstoneTools.annotation.state.addAnnotation(
              restoredAnnotation,
              viewport.element || viewportId
            );
            if (restoredToolName === CT_SINUSES_TOOL_NAME) {
              // Hydrated annotations must keep their original Stack world
              // points. Apply the fill directly to this annotation instead of
              // re-registering it in the segmentation representation: that
              // registration can make Cornerstone re-project the contour with
              // a different image reference and move it away from the target
              // DICOM slice.
              cornerstoneTools.annotation.config.style.setAnnotationStyles(
                annotationUID,
                {
                  color: display.color,
                  fillColor: display.color,
                  fillOpacity: 0.35,
                  lineWidth: 2,
                }
              );
            }
            existingUIDs.add(annotationUID);
            persistedAnnotationsRef.current.set(annotationUID, persisted);
            console.info('[Viewer] anotación restaurada', {
              id: persisted.id,
              annotationUID,
              toolName: restoredToolName,
              sopInstanceUID: persisted.sopInstanceUID,
              instanceIndex,
              imageId,
              pointCount: worldPoints.length,
            });
          } catch (error) {
            console.error('Failed to restore annotation:', persisted.id, error);
          }
        }
      } finally {
        if (conversionImageIndex !== initialImageIndex) {
          if (typeof viewport.setImageIdIndex === 'function') {
            await viewport.setImageIdIndex(initialImageIndex);
          } else {
            await viewport.setStack(imageIds, initialImageIndex);
          }
          conversionImageIndex = initialImageIndex;
        }
      }
      // Adding an annotation updates the state manager, but explicitly render
      // here because the stack may have finished loading before the API call.
      viewport.render?.();
      refreshMeasurements();
    } catch (error) {
      console.error('Failed to load persisted annotations:', error);
    }
  }, [refreshMeasurements]);

  const persistAnnotation = useCallback((annotation: any, context: ExternalAnnotationContext = {}) => {
    const annotationUID = annotation?.annotationUID;
    if (!annotationUID || !currentSeriesRef.current || !currentStudyUIDRef.current) return;

    const queued = annotationSavePromisesRef.current.get(annotationUID) || Promise.resolve();
    const operation = queued.then(async () => {
      setAnnotationSaveStates(prev => ({ ...prev, [annotationUID]: { status: 'saving' } }));
      setHasPendingAnnotationChanges(true);
      refreshMeasurements();

      const annotationSet = annotationSetRef.current;
      const activeViewport = context.viewport || renderingEngineRef.current?.getViewport(viewportId);
      const imageId = getReferencedImageId(annotation);
      let imageIndex = imageId ? imageIdsRef.current.indexOf(imageId) : -1;

      if (context.isMpr && context.referenceImageIndex !== undefined) {
        imageIndex = Math.max(0, Math.min(
          currentSeriesRef.current.instances.length - 1,
          Math.round(context.referenceImageIndex)
        ));
      }

      const instance = currentSeriesRef.current?.instances[imageIndex];
      if (!annotationSet || !instance || imageIndex < 0 || !activeViewport) {
        pendingAnnotationsRef.current.set(annotationUID, annotation);
        setHasPendingAnnotationChanges(true);
        setAnnotationSaveStates(prev => ({
          ...prev,
          [annotationUID]: { status: 'error', error: 'El conjunto de anotaciones todavía no está listo' },
        }));
        refreshMeasurements();
        return;
      }

      const annotationToolName = getAnnotationToolName(annotation);
      const isCtAnnotation = annotation.data?.segmentation?.segmentationId === ctSinusesSegmentationIdRef.current ||
        annotationToolName === CT_SINUSES_TOOL_NAME;
      const feature = getCtFeature(annotation) || (isCtAnnotation ? activeCtSinusesFeatureRef.current || undefined : undefined);
      const isNasalSeptumDeviation = annotationToolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME ||
        annotation.metadata?.toolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME;
      const toolName = isNasalSeptumDeviation
        ? NASAL_SEPTUM_DEVIATION_TOOL_NAME
        : (isCtAnnotation ? CT_SINUSES_TOOL_NAME : annotationToolName || 'Medición');
      const imageMetadata: AnnotationImageMetadata = {
        modality: currentSeriesRef.current?.modality,
        rows: instance.rows,
        columns: instance.columns,
        pixelSpacing: instance.pixelSpacing || annotation.metadata?.pixelSpacing,
        imagePositionPatient: instance.imagePositionPatient,
        imageOrientationPatient: instance.imageOrientationPatient,
        frameOfReferenceUID: instance.frameOfReferenceUID || activeViewport?.getFrameOfReferenceUID?.(),
        seriesNumber: currentSeriesRef.current?.seriesNumber,
      };
      const geometry = annotationToGeometry(annotation, activeViewport, imageMetadata);
      if (context.isMpr) {
        geometry.shape = {
          ...(geometry.shape || {}),
          mpr: true,
          mprViewportId: context.mprViewportId,
        };
      }
      if (isNasalSeptumDeviation) {
        console.info('[Viewer] payload Nasal Septum Deviation', {
          annotationUID,
          imageIndex,
          sopInstanceUID: instance.sopInstanceUID,
          geometryType: geometryTypeForTool(toolName),
          points: geometry.points,
          shape: geometry.shape,
        });
      }
      if (!geometry.points.length) {
        pendingAnnotationsRef.current.set(annotationUID, annotation);
        setAnnotationSaveStates(prev => ({
          ...prev,
          [annotationUID]: { status: 'error', error: 'No se pudieron convertir los puntos a coordenadas DICOM' },
        }));
        refreshMeasurements();
        return;
      }

      const isClosedContour = toolName === CT_SINUSES_TOOL_NAME;
      const contourIsComplete = geometry.points.length >= 3 && geometry.shape?.closed === true;
      if (isClosedContour && !contourIsComplete) {
        pendingAnnotationsRef.current.set(annotationUID, annotation);
        setHasPendingAnnotationChanges(true);
        setAnnotationSaveStates(prev => ({
          ...prev,
          [annotationUID]: {
            status: 'error',
            error: 'El contorno anatómico debe estar cerrado y tener al menos tres puntos',
          },
        }));
        refreshMeasurements();
        return;
      }

      const nasalShape = geometry.shape as Record<string, any> | undefined;
      const nasalIsComplete = isNasalSeptumDeviation &&
        geometry.points.length >= 4 &&
        nasalShape?.measurement === NASAL_SEPTUM_DEVIATION_CODE &&
        Number.isFinite(nasalShape.axis_length_mm) &&
        Number.isFinite(nasalShape.deviation_length_mm) &&
        Array.isArray(nasalShape.pixel_spacing) &&
        nasalShape.pixel_spacing.length >= 2;
      if (isNasalSeptumDeviation && !nasalIsComplete) {
        pendingAnnotationsRef.current.set(annotationUID, annotation);
        setHasPendingAnnotationChanges(true);
        setAnnotationSaveStates(prev => ({
          ...prev,
          [annotationUID]: {
            status: 'error',
            error: annotation.data?.nasalSeptumDeviation?.error ||
              'La medición requiere tres puntos y Pixel Spacing válido',
          },
        }));
        refreshMeasurements();
        return;
      }

      const payload: CreateAnnotationPayload = {
        annotationSetId: annotationSet.id,
        studyInstanceUID: currentStudyUIDRef.current,
        seriesInstanceUID: currentSeriesRef.current.seriesInstanceUID,
        sopInstanceUID: instance.sopInstanceUID,
        frameNumber: annotation.metadata?.frameNumber ?? null,
        instanceNumber: instance.instanceNumber,
        labelCode: isNasalSeptumDeviation
          ? NASAL_SEPTUM_DEVIATION_CODE
          : feature?.key || toolName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        labelName: isNasalSeptumDeviation
          ? NASAL_SEPTUM_DEVIATION_LABEL
          : feature?.label || MEASUREMENT_TOOL_LABELS[toolName] || GEOMETRY_TOOL_LABELS[geometryTypeForTool(toolName)] || toolName,
        toolName,
        color: isNasalSeptumDeviation
          ? NASAL_SEPTUM_DEVIATION_COLOR
          : feature?.color || MEASUREMENT_TOOL_COLORS[toolName] || GEOMETRY_TOOL_COLORS[geometryTypeForTool(toolName)] || null,
        geometryType: geometryTypeForTool(toolName),
        geometry,
        source: 'HUMAN',
        status: 'draft',
        cornerstoneAnnotationUID: annotationUID,
        imageMetadata,
        clientMutationId: `annotation-${annotationUID}`,
      };

      const existing = persistedAnnotationsRef.current.get(annotationUID);

      try {
        const saved = existing
          ? await annotationService.updateAnnotation(existing.id, {
              labelCode: payload.labelCode,
              labelName: payload.labelName,
              toolName: payload.toolName,
              color: payload.color,
              geometryType: payload.geometryType,
              geometry: payload.geometry,
              expectedVersion: existing.version,
              cornerstoneAnnotationUID: annotationUID,
            })
          : await annotationService.createAnnotation(payload);
        persistedAnnotationsRef.current.set(annotationUID, saved);
        studyPersistedAnnotationsRef.current.set(saved.id, saved);
        setPersistedAnnotations(prev => [
          ...prev.filter(item => item.id !== saved.id),
          saved,
        ]);
        annotation.metadata = { ...annotation.metadata, annotationId: saved.id };
        pendingAnnotationsRef.current.delete(annotationUID);
        setAnnotationSaveStates(prev => ({ ...prev, [annotationUID]: { status: 'saved' } }));
      } catch (error) {
        pendingAnnotationsRef.current.set(annotationUID, annotation);
        setHasPendingAnnotationChanges(true);
        setAnnotationSaveStates(prev => ({
          ...prev,
          [annotationUID]: { status: 'error', error: error instanceof Error ? error.message : 'No se pudo guardar' },
        }));
      }
      refreshMeasurements();
    });

    annotationSavePromisesRef.current.set(annotationUID, operation);
    void operation.finally(() => {
      if (annotationSavePromisesRef.current.get(annotationUID) === operation) {
        annotationSavePromisesRef.current.delete(annotationUID);
        if (pendingAnnotationsRef.current.size === 0) {
          setHasPendingAnnotationChanges(false);
        }
      }
    });
  }, [refreshMeasurements]);

  const saveMeasurement = useCallback((annotationUID: string) => {
    const annotation = pendingAnnotationsRef.current.get(annotationUID) ||
      cornerstoneTools.annotation.state.getAllAnnotations().find(
        (item: any) => item.annotationUID === annotationUID
      );

    if (!annotation) return;
    pendingAnnotationsRef.current.set(annotationUID, annotation);
    persistAnnotation(annotation);
  }, [persistAnnotation]);

  const persistMprAnnotation = useCallback((
    annotation: any,
    viewport: any,
    mprViewportId: string,
    referenceImageIndex: number
  ) => {
    persistAnnotation(annotation, {
      viewport,
      isMpr: true,
      mprViewportId,
      referenceImageIndex,
    });
  }, [persistAnnotation]);

  const scheduleAnnotationPersistence = useCallback((annotation: any, delay = 120) => {
    const annotationUID = annotation?.annotationUID;
    if (!annotationUID) return;

    const existingTimer = annotationPersistTimersRef.current.get(annotationUID);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      annotationPersistTimersRef.current.delete(annotationUID);
      persistAnnotation(annotation);
    }, delay);
    annotationPersistTimersRef.current.set(annotationUID, timer);
  }, [persistAnnotation]);

  const handleStackNewImage = useCallback((event: any) => {
    const { imageIdIndex, viewportId: eventViewportId } = event.detail;
    
    if (eventViewportId !== viewportId) return;
    
    setState(prev => ({
      ...prev,
      imageIndex: imageIdIndex,
      currentInstance: prev.currentSeries?.instances[imageIdIndex] || null,
    }));

    preloadAdjacentImages(imageIdIndex);
  }, [preloadAdjacentImages]);

  const handleCtSinusesAnnotationCompleted = useCallback((event: any) => {
    const annotation = event.detail?.annotation;
    const segmentation = annotation?.data?.segmentation;
    const feature = getCtFeature(annotation) || activeCtSinusesFeatureRef.current;

    if (annotation && getAnnotationToolName(annotation) === NASAL_SEPTUM_DEVIATION_TOOL_NAME) {
      console.info('[Viewer] ANNOTATION_COMPLETED Nasal Septum Deviation', {
        annotationUID: annotation.annotationUID,
        metadata: annotation.metadata,
        points: annotation.data?.handles?.points,
        nasalSeptumDeviation: annotation.data?.nasalSeptumDeviation,
      });
    }

    if (
      annotation &&
      feature &&
      (segmentation?.segmentationId === ctSinusesSegmentationIdRef.current ||
        getAnnotationToolName(annotation) === CT_SINUSES_TOOL_NAME)
    ) {
      const referencedImageId = annotation.metadata?.referencedImageId;
      const imageIndex = imageIdsRef.current.indexOf(referencedImageId);
      const instance = currentSeriesRef.current?.instances[imageIndex];
      const metadata = {
        studyInstanceUID: currentStudyUIDRef.current,
        seriesInstanceUID: currentSeriesRef.current?.seriesInstanceUID,
        sopInstanceUID: instance?.sopInstanceUID,
        featureKey: feature.key,
        segmentIndex: feature.segmentIndex,
      };

      annotation.toolName = CT_SINUSES_TOOL_NAME;
      annotation.data.segmentation = {
        ...annotation.data.segmentation,
        segmentationId: ctSinusesSegmentationIdRef.current,
        segmentIndex: feature.segmentIndex,
      };
      annotation.data.ctSinusesMinicat = metadata;
      annotation.metadata = {
        ...annotation.metadata,
        toolName: CT_SINUSES_TOOL_NAME,
        color: feature.color,
        ctSinusesMinicat: metadata,
      };
      annotation.data.color = feature.color;
    }
    if (annotation) {
      // Freehand contour completion updates the polyline immediately before
      // the event, but allowing one tick also covers the contour segmentation
      // listener and guarantees that all points have been committed.
      scheduleAnnotationPersistence(annotation, 50);
    }
    refreshMeasurements();
  }, [refreshMeasurements, scheduleAnnotationPersistence]);

  const retryMeasurement = useCallback((annotationUID: string) => {
    saveMeasurement(annotationUID);
  }, [saveMeasurement]);

  const handleAnnotationModified = useCallback((event: any) => {
    refreshMeasurements();
    if (event.detail?.annotation) scheduleAnnotationPersistence(event.detail.annotation);
  }, [refreshMeasurements, scheduleAnnotationPersistence]);

  const handleAnnotationRemoved = useCallback(() => {
    refreshMeasurements();
  }, [refreshMeasurements]);

  const initViewport = useCallback(() => {
    if (!viewportRef.current || renderingEngineRef.current) {
      return;
    }

    try {
      console.log('Initializing viewport...');
      const renderingEngine = createRenderingEngine(renderingEngineId);
      renderingEngineRef.current = renderingEngine;

      const viewportInput = {
        viewportId,
        element: viewportRef.current,
        type: Enums.ViewportType.STACK,
      };

      renderingEngine.enableElement(viewportInput);

      const toolGroup = createToolGroup(toolGroupId);
      toolGroupRef.current = toolGroup;
      setupToolGroup(toolGroup, viewportId);

      viewportRef.current.addEventListener(STACK_NEW_IMAGE, handleStackNewImage);
      eventTarget.addEventListener(
        cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,
        handleCtSinusesAnnotationCompleted
      );
      eventTarget.addEventListener(
        cornerstoneTools.Enums.Events.ANNOTATION_MODIFIED,
        handleAnnotationModified
      );
      eventTarget.addEventListener(
        cornerstoneTools.Enums.Events.ANNOTATION_REMOVED,
        handleAnnotationRemoved
      );
      
      const resizeObserver = new ResizeObserver(() => {
        if (renderingEngineRef.current) {
          renderingEngineRef.current.resize();
        }
      });
      resizeObserver.observe(viewportRef.current);
      
      console.log('Viewport initialized successfully');
    } catch (error) {
      console.error('Failed to setup viewport:', error);
    }
  }, [handleStackNewImage, handleCtSinusesAnnotationCompleted, handleAnnotationModified, handleAnnotationRemoved]);

  const clearCurrentCtSinusesSegmentation = useCallback(() => {
    clearCtSinusesSegmentation(ctSinusesSegmentationIdRef.current);
    ctSinusesSegmentationIdRef.current = null;
    activeCtSinusesFeatureRef.current = null;
  }, []);

  const destroyViewport = useCallback(() => {
    annotationPersistTimersRef.current.forEach(timer => window.clearTimeout(timer));
    annotationPersistTimersRef.current.clear();
    viewportRef.current?.removeEventListener(STACK_NEW_IMAGE, handleStackNewImage);
    eventTarget.removeEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,
      handleCtSinusesAnnotationCompleted
    );
    eventTarget.removeEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_MODIFIED,
      handleAnnotationModified
    );
    eventTarget.removeEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_REMOVED,
      handleAnnotationRemoved
    );

    if (toolGroupRef.current) {
      try {
        cornerstoneTools.ToolGroupManager.destroyToolGroup(toolGroupId);
      } catch {
        // The tool group may already have been destroyed during unmount.
      }
      toolGroupRef.current = null;
    }

    if (renderingEngineRef.current) {
      renderingEngineRef.current.destroy();
      renderingEngineRef.current = null;
    }
  }, [handleStackNewImage, handleCtSinusesAnnotationCompleted, handleAnnotationModified, handleAnnotationRemoved]);

  const restoreStackViewport = useCallback(async (imageIndex = 0) => {
    await new Promise<void>(resolve => window.setTimeout(resolve, 50));
    initViewport();

    if (!renderingEngineRef.current || !imageIdsRef.current.length) return;

    await ensureDicomLoaderReady();

    const viewport = renderingEngineRef.current.getViewport(viewportId);
    const safeIndex = Math.min(imageIndex, imageIdsRef.current.length - 1);
    await viewport.setStack(imageIdsRef.current, safeIndex);

    if (ctSinusesSegmentationIdRef.current && currentStudyUIDRef.current && currentSeriesRef.current) {
      initializeCtSinusesSegmentation(
        viewportId,
        currentStudyUIDRef.current,
        currentSeriesRef.current.seriesInstanceUID
      );
    }

    if (annotationSetRef.current && currentStudyUIDRef.current && currentSeriesRef.current) {
      await restorePersistedAnnotations(
        annotationSetRef.current,
        currentStudyUIDRef.current,
        currentSeriesRef.current,
        imageIdsRef.current,
        viewport
      );
    }

    viewport.render();
  }, [ensureDicomLoaderReady, initViewport, restorePersistedAnnotations]);

  useEffect(() => {
    if (state.viewMode === 'viewer' && viewportRef.current && !renderingEngineRef.current) {
      setTimeout(() => {
        initViewport();
      }, 100);
    } else if (state.viewMode !== 'viewer' && renderingEngineRef.current) {
      destroyViewport();
    }
  }, [state.viewMode, initViewport, destroyViewport]);

  useEffect(() => {
    return () => destroyViewport();
  }, [destroyViewport]);

  const loadStudies = useCallback(async (query: Record<string, string> = {}) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const studiesData = await dicomWebService.searchStudies(query);
      setStudies(studiesData);
      setState(prev => ({ ...prev, isLoading: false }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load studies',
      }));
    }
  }, []);

  const navigateToStudies = useCallback(() => {
    viewerOperationRef.current += 1;
    clearCurrentCtSinusesSegmentation();
    destroyViewport();
    currentStudyUIDRef.current = null;
    currentSeriesRef.current = null;
    imageIdsRef.current = [];
    
    setState(prev => ({
      ...prev,
      viewMode: 'studies',
      isLoaded: false,
      currentStudy: null,
      currentSeries: null,
      currentInstance: null,
      imageIndex: 0,
    }));
  }, [clearCurrentCtSinusesSegmentation, destroyViewport]);

  const loadStudy = useCallback(async (study: DicomStudy) => {
    const operation = ++viewerOperationRef.current;
    setState(prev => ({ ...prev, isLoading: true, error: null, viewMode: 'viewer' }));
    
    try {
      const seriesList = await dicomWebService.getStudySeries(study.studyInstanceUID);
        if (operation !== viewerOperationRef.current) return;
      
      const fullStudy: DicomStudy = {
        ...study,
        series: seriesList,
      };
      
      setState(prev => ({
        ...prev,
        currentStudy: fullStudy,
        isLoading: false,
      }));
      
      if (seriesList.length > 0) {
        const defaultSeries = selectDefaultStudySeries(seriesList);
        console.info('[Viewer] serie inicial seleccionada', {
          seriesInstanceUID: defaultSeries?.seriesInstanceUID,
          seriesNumber: defaultSeries?.seriesNumber,
          description: defaultSeries?.seriesDescription,
        });
        await loadSeries(study.studyInstanceUID, defaultSeries || seriesList[0], operation);
      }
    } catch (error) {
      if (operation !== viewerOperationRef.current) return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load study',
      }));
    }
  }, []);

  const loadStudyByUID = useCallback(async (studyInstanceUID: string) => {
    const operation = ++viewerOperationRef.current;
    setState(prev => ({ ...prev, isLoading: true, error: null, viewMode: 'viewer' }));
    
    try {
      const studiesData = await dicomWebService.searchStudies({});
      if (operation !== viewerOperationRef.current) return;
      const studyData = studiesData.find(s => s.studyInstanceUID === studyInstanceUID);
      
      if (!studyData) {
        throw new Error('Study not found');
      }

      const seriesList = await dicomWebService.getStudySeries(studyInstanceUID);
      if (operation !== viewerOperationRef.current) return;
      
      const fullStudy: DicomStudy = {
        ...studyData,
        series: seriesList,
      };
      
      setState(prev => ({
        ...prev,
        currentStudy: fullStudy,
        isLoading: false,
      }));
      
      if (seriesList.length > 0) {
        const defaultSeries = selectDefaultStudySeries(seriesList);
        console.info('[Viewer] serie inicial seleccionada', {
          seriesInstanceUID: defaultSeries?.seriesInstanceUID,
          seriesNumber: defaultSeries?.seriesNumber,
          description: defaultSeries?.seriesDescription,
        });
        await loadSeries(studyInstanceUID, defaultSeries || seriesList[0], operation);
      }
    } catch (error) {
      if (operation !== viewerOperationRef.current) return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load study',
      }));
    }
  }, []);

  const waitForViewport = useCallback(async (maxWait = 3000): Promise<boolean> => {
    const startTime = Date.now();
    while (!renderingEngineRef.current && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !!renderingEngineRef.current;
  }, []);

  const loadSeries = useCallback(async (
    studyInstanceUID: string,
    series: DicomSeries,
    expectedOperation?: number
  ) => {
    const operation = expectedOperation ?? ++viewerOperationRef.current;
    if (operation !== viewerOperationRef.current) return;
    annotationPersistTimersRef.current.forEach(timer => window.clearTimeout(timer));
    annotationPersistTimersRef.current.clear();
    clearCurrentCtSinusesSegmentation();
    currentStudyUIDRef.current = studyInstanceUID;
    currentSeriesRef.current = series;
    if (persistedStudyUIDRef.current !== studyInstanceUID) {
      studyPersistedAnnotationsRef.current.clear();
      setPersistedAnnotations([]);
      persistedStudyUIDRef.current = studyInstanceUID;
    }
    setMeasurements([]);
    setAnnotationSaveStates({});
    annotationSetRef.current = null;
    persistedAnnotationsRef.current.clear();
    setHasPendingAnnotationChanges(false);
    setState(prev => ({
      ...prev,
      isLoading: true,
      isLoaded: false,
      currentInstance: null,
      imageIndex: 0,
      error: null,
    }));
    
    try {
      const annotationSetPromise = ensureAnnotationSet(studyInstanceUID);
      let instances = await dicomWebService.getSeriesInstances(
        studyInstanceUID,
        series.seriesInstanceUID
      );
      if (operation !== viewerOperationRef.current) return;
      
      instances.sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0));
      
      const fullSeries: DicomSeries = {
        ...series,
        instances,
      };
      currentSeriesRef.current = fullSeries;
      
      setState(prev => ({
        ...prev,
        currentSeries: fullSeries,
        isLoading: false,
      }));
      
      if (instances.length > 0) {
        // Resolve the rendering strategy once per series. A US series must
        // never mix the native WADO loader and the dedicated US color loader.
        const viewerModality = resolveViewerModality(series.modality);
        const imageIds = instances.map((instance) => {
          const imageUrl = dicomWebService.getInstanceWadoUriUrl(
            studyInstanceUID,
            series.seriesInstanceUID,
            instance.sopInstanceUID
          );
          return getViewerImageId(viewerModality, imageUrl);
        });
        
        imageIdsRef.current = imageIds;
        refreshMeasurements();
        
        const viewportReady = await waitForViewport();
      if (operation !== viewerOperationRef.current) return;
        
        if (viewportReady && renderingEngineRef.current) {
          // Cornerstone's WADO loader does not receive the token through the
          // fetch-based DICOMweb service. Wait until its XHR hook is installed
          // before setStack starts any pixel requests.
          await ensureDicomLoaderReady();
          if (operation !== viewerOperationRef.current) return;

          const viewport = renderingEngineRef.current.getViewport(viewportId);
          
          let windowWidth = 4096;
          let windowCenter = 2048;
          
          const firstMetadata = await dicomWebService.getInstanceMetadata(
            studyInstanceUID,
            series.seriesInstanceUID,
            instances[0].sopInstanceUID
          );
          if (operation !== viewerOperationRef.current) return;
          
          if (firstMetadata.windowWidth && firstMetadata.windowCenter) {
            windowWidth = Number(firstMetadata.windowWidth);
            windowCenter = Number(firstMetadata.windowCenter);
            console.log('Using DICOM Window Level:', { windowWidth, windowCenter });
          } else if (firstMetadata.bitsStored) {
            const maxVal = Math.pow(2, firstMetadata.bitsStored) - 1;
            windowWidth = maxVal;
            windowCenter = maxVal / 2;
            console.log('Using bits stored for Window Level:', { windowWidth, windowCenter });
          } else if (instances[0].bitsAllocated) {
            const maxVal = Math.pow(2, instances[0].bitsAllocated) - 1;
            windowWidth = maxVal;
            windowCenter = maxVal / 2;
            console.log('Using bits allocated for Window Level:', { windowWidth, windowCenter });
          }
          
          const updatedInstances = instances.map((inst, idx) => {
            if (idx === 0 && firstMetadata.windowWidth) {
              return {
                ...inst,
                ...firstMetadata,
              };
            }
            return inst;
          });
          
          imageIdsRef.current = imageIds;
          
          console.log('Loading images:', imageIds.length);
          // The native stack is ready as soon as its first image is available.
          // Do not wait for the background series decode or the MPR volume.
          await viewport.setStack(imageIds, 0);
          if (operation !== viewerOperationRef.current) return;
          // Persistent preload stores the original DICOM responses. Decode only
          // a small neighborhood for immediate native navigation; decoding the
          // complete series here competes with the native viewport and MPR.
          preloadAdjacentImages(0);

          if (
            getConfig().ctSinusesMinicatMeasurementsEnabled &&
            series.modality === 'CT'
          ) {
            try {
              ctSinusesSegmentationIdRef.current = initializeCtSinusesSegmentation(
                viewportId,
                studyInstanceUID,
                series.seriesInstanceUID
              );
            } catch (segmentationError) {
              console.error('Failed to initialize CT Sinuses measurements:', segmentationError);
              ctSinusesSegmentationIdRef.current = null;
            }
          }
          
          viewport.setProperties({
            voiRange: {
              lower: windowCenter - windowWidth / 2,
              upper: windowCenter + windowWidth / 2,
            },
          });
          
          viewport.render();
          
          setState(prev => ({
            ...prev,
            currentSeries: prev.currentSeries ? {
              ...prev.currentSeries,
              instances: updatedInstances,
            } : null,
            isLoaded: true,
            currentInstance: updatedInstances[0],
            imageIndex: 0,
            windowLevel: { windowWidth, windowCenter },
          }));

          currentSeriesRef.current = {
            ...fullSeries,
            instances: updatedInstances,
          };

          const annotationSet = await annotationSetPromise;
          if (
            operation === viewerOperationRef.current &&
            annotationSet &&
            currentStudyUIDRef.current === studyInstanceUID &&
            currentSeriesRef.current?.seriesInstanceUID === series.seriesInstanceUID &&
            renderingEngineRef.current
          ) {
            await loadStudyPersistedAnnotations(studyInstanceUID, annotationSet.id);
            for (const pendingAnnotation of pendingAnnotationsRef.current.values()) {
              persistAnnotation(pendingAnnotation);
            }
            await restorePersistedAnnotations(
              annotationSet,
              studyInstanceUID,
              currentSeriesRef.current,
              imageIds,
              renderingEngineRef.current.getViewport(viewportId)
            );
          }
          
          console.log('Images loaded successfully');
          preloadAdjacentImages(0);
        } else {
          console.error('Viewport not ready after waiting');
          setState(prev => ({
            ...prev,
            error: 'Viewport not ready. Please try again.',
          }));
        }
      }
    } catch (error) {
      if (operation !== viewerOperationRef.current) return;
      console.error('Failed to load series:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load series',
      }));
    }
  }, [
    clearCurrentCtSinusesSegmentation,
    waitForViewport,
    preloadAdjacentImages,
    refreshMeasurements,
    ensureAnnotationSet,
    loadStudyPersistedAnnotations,
    restorePersistedAnnotations,
    ensureDicomLoaderReady,
  ]);

  const removeMeasurement = useCallback(async (annotationUID: string) => {
    const persisted = persistedAnnotationsRef.current.get(annotationUID) ||
      Array.from(studyPersistedAnnotationsRef.current.values()).find(annotation =>
        annotation.id === annotationUID || annotation.cornerstoneAnnotationUID === annotationUID
      );
    if (persisted) {
      setAnnotationSaveStates(prev => ({ ...prev, [annotationUID]: { status: 'saving' } }));
      try {
        await annotationService.deleteAnnotation(persisted.id, persisted.version);
        persistedAnnotationsRef.current.delete(annotationUID);
        studyPersistedAnnotationsRef.current.delete(persisted.id);
        setPersistedAnnotations(prev => prev.filter(annotation => annotation.id !== persisted.id));
        pendingAnnotationsRef.current.delete(annotationUID);
        cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
        renderingEngineRef.current?.getViewport(viewportId)?.render?.();
        setAnnotationSaveStates(prev => ({ ...prev, [annotationUID]: { status: 'saved' } }));
        if (!pendingAnnotationsRef.current.size) setHasPendingAnnotationChanges(false);
      } catch (error) {
        setAnnotationSaveStates(prev => ({
          ...prev,
          [annotationUID]: { status: 'error', error: error instanceof Error ? error.message : 'No se pudo eliminar' },
        }));
      }
    } else {
      cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
      renderingEngineRef.current?.getViewport(viewportId)?.render?.();
    }
    refreshMeasurements();
  }, [refreshMeasurements]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasPendingAnnotationChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasPendingAnnotationChanges]);

  const setImageIndex = useCallback(async (index: number) => {
    if (!renderingEngineRef.current || !imageIdsRef.current.length) {
      return;
    }

    setState(prev => ({
      ...prev,
      imageIndex: index,
    }));

    try {
      const viewport = renderingEngineRef.current.getViewport(viewportId);
      const safeIndex = Math.max(0, Math.min(index, imageIdsRef.current.length - 1));
      if (typeof viewport.setImageIdIndex === 'function') {
        // Changing the current image keeps the native stack and its camera
        // intact. Recalling setStack for every slice restarts image loading
        // and can block navigation while MPR is decoding the volume.
        await viewport.setImageIdIndex(safeIndex);
      } else {
        await viewport.setStack(imageIdsRef.current, safeIndex);
      }
      viewport.render();
      
      setState(prev => ({
        ...prev,
        imageIndex: safeIndex,
        currentInstance: currentSeriesRef.current?.instances[safeIndex] || null,
      }));

      preloadAdjacentImages(safeIndex);
    } catch (error) {
      console.error('Failed to set image index:', error);
      setState(prev => ({
        ...prev,
        imageIndex: prev.imageIndex,
      }));
    }
  }, [preloadAdjacentImages]);

  const selectMeasurement = useCallback(async (measurement: ViewerMeasurement) => {
    console.info('[Viewer] seleccionando medición', {
      annotationUID: measurement.annotationUID,
      persistentId: measurement.persistentId,
      seriesInstanceUID: measurement.seriesInstanceUID,
      sopInstanceUID: measurement.sopInstanceUID,
      imageIndex: measurement.imageIndex,
    });

    if (
      measurement.seriesInstanceUID &&
      measurement.seriesInstanceUID !== currentSeriesRef.current?.seriesInstanceUID
    ) {
      const targetSeries = state.currentStudy?.series.find(
        series => series.seriesInstanceUID === measurement.seriesInstanceUID
      );
      if (!targetSeries || !currentStudyUIDRef.current) {
        console.warn('[Viewer] no se encontró la serie de la medición', measurement);
        return;
      }
      await loadSeries(currentStudyUIDRef.current, targetSeries);
    }

    let targetIndex = -1;
    if (measurement.sopInstanceUID) {
      targetIndex = currentSeriesRef.current?.instances.findIndex(
        instance => instance.sopInstanceUID === measurement.sopInstanceUID
      ) ?? -1;
      if (targetIndex >= 0) {
        await setImageIndex(targetIndex);
      }
    } else {
      targetIndex = measurement.imageIndex;
      await setImageIndex(measurement.imageIndex);
    }

    const annotations = cornerstoneTools.annotation.state.getAllAnnotations();
    const annotation = annotations
      .find((item: any) => item.annotationUID === measurement.annotationUID) as any;

    // A persisted-only measurement should normally have been reconstructed by
    // loadSeries. Keep a useful diagnostic here if Cornerstone still does not
    // contain it, instead of silently doing nothing after navigation.
    if (!annotation) {
      console.warn('[Viewer] medición no encontrada en Cornerstone después de navegar', {
        annotationUID: measurement.annotationUID,
        persistentId: measurement.persistentId,
        targetIndex,
        currentImageId: renderingEngineRef.current?.getViewport(viewportId)?.getCurrentImageId?.(),
        annotations: annotations.map((item: any) => ({
          annotationUID: item.annotationUID,
          toolName: item.toolName || item.metadata?.toolName,
          referencedImageId: item.metadata?.referencedImageId,
        })),
      });
      return;
    }

    console.info('[Viewer] medición lista para renderizar', {
      annotationUID: annotation.annotationUID,
      targetIndex,
      currentImageId: renderingEngineRef.current?.getViewport(viewportId)?.getCurrentImageId?.(),
      referencedImageId: annotation.metadata?.referencedImageId,
      pointCount: annotation.data?.handles?.points?.length,
    });

    annotations.forEach((item: any) => {
      item.highlighted = item.annotationUID === measurement.annotationUID;
      if (item.annotationUID === measurement.annotationUID) {
        item.invalidated = true;
      }
    });
    annotation.highlighted = true;
    renderingEngineRef.current?.getViewport(viewportId)?.render?.();
    refreshMeasurements();
  }, [loadSeries, refreshMeasurements, setImageIndex, state.currentStudy]);

  const setWindowLevel = useCallback((windowWidth: number, windowCenter: number) => {
    if (!renderingEngineRef.current) {
      return;
    }

    try {
      const viewport = renderingEngineRef.current.getViewport(viewportId);
      
      viewport.setProperties({
        voiRange: {
          lower: windowCenter - windowWidth / 2,
          upper: windowCenter + windowWidth / 2,
        },
      });
      
      viewport.render();
      
      setState(prev => ({
        ...prev,
        windowLevel: { windowWidth, windowCenter },
      }));
    } catch (error) {
      console.error('Failed to set window level:', error);
    }
  }, []);

  const resetView = useCallback(() => {
    if (!renderingEngineRef.current) {
      return;
    }

    try {
      const viewport = renderingEngineRef.current.getViewport(viewportId);
      
      let windowWidth = 4096;
      let windowCenter = 2048;
      
      if (state.currentInstance?.windowWidth && state.currentInstance?.windowCenter) {
        windowWidth = state.currentInstance.windowWidth;
        windowCenter = state.currentInstance.windowCenter;
      } else if (state.currentInstance?.bitsAllocated) {
        const maxVal = Math.pow(2, state.currentInstance.bitsAllocated) - 1;
        windowWidth = maxVal;
        windowCenter = maxVal / 2;
      }
      
      viewport.setProperties({
        voiRange: {
          lower: windowCenter - windowWidth / 2,
          upper: windowCenter + windowWidth / 2,
        },
      });
      
      viewport.resetCamera();
      viewport.render();
      
      setState(prev => ({
        ...prev,
        windowLevel: { windowWidth, windowCenter },
      }));
    } catch (error) {
      console.error('Failed to reset view:', error);
    }
  }, [state.currentInstance]);

  const invertColors = useCallback(() => {
    if (!renderingEngineRef.current) {
      return;
    }

    try {
      const viewport = renderingEngineRef.current.getViewport(viewportId);
      const { invert } = viewport.getProperties();
      viewport.setProperties({ invert: !invert });
      viewport.render();
    } catch (error) {
      console.error('Failed to invert colors:', error);
    }
  }, []);

  const setActiveAnnotationTool = useCallback((toolName: string) => {
    activeCtSinusesFeatureRef.current = null;
    console.info('[Viewer] setActiveAnnotationTool', {
      toolName,
      hasToolGroup: Boolean(toolGroupRef.current),
      isNasalSeptumDeviation: toolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME,
    });
    if (!toolGroupRef.current) return;

    const {
      WindowLevelTool,
      LengthTool,
      ArrowAnnotateTool,
      CircleROITool,
      AngleTool,
      BidirectionalTool,
      RectangleROITool,
    } = cornerstoneTools;

    const tools = [
      WindowLevelTool.toolName,
      LengthTool.toolName,
      ArrowAnnotateTool.toolName,
      CircleROITool.toolName,
      AngleTool.toolName,
      BidirectionalTool.toolName,
      RectangleROITool.toolName,
      CT_SINUSES_TOOL_NAME,
      NASAL_SEPTUM_DEVIATION_TOOL_NAME,
    ];

    tools.forEach(tool => {
      if (tool === toolName) {
        toolGroupRef.current.setToolActive(tool, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
      } else {
        toolGroupRef.current.setToolPassive(tool);
      }
    });
  }, []);

  const setActiveCtSinusesFeature = useCallback((feature: CtSinusesFeature | null) => {
    activeCtSinusesFeatureRef.current = feature;

    if (!toolGroupRef.current || !ctSinusesSegmentationIdRef.current) return;

    if (!feature) {
      toolGroupRef.current.setToolPassive(CT_SINUSES_TOOL_NAME);
      return;
    }

    activateCtSinusesFeature(
      viewportId,
      ctSinusesSegmentationIdRef.current,
      feature
    );

    [
      cornerstoneTools.WindowLevelTool.toolName,
      cornerstoneTools.LengthTool.toolName,
      cornerstoneTools.ArrowAnnotateTool.toolName,
      cornerstoneTools.CircleROITool.toolName,
      cornerstoneTools.AngleTool.toolName,
      cornerstoneTools.BidirectionalTool.toolName,
      cornerstoneTools.RectangleROITool.toolName,
      NASAL_SEPTUM_DEVIATION_TOOL_NAME,
    ].forEach(toolName => toolGroupRef.current.setToolPassive(toolName));

    toolGroupRef.current.setToolActive(CT_SINUSES_TOOL_NAME, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
  }, []);

  return {
    state,
    studies,
    viewportRef,
    viewportId,
    toolGroupId,
    loadStudies,
    loadStudy,
    loadStudyByUID,
    loadSeries,
    measurements,
    persistedAnnotations,
    removeMeasurement,
    saveMeasurement,
    retryMeasurement,
    persistMprAnnotation,
    hasPendingAnnotationChanges,
    setImageIndex,
    selectMeasurement,
    setWindowLevel,
    resetView,
    invertColors,
    navigateToStudies,
    initViewport,
    destroyViewport,
    restoreStackViewport,
    preloadProgress,
    preloadQueue,
    toggleStudyPreload,
    enqueueStudiesPreload,
    cancelStudyPreload,
    clearPreloadQueue,
    setActiveAnnotationTool,
    setActiveCtSinusesFeature,
  };
}
