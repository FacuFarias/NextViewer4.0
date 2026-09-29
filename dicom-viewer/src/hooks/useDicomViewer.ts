import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClinicalViewportState, DicomInstance, DicomSeries, ViewerLayoutMode, ViewerState } from '../types/dicom';
import type { HangingAssignment, HangingLayout } from '../types/hangingProtocol';
import type { ClinicalMouseTool, ConfigurableMouseButton, MouseToolBindings } from '../types/tools';
import {
  CLINICAL_MOUSE_TOOLS, DEFAULT_MOUSE_TOOL_BINDINGS, DEFAULT_SHIFT_MOUSE_TOOL_BINDINGS,
} from '../types/tools';
import { getDicomRequestHeaders, isShareAccess } from '../services/auth';
import {
  applyMouseToolBindings, clearClinicalMeasurements, configureDicomLoader, cornerstoneTools, createRenderingEngine,
  createToolGroup, Enums, eventTarget, initializeCornerstone, isImageCached, loadImageToCache,
  purgeMemoryCache, registerTools, setupToolGroup, undoClinicalAction,
} from '../services/cornerstone';
import { expandMultiframeInstances, getDicomFrameImageId } from '../services/dicomFrames';
import { dicomWebService, mergeDefinedDicomMetadata } from '../services/dicomWeb';
import { getUsLosslessImageId } from '../services/usLosslessImageLoader';
import { buildPresentationStateDataset, isPresentationStateForInstance, serializePresentationState } from '../services/presentationState';
import type { PresentationState } from '../types/presentationState';
import { isPresentationStateShareEnabled } from '../services/runtimeConfig';
import { isClinicalImageModality, isSupportedVisualInstance, resolveViewerModality } from '../services/viewerModality';

const PRELOAD_RANGE = 6;
const STACK_NEW_IMAGE = 'CORNERSTONE_STACK_NEW_IMAGE';
const RENDERING_ENGINE_ID = 'clinicalRenderingEngine';
const TOOL_GROUP_ID = 'clinicalToolGroup';
const MOUSE_BINDINGS_STORAGE_KEY = 'nextviewer.mouseToolBindings';
const SHIFT_MOUSE_BINDINGS_STORAGE_KEY = 'nextviewer.shiftMouseToolBindings';
const defaultWindowLevel = { windowWidth: 4096, windowCenter: 2048 };
const MEASUREMENT_TOOL_NAMES = new Set([
  'Length', 'ArrowAnnotate', 'CircleROI', 'EllipticalROI', 'Angle', 'Probe',
  'Bidirectional', 'RectangleROI', 'PlanarFreehandROI',
]);

const MEASUREMENT_TOOL_LABELS: Record<string, string> = {
  Length: 'Distancia', ArrowAnnotate: 'Flecha', CircleROI: 'ROI circular',
  EllipticalROI: 'ROI elíptica', Angle: 'Ángulo', Probe: 'Sonda',
  Bidirectional: 'Bidireccional', RectangleROI: 'Rectángulo',
  PlanarFreehandROI: 'ROI a mano alzada',
};

const MEASUREMENT_TOOL_COLORS: Record<string, string> = {
  Length: '#42a5f5', ArrowAnnotate: '#ef5350', CircleROI: '#66bb6a',
  EllipticalROI: '#8bc34a', Angle: '#ffa726', Probe: '#29b6f6',
  Bidirectional: '#ab47bc', RectangleROI: '#26a69a',
  PlanarFreehandROI: '#90a4ae',
};

export interface ViewerMeasurement {
  annotationUID: string;
  toolName: string;
  label: string;
  value: string;
  color: string;
  viewportId?: string;
  imageIndex: number;
  selected: boolean;
}

function getAnnotationToolName(annotation: any): string {
  return annotation?.toolName || annotation?.metadata?.toolName || annotation?.data?.toolName || '';
}

function formatMeasurementValue(annotation: any): string {
  const stats = Object.values(annotation?.data?.cachedStats || {})[0] as Record<string, unknown> | undefined;
  if (!stats) return 'Sin valor';
  if (typeof stats.length === 'number') return `${stats.length.toFixed(1)} mm`;
  if (typeof stats.area === 'number') return `${stats.area.toFixed(1)} mm²`;
  if (typeof stats.angle === 'number') return `${stats.angle.toFixed(1)}°`;
  if (typeof stats.width === 'number' && typeof stats.height === 'number') {
    return `${stats.width.toFixed(1)} × ${stats.height.toFixed(1)} mm`;
  }
  if (typeof stats.mean === 'number') return `Media: ${stats.mean.toFixed(1)}`;
  return 'Sin valor';
}

function loadMouseToolBindings(
  storageKey = MOUSE_BINDINGS_STORAGE_KEY,
  defaults = DEFAULT_MOUSE_TOOL_BINDINGS,
): MouseToolBindings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}') as Partial<MouseToolBindings>;
    const availableTools = new Set<string>(CLINICAL_MOUSE_TOOLS);
    const isPreviousDefault = storageKey === MOUSE_BINDINGS_STORAGE_KEY && (
      (stored.primary === 'WindowLevel' && stored.auxiliary === 'Zoom' && stored.secondary === 'Pan') ||
      (stored.primary === 'WindowLevel' && stored.auxiliary === 'Pan' && stored.secondary === 'WindowLevel')
    );
    if (isPreviousDefault) return defaults;
    return {
      primary: availableTools.has(stored.primary || '') ? stored.primary! : defaults.primary,
      auxiliary: availableTools.has(stored.auxiliary || '') ? stored.auxiliary! : defaults.auxiliary,
      secondary: availableTools.has(stored.secondary || '') ? stored.secondary! : defaults.secondary,
    };
  } catch {
    return defaults;
  }
}

const initialState: ViewerState = {
  viewMode: 'viewer', layoutMode: '1x1', isLoaded: false, isLoading: false, error: null,
  currentStudy: null, currentSeries: null, currentInstance: null,
  windowLevel: defaultWindowLevel, imageIndex: 0,
  activeViewportId: 'clinicalViewport-0', viewports: [],
};

function chooseWindowLevel(instance: DicomInstance) {
  if (Number.isFinite(instance.windowWidth) && Number.isFinite(instance.windowCenter)) {
    return { windowWidth: Number(instance.windowWidth), windowCenter: Number(instance.windowCenter) };
  }
  const maxValue = Math.pow(2, instance.bitsStored || instance.bitsAllocated || 12) - 1;
  return { windowWidth: maxValue, windowCenter: maxValue / 2 };
}

function shouldUseSpecialUsLoader(instance: DicomInstance): boolean {
  const photometric = instance.photometricInterpretation?.toUpperCase();
  return (instance.numberOfFrames || 1) === 1 &&
    Boolean(instance.pixelSpacing?.length === 2 && instance.pixelSpacing.every(value => value > 0)) &&
    instance.samplesPerPixel === 3 && (photometric === 'RGB' || photometric === 'YBR_FULL');
}

interface LoadedSeries { series: DicomSeries; instances: DicomInstance[]; imageIds: string[] }

export function useDicomViewer(studyInstanceUID: string) {
  const [state, setState] = useState<ViewerState>(initialState);
  const [mouseToolBindings, setMouseToolBindings] = useState<MouseToolBindings>(loadMouseToolBindings);
  const [shiftMouseToolBindings, setShiftMouseToolBindings] = useState<MouseToolBindings>(
    () => loadMouseToolBindings(SHIFT_MOUSE_BINDINGS_STORAGE_KEY, DEFAULT_SHIFT_MOUSE_TOOL_BINDINGS)
  );
  const [measurements, setMeasurements] = useState<ViewerMeasurement[]>([]);
  const [presentationStates, setPresentationStates] = useState<PresentationState[]>([]);
  const [activePresentationStateUID, setActivePresentationStateUID] = useState<string | null>(null);
  const [referenceLinesEnabled, setReferenceLinesEnabledState] = useState(false);
  const [cornerstoneReady, setCornerstoneReady] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const renderingEngineRef = useRef<any>(null);
  const toolGroupRef = useRef<any>(null);
  const viewportElementsRef = useRef(new Map<string, HTMLDivElement>());
  const stacksRef = useRef(new Map<string, { imageIds: string[]; instances: DicomInstance[] }>());
  const preloadTimersRef = useRef(new Map<string, number>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const layoutRequestRef = useRef(0);
  const mouseToolBindingsRef = useRef(mouseToolBindings);
  const shiftMouseToolBindingsRef = useRef(shiftMouseToolBindings);
  const referenceLinesEnabledRef = useRef(false);
  const referenceLinesSourceViewportRef = useRef<string | null>(null);
  const presentationAnnotationUIDsRef = useRef(new Set<string>());

  const clearPresentationAnnotations = useCallback(() => {
    presentationAnnotationUIDsRef.current.forEach(annotationUID => {
      cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
    });
    presentationAnnotationUIDsRef.current.clear();
  }, []);

  const applyPresentationState = useCallback((presentationState: PresentationState | null, viewportId = state.activeViewportId) => {
    const viewport = renderingEngineRef.current?.getViewport(viewportId);
    const element = viewportElementsRef.current.get(viewportId);
    if (!viewport || !element) return;
    clearPresentationAnnotations();
    const stack = stacksRef.current.get(viewportId);
    const currentImageId = viewport.getCurrentImageId?.();
    const instance = stack?.instances.find((candidate, index) =>
      (currentImageId ? stack.imageIds[index] === currentImageId : false) &&
      (!presentationState || isPresentationStateForInstance(presentationState, candidate))
    );
    if (!presentationState || !instance) {
      setActivePresentationStateUID(null);
      const originalWindow = instance ? chooseWindowLevel(instance) : undefined;
      viewport.setProperties({ invert: false, ...(originalWindow ? { voiRange: {
        lower: originalWindow.windowCenter - originalWindow.windowWidth / 2,
        upper: originalWindow.windowCenter + originalWindow.windowWidth / 2,
      }} : {}) });
      if (originalWindow) setState(previous => ({ ...previous, windowLevel: originalWindow,
        viewports: previous.viewports.map(item => item.id === viewportId ? { ...item, windowLevel: originalWindow } : item),
      }));
      viewport.render();
      return;
    }
    if (Number.isFinite(presentationState.windowWidth) && Number.isFinite(presentationState.windowCenter)) {
      viewport.setProperties({ voiRange: {
        lower: presentationState.windowCenter - presentationState.windowWidth / 2,
        upper: presentationState.windowCenter + presentationState.windowWidth / 2,
      }});
    }
    viewport.setProperties({ invert: presentationState.presentationLUTShape === 'INVERSE' });
    const imageData = viewport.getImageData?.()?.imageData;
    for (const [index, graphic] of presentationState.graphics.entries()) {
      const worldPoints = [];
      for (let pointIndex = 0; pointIndex < graphic.points.length; pointIndex += 2) {
        const x = graphic.points[pointIndex] - 1;
        const y = graphic.points[pointIndex + 1] - 1;
        try { worldPoints.push(imageData?.indexToWorld?.([x, y, 0]) || viewport.canvasToWorld([x, y])); } catch { /* ignore malformed graphic */ }
      }
      if (worldPoints.length < 1) continue;
      const annotationUID = `presentation-${presentationState.sopInstanceUID}-${index}`;
      try {
        cornerstoneTools.annotation.state.addAnnotation({
          annotationUID, highlighted: false, autoGenerated: false, invalidated: false,
          isLocked: true, isVisible: true,
          metadata: { toolName: 'PlanarFreehandROI', referencedImageId: viewport.getCurrentImageId?.(),
            FrameOfReferenceUID: instance.frameOfReferenceUID, viewPlaneNormal: viewport.getCamera?.().viewPlaneNormal },
          data: { handles: { points: worldPoints }, closed: graphic.type !== 'POINT', cachedStats: {} },
        }, element);
        presentationAnnotationUIDsRef.current.add(annotationUID);
      } catch {
        // Unsupported graphics remain represented in the DICOM PR and do not break image display.
      }
    }
    setActivePresentationStateUID(presentationState.sopInstanceUID);
    setState(previous => ({ ...previous, windowLevel: {
      windowWidth: Number.isFinite(presentationState.windowWidth) ? presentationState.windowWidth! : previous.windowLevel.windowWidth,
      windowCenter: Number.isFinite(presentationState.windowCenter) ? presentationState.windowCenter! : previous.windowLevel.windowCenter,
    }, viewports: previous.viewports.map(item => item.id === viewportId ? { ...item, windowLevel: {
      windowWidth: Number.isFinite(presentationState.windowWidth) ? presentationState.windowWidth! : item.windowLevel.windowWidth,
      windowCenter: Number.isFinite(presentationState.windowCenter) ? presentationState.windowCenter! : item.windowLevel.windowCenter,
    }} : item) }));
    viewport.render();
  }, [clearPresentationAnnotations, state.activeViewportId]);

  const savePresentationState = useCallback(async (): Promise<PresentationState> => {
    const active = state.viewports.find(item => item.id === state.activeViewportId);
    if (!state.currentStudy || !active?.instance) throw new Error('No hay una imagen activa para guardar.');
    if (!active.instance.sopClassUID || !['MONOCHROME1', 'MONOCHROME2'].includes(active.instance.photometricInterpretation?.toUpperCase())) {
      throw new Error('El PR GSPS solo está disponible para imágenes monocromas.');
    }
    const viewport = renderingEngineRef.current?.getViewport(active.id);
    if (!viewport) throw new Error('El viewport activo no está disponible.');
    const annotations = cornerstoneTools.annotation.state.getAllAnnotations().filter((annotation: any) => {
      const referenced = annotation.metadata?.referencedImageId || annotation.data?.referencedImageId;
      return !referenced || referenced === viewport.getCurrentImageId?.();
    });
    const { dataset, state: created } = buildPresentationStateDataset(
      state.currentStudy, active.instance, state.windowLevel,
      Boolean(viewport.getProperties?.().invert), annotations, viewport, active.series?.seriesInstanceUID
    );
    await dicomWebService.storePresentationState(state.currentStudy.studyInstanceUID, serializePresentationState(dataset));
    setPresentationStates(previous => [created, ...previous]);
    setActivePresentationStateUID(created.sopInstanceUID);
    return created;
  }, [state.activeViewportId, state.currentStudy, state.viewports, state.windowLevel]);

  const refreshMeasurements = useCallback(() => {
    const stacks = Array.from(stacksRef.current.entries());
    const nextMeasurements = cornerstoneTools.annotation.state
      .getAllAnnotations()
      .map((annotation: any): ViewerMeasurement | null => {
        const toolName = getAnnotationToolName(annotation);
        if (!annotation?.annotationUID || !MEASUREMENT_TOOL_NAMES.has(toolName)) return null;

        const referencedImageId = annotation.metadata?.referencedImageId || annotation.data?.referencedImageId;
        const stackEntry = stacks.find(([, stack]) =>
          typeof referencedImageId === 'string' && stack.imageIds.includes(referencedImageId)
        );
        const viewportId = annotation.metadata?.viewportId || stackEntry?.[0];
        const imageIndex = stackEntry && typeof referencedImageId === 'string'
          ? stackEntry[1].imageIds.indexOf(referencedImageId)
          : -1;

        return {
          annotationUID: annotation.annotationUID,
          toolName,
          label: MEASUREMENT_TOOL_LABELS[toolName] || toolName || 'Medición',
          value: formatMeasurementValue(annotation),
          color: annotation.data?.color || annotation.metadata?.color || MEASUREMENT_TOOL_COLORS[toolName] || '#90a4ae',
          viewportId,
          imageIndex,
          selected: cornerstoneTools.annotation.selection.isAnnotationSelected(annotation.annotationUID),
        };
      })
      .filter((measurement): measurement is ViewerMeasurement => measurement !== null);

    setMeasurements(nextMeasurements);
  }, []);

  const refreshReferenceLines = useCallback((sourceViewportId?: string) => {
    const toolGroup = toolGroupRef.current;
    const sourceId = sourceViewportId || referenceLinesSourceViewportRef.current;
    if (!toolGroup || !sourceId || !referenceLinesEnabledRef.current) return;
    toolGroup.setToolConfiguration(cornerstoneTools.ReferenceLinesTool.toolName, {
      sourceViewportId: sourceId,
      enforceSameFrameOfReference: true,
      showFullDimension: true,
    });
  }, []);

  const clearViewerAnnotations = useCallback(() => {
    const referenceLinesTool = toolGroupRef.current?.getToolInstance?.(cornerstoneTools.ReferenceLinesTool.toolName);
    const annotationUID = referenceLinesTool?.editData?.annotation?.annotationUID;
    if (annotationUID) cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
    if (referenceLinesTool) referenceLinesTool.editData = null;
    clearClinicalMeasurements();
    clearPresentationAnnotations();
    setMeasurements([]);
  }, [clearPresentationAnnotations]);

  const scheduleRenderingEngineResize = useCallback(() => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      renderingEngineRef.current?.resize();
    });
  }, []);

  const registerViewportElement = useCallback((viewportId: string, element: HTMLDivElement | null) => {
    if (element) viewportElementsRef.current.set(viewportId, element);
    else viewportElementsRef.current.delete(viewportId);
  }, []);

  const preloadAdjacentImages = useCallback((viewportId: string, currentIndex: number) => {
    const previous = preloadTimersRef.current.get(viewportId);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      const imageIds = stacksRef.current.get(viewportId)?.imageIds || [];
      const start = Math.max(0, currentIndex - PRELOAD_RANGE);
      const end = Math.min(imageIds.length - 1, currentIndex + PRELOAD_RANGE);
      for (let index = start; index <= end; index += 1) {
        if (!isImageCached(imageIds[index])) void loadImageToCache(imageIds[index]).catch(() => undefined);
      }
    }, 80);
    preloadTimersRef.current.set(viewportId, timer);
  }, []);

  const handleStackNewImage = useCallback((event: Event) => {
    const detail = (event as CustomEvent).detail;
    const viewportId = String(detail?.viewportId || '');
    if (!stacksRef.current.has(viewportId)) return;
    const imageIndex = Number(detail.imageIdIndex) || 0;
    const instance = stacksRef.current.get(viewportId)?.instances[imageIndex] || null;
    setState(previous => {
      const viewports = previous.viewports.map(viewport => viewport.id === viewportId ? { ...viewport, imageIndex, instance } : viewport);
      return previous.activeViewportId === viewportId
        ? { ...previous, viewports, imageIndex, currentInstance: instance }
        : { ...previous, viewports };
    });
    preloadAdjacentImages(viewportId, imageIndex);
    if (referenceLinesEnabledRef.current && referenceLinesSourceViewportRef.current === viewportId) {
      refreshReferenceLines(viewportId);
    }
  }, [preloadAdjacentImages, refreshReferenceLines]);

  useEffect(() => {
    let disposed = false;
    const preloadTimers = preloadTimersRef.current;
    const viewportElements = viewportElementsRef.current;
    void (async () => {
      try {
        await initializeCornerstone();
        registerTools();
        configureDicomLoader(await getDicomRequestHeaders('application/dicom'));
        if (!disposed) setCornerstoneReady(true);
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'No se pudo inicializar Cornerstone.' }));
      }
    })();
    return () => {
      disposed = true;
      for (const timer of preloadTimers.values()) window.clearTimeout(timer);
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      resizeObserverRef.current?.disconnect();
      for (const element of viewportElements.values()) element.removeEventListener(STACK_NEW_IMAGE, handleStackNewImage);
      clearViewerAnnotations();
      clearPresentationAnnotations();
      cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      renderingEngineRef.current?.destroy();
      purgeMemoryCache();
    };
  }, [clearPresentationAnnotations, clearViewerAnnotations, handleStackNewImage]);

  useEffect(() => {
    if (!cornerstoneReady) return;
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', scheduleRenderingEngineResize);
    window.addEventListener('orientationchange', scheduleRenderingEngineResize);
    visualViewport?.addEventListener('resize', scheduleRenderingEngineResize);
    return () => {
      window.removeEventListener('resize', scheduleRenderingEngineResize);
      window.removeEventListener('orientationchange', scheduleRenderingEngineResize);
      visualViewport?.removeEventListener('resize', scheduleRenderingEngineResize);
    };
  }, [cornerstoneReady, scheduleRenderingEngineResize]);

  useEffect(() => {
    if (!cornerstoneReady) return undefined;
    const refresh = () => refreshMeasurements();
    const events = [
      cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,
      cornerstoneTools.Enums.Events.ANNOTATION_MODIFIED,
      cornerstoneTools.Enums.Events.ANNOTATION_REMOVED,
      cornerstoneTools.Enums.Events.ANNOTATION_SELECTION_CHANGE,
    ];
    events.forEach(eventName => eventTarget.addEventListener(eventName, refresh));
    refresh();
    return () => events.forEach(eventName => eventTarget.removeEventListener(eventName, refresh));
  }, [cornerstoneReady, refreshMeasurements]);

  const fetchSeries = useCallback(async (studyUID: string, series: DicomSeries): Promise<LoadedSeries> => {
    const qidoInstances = await dicomWebService.getSeriesInstances(studyUID, series.seriesInstanceUID);
    let metadata: Partial<DicomInstance>[] = [];
    try { metadata = await dicomWebService.getSeriesMetadata(studyUID, series.seriesInstanceUID); } catch { metadata = []; }
    const metadataBySop = new Map(metadata.filter(entry => entry.sopInstanceUID).map(entry => [entry.sopInstanceUID!, entry]));
    const instances = qidoInstances.filter(isSupportedVisualInstance)
      .map(instance => mergeDefinedDicomMetadata(instance, metadataBySop.get(instance.sopInstanceUID)))
      .filter(isSupportedVisualInstance)
      .sort((left, right) => (left.instanceNumber || 0) - (right.instanceNumber || 0));
    if (!instances.length) throw new Error('La serie no contiene imágenes compatibles.');
    const displayInstances = expandMultiframeInstances(instances);
    const modality = resolveViewerModality(series.modality, instances[0]?.modality);
    const imageIds = displayInstances.map(instance => {
      const wadoUri = dicomWebService.getInstanceWadoUriUrl(studyUID, series.seriesInstanceUID, instance.sopInstanceUID);
      if (modality === 'us' && shouldUseSpecialUsLoader(instance)) return getUsLosslessImageId(wadoUri);
      if ((instance.numberOfFrames || 1) > 1) return getDicomFrameImageId(wadoUri, instance);
      return `wadouri:${wadoUri}`;
    });
    return { series: { ...series, instances: displayInstances }, instances: displayInstances, imageIds };
  }, []);

  const loadIntoViewport = useCallback(async (
    viewportId: string,
    studyUID: string,
    series: DicomSeries,
    requestId?: number
  ) => {
    const engine = renderingEngineRef.current;
    if (!engine) throw new Error('El motor de visualización no está disponible.');
    const loaded = await fetchSeries(studyUID, series);
    if (requestId !== undefined && requestId !== layoutRequestRef.current) return;
    stacksRef.current.set(viewportId, { imageIds: loaded.imageIds, instances: loaded.instances });
    const viewport = engine.getViewport(viewportId);
    const windowLevel = chooseWindowLevel(loaded.instances[0]);
    await viewport.setStack(loaded.imageIds, 0);
    viewport.setProperties({ voiRange: {
      lower: windowLevel.windowCenter - windowLevel.windowWidth / 2,
      upper: windowLevel.windowCenter + windowLevel.windowWidth / 2,
    }});
    viewport.render();
    setState(previous => {
      const viewports = previous.viewports.map(item => item.id === viewportId ? {
        ...item, series: loaded.series, instance: loaded.instances[0], imageIndex: 0,
        windowLevel, isLoaded: true, error: undefined,
      } : item);
      const active = previous.activeViewportId === viewportId;
      return { ...previous, viewports, ...(active ? {
        currentSeries: loaded.series, currentInstance: loaded.instances[0], imageIndex: 0, windowLevel,
      } : {}) };
    });
    preloadAdjacentImages(viewportId, 0);
  }, [fetchSeries, preloadAdjacentImages]);

  useEffect(() => {
    if (!cornerstoneReady || !layoutVersion || !state.currentStudy) return;
    const requestId = layoutRequestRef.current;
    let disposed = false;
    const initializeLayout = async () => {
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      if (disposed || requestId !== layoutRequestRef.current) return;
      resizeObserverRef.current?.disconnect();
      for (const element of viewportElementsRef.current.values()) {
        element.removeEventListener(STACK_NEW_IMAGE, handleStackNewImage);
      }
      cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      renderingEngineRef.current?.destroy();
      stacksRef.current.clear();
      const engine = createRenderingEngine(RENDERING_ENGINE_ID);
      renderingEngineRef.current = engine;
      const viewportIds = state.viewports.map(viewport => viewport.id);
      for (const viewportId of viewportIds) {
        const element = viewportElementsRef.current.get(viewportId);
        if (!element) throw new Error('No se pudo preparar uno de los viewports.');
        engine.enableElement({ viewportId, element, type: Enums.ViewportType.STACK });
        element.addEventListener(STACK_NEW_IMAGE, handleStackNewImage);
      }
      const toolGroup = createToolGroup(TOOL_GROUP_ID);
      if (!toolGroup) throw new Error('No se pudo crear el grupo de herramientas clínicas.');
      toolGroupRef.current = toolGroup;
      setupToolGroup(
        toolGroup,
        viewportIds,
        RENDERING_ENGINE_ID,
        mouseToolBindingsRef.current,
        shiftMouseToolBindingsRef.current,
      );
      if (referenceLinesEnabledRef.current) {
        const sourceViewportId = referenceLinesSourceViewportRef.current || viewportIds[0];
        if (sourceViewportId) {
          toolGroup.setToolConfiguration(cornerstoneTools.ReferenceLinesTool.toolName, {
            sourceViewportId,
            enforceSameFrameOfReference: true,
            showFullDimension: true,
          });
          toolGroup.setToolEnabled(cornerstoneTools.ReferenceLinesTool.toolName);
        }
      }
      resizeObserverRef.current = new ResizeObserver(scheduleRenderingEngineResize);
      viewportIds.forEach(id => resizeObserverRef.current?.observe(viewportElementsRef.current.get(id)!));
      configureDicomLoader(await getDicomRequestHeaders('application/dicom'));
      const results = await Promise.allSettled(state.viewports.map(viewport =>
        viewport.series ? loadIntoViewport(
          viewport.id,
          viewport.series.studyInstanceUID || state.currentStudy!.studyInstanceUID,
          viewport.series,
          requestId
        ) : Promise.resolve()));
      if (disposed || requestId !== layoutRequestRef.current) return;
      const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
      setState(previous => ({ ...previous, isLoading: false,
        isLoaded: state.viewports.some((viewport, index) => Boolean(viewport.series) && results[index].status === 'fulfilled'),
        error: failure ? (failure.reason instanceof Error ? failure.reason.message : 'No se pudo cargar una serie del protocolo.') : null,
      }));
      if (referenceLinesEnabledRef.current) refreshReferenceLines(referenceLinesSourceViewportRef.current || state.viewports[0]?.id);
    };
    void initializeLayout().catch(error => {
      if (!disposed) setState(previous => ({ ...previous, isLoading: false, error: error instanceof Error ? error.message : 'No se pudo aplicar el protocolo.' }));
    });
    return () => { disposed = true; };
    // layoutVersion owns viewport recreation; navigation state must not recreate the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cornerstoneReady, layoutVersion, scheduleRenderingEngineResize]);

  const applyProtocolLayout = useCallback((layout: HangingLayout, assignments: HangingAssignment[]) => {
    clearViewerAnnotations();
    for (const timer of preloadTimersRef.current.values()) window.clearTimeout(timer);
    preloadTimersRef.current.clear();
    purgeMemoryCache();
    layoutRequestRef.current += 1;
    const viewports: ClinicalViewportState[] = assignments.map(assignment => ({
      id: `clinicalViewport-${assignment.slot}`, slot: assignment.slot, label: assignment.label,
      series: assignment.series || null, instance: null, imageIndex: 0,
      windowLevel: defaultWindowLevel, isLoaded: false,
    }));
    const first = viewports.find(viewport => viewport.series) || viewports[0];
    setState(previous => ({ ...previous, layoutMode: layout as ViewerLayoutMode, viewports,
      activeViewportId: first?.id || 'clinicalViewport-0', currentSeries: first?.series || null,
      currentInstance: null, imageIndex: 0, windowLevel: defaultWindowLevel,
      isLoading: true, isLoaded: false, error: null,
    }));
    setLayoutVersion(previous => previous + 1);
  }, [clearViewerAnnotations]);

  const loadSeries = useCallback(async (studyUID: string, series: DicomSeries, viewportId = state.activeViewportId) => {
    clearViewerAnnotations();
    setState(previous => ({ ...previous, isLoading: true, error: null }));
    try {
      await loadIntoViewport(viewportId, studyUID, series);
      setState(previous => ({ ...previous, isLoading: false, isLoaded: true }));
    } catch (error) {
      setState(previous => ({ ...previous, isLoading: false, error: error instanceof Error ? error.message : 'No se pudo cargar la serie.' }));
    }
  }, [clearViewerAnnotations, loadIntoViewport, state.activeViewportId]);

  useEffect(() => {
    let cancelled = false;
    setState(previous => ({ ...previous, isLoading: true, isLoaded: false, error: null }));
    clearViewerAnnotations(); clearPresentationAnnotations(); setPresentationStates([]); setActivePresentationStateUID(null); purgeMemoryCache();
    void Promise.all([dicomWebService.getStudyByUID(studyInstanceUID), dicomWebService.getStudySeries(studyInstanceUID)])
      .then(([study, allSeries]) => {
        if (cancelled) return;
        if (!study) throw new Error('El estudio solicitado no está disponible o no está autorizado.');
        const series = allSeries.filter(entry => isClinicalImageModality(entry.modality));
        if (!series.length) throw new Error('El estudio no contiene series de imágenes.');
        setState(previous => ({ ...previous, currentStudy: { ...study, series }, isLoading: false }));
        if (!isShareAccess() || isPresentationStateShareEnabled()) {
          void dicomWebService.getPresentationStates(studyInstanceUID).then(setPresentationStates).catch(() => setPresentationStates([]));
        }
      })
      .catch(error => {
        if (!cancelled) setState(previous => ({ ...previous, isLoading: false, error: error instanceof Error ? error.message : 'No se pudo cargar el estudio.' }));
      });
    return () => { cancelled = true; };
  }, [clearPresentationAnnotations, clearViewerAnnotations, studyInstanceUID]);

  const selectViewport = useCallback((viewportId: string) => {
    setState(previous => {
      const selected = previous.viewports.find(viewport => viewport.id === viewportId);
      return selected ? { ...previous, activeViewportId: viewportId, currentSeries: selected.series,
        currentInstance: selected.instance, imageIndex: selected.imageIndex, windowLevel: selected.windowLevel } : previous;
    });
    referenceLinesSourceViewportRef.current = viewportId;
    refreshReferenceLines(viewportId);
  }, [refreshReferenceLines]);

  const activeViewport = useMemo(() => state.viewports.find(viewport => viewport.id === state.activeViewportId), [state.activeViewportId, state.viewports]);

  useEffect(() => {
    if (!activeViewport?.instance) return;
    const selected = presentationStates.find(item => isPresentationStateForInstance(item, activeViewport.instance!));
    applyPresentationState(selected || null, activeViewport.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewport?.id, activeViewport?.instance?.sopInstanceUID, activeViewport?.instance?.frameNumber, presentationStates]);

  const setWindowLevel = useCallback((windowWidth: number, windowCenter: number) => {
    const viewport = renderingEngineRef.current?.getViewport(state.activeViewportId);
    if (!viewport) return;
    viewport.setProperties({ voiRange: { lower: windowCenter - windowWidth / 2, upper: windowCenter + windowWidth / 2 } });
    viewport.render();
    setState(previous => ({ ...previous, windowLevel: { windowWidth, windowCenter },
      viewports: previous.viewports.map(item => item.id === previous.activeViewportId ? { ...item, windowLevel: { windowWidth, windowCenter } } : item),
    }));
  }, [state.activeViewportId]);

  const resetView = useCallback(() => {
    const viewport = renderingEngineRef.current?.getViewport(state.activeViewportId);
    if (!viewport || !activeViewport?.instance) return;
    const windowLevel = chooseWindowLevel(activeViewport.instance);
    viewport.setProperties({ invert: false, voiRange: { lower: windowLevel.windowCenter - windowLevel.windowWidth / 2, upper: windowLevel.windowCenter + windowLevel.windowWidth / 2 } });
    viewport.resetCamera(); viewport.render();
    setState(previous => ({ ...previous, windowLevel,
      viewports: previous.viewports.map(item => item.id === previous.activeViewportId ? { ...item, windowLevel } : item),
    }));
  }, [activeViewport?.instance, state.activeViewportId]);

  const invertColors = useCallback(() => {
    const viewport = renderingEngineRef.current?.getViewport(state.activeViewportId);
    if (!viewport) return;
    viewport.setProperties({ invert: !viewport.getProperties().invert }); viewport.render();
  }, [state.activeViewportId]);

  const undoLastAnnotation = useCallback(() => undoClinicalAction(), []);

  const setReferenceLinesEnabled = useCallback((enabled: boolean, sourceViewportId = state.activeViewportId) => {
    referenceLinesEnabledRef.current = enabled;
    referenceLinesSourceViewportRef.current = sourceViewportId;
    setReferenceLinesEnabledState(enabled);

    const toolGroup = toolGroupRef.current;
    if (!toolGroup) return;
    if (!enabled) {
      toolGroup.setToolDisabled(cornerstoneTools.ReferenceLinesTool.toolName);
      return;
    }

    toolGroup.setToolConfiguration(cornerstoneTools.ReferenceLinesTool.toolName, {
      sourceViewportId,
      enforceSameFrameOfReference: true,
      showFullDimension: true,
    });
    toolGroup.setToolEnabled(cornerstoneTools.ReferenceLinesTool.toolName);
  }, [state.activeViewportId]);

  const setMouseToolBinding = useCallback((button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => {
    const nextBindings = { ...mouseToolBindingsRef.current, [button]: toolName };
    mouseToolBindingsRef.current = nextBindings;
    setMouseToolBindings(nextBindings);
    try {
      window.localStorage.setItem(MOUSE_BINDINGS_STORAGE_KEY, JSON.stringify(nextBindings));
    } catch {
      // The current browser may disallow persistent storage; bindings still work for this viewer session.
    }
    if (toolGroupRef.current) {
      applyMouseToolBindings(toolGroupRef.current, nextBindings, shiftMouseToolBindingsRef.current);
    }
  }, []);

  const setShiftMouseToolBinding = useCallback((button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => {
    const nextBindings = { ...shiftMouseToolBindingsRef.current, [button]: toolName };
    shiftMouseToolBindingsRef.current = nextBindings;
    setShiftMouseToolBindings(nextBindings);
    try {
      window.localStorage.setItem(SHIFT_MOUSE_BINDINGS_STORAGE_KEY, JSON.stringify(nextBindings));
    } catch {
      // The current browser may disallow persistent storage; bindings still work for this viewer session.
    }
    if (toolGroupRef.current) {
      applyMouseToolBindings(toolGroupRef.current, mouseToolBindingsRef.current, nextBindings);
    }
  }, []);

  const setImageIndex = useCallback((requestedIndex: number, viewportId = state.activeViewportId) => {
    const stack = stacksRef.current.get(viewportId);
    const viewport = renderingEngineRef.current?.getViewport(viewportId);
    if (!stack || !viewport || !stack.instances.length) return;
    const imageIndex = Math.max(0, Math.min(stack.instances.length - 1, Math.round(requestedIndex)));
    const instance = stack.instances[imageIndex] || null;
    setState(previous => {
      const viewports = previous.viewports.map(item => item.id === viewportId
        ? { ...item, imageIndex, instance }
        : item);
      return previous.activeViewportId === viewportId
        ? { ...previous, viewports, imageIndex, currentInstance: instance }
        : { ...previous, viewports };
    });
    preloadAdjacentImages(viewportId, imageIndex);
    void viewport.setImageIdIndex(imageIndex).catch(error => {
      setState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'No se pudo cambiar de instancia.',
      }));
    });
  }, [preloadAdjacentImages, state.activeViewportId]);

  const selectMeasurement = useCallback((measurement: ViewerMeasurement) => {
    if (measurement.viewportId) selectViewport(measurement.viewportId);
    if (measurement.imageIndex >= 0 && measurement.viewportId) {
      setImageIndex(measurement.imageIndex, measurement.viewportId);
    }

    cornerstoneTools.annotation.selection.setAnnotationSelected(measurement.annotationUID);
    const viewport = measurement.viewportId
      ? renderingEngineRef.current?.getViewport(measurement.viewportId)
      : renderingEngineRef.current?.getViewport(state.activeViewportId);
    viewport?.render?.();
    refreshMeasurements();
  }, [refreshMeasurements, selectViewport, setImageIndex, state.activeViewportId]);

  const removeMeasurement = useCallback((annotationUID: string): boolean => {
    const annotation = cornerstoneTools.annotation.state.getAnnotation(annotationUID);
    if (!annotation) return false;
    cornerstoneTools.annotation.state.removeAnnotation(annotationUID);
    renderingEngineRef.current?.getViewports?.().forEach((viewport: any) => viewport.render?.());
    refreshMeasurements();
    return true;
  }, [refreshMeasurements]);

  const removeSelectedMeasurements = useCallback((): boolean => {
    const selectedUIDs = new Set(
      cornerstoneTools.annotation.selection.getAnnotationsSelected()
        .filter(annotationUID => measurements.some(measurement => measurement.annotationUID === annotationUID))
    );
    // Include the React state as a fallback: selection events are dispatched
    // synchronously by Cornerstone, but React may not have rendered the new
    // selection yet when the keyboard event arrives.
    measurements
      .filter(measurement => measurement.selected)
      .forEach(measurement => selectedUIDs.add(measurement.annotationUID));
    if (!selectedUIDs.size) return false;
    selectedUIDs.forEach(annotationUID => cornerstoneTools.annotation.state.removeAnnotation(annotationUID));
    renderingEngineRef.current?.getViewports?.().forEach((viewport: any) => viewport.render?.());
    refreshMeasurements();
    return true;
  }, [measurements, refreshMeasurements]);

  useEffect(() => {
    const removeOnDelete = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (isEditing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const isDeleteKey = event.key === 'Delete' || event.key === 'Supr' || event.key === 'Del' ||
        event.key === 'Backspace' || event.code === 'Delete' || event.code === 'NumpadDecimal';
      if (!isDeleteKey) return;
      if (!removeSelectedMeasurements()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', removeOnDelete, true);
    return () => window.removeEventListener('keydown', removeOnDelete, true);
  }, [removeSelectedMeasurements]);

  return { state, registerViewportElement, applyProtocolLayout, loadSeries, selectViewport,
    setWindowLevel, resetView, invertColors, undoLastAnnotation, mouseToolBindings,
    setMouseToolBinding, shiftMouseToolBindings, setShiftMouseToolBinding, setImageIndex,
    referenceLinesEnabled, setReferenceLinesEnabled, measurements, selectMeasurement,
    removeMeasurement, removeSelectedMeasurements, presentationStates, activePresentationStateUID,
    applyPresentationState, savePresentationState };
}
