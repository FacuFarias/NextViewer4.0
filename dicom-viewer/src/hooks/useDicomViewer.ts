import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClinicalViewportState, DicomInstance, DicomSeries, ViewerLayoutMode, ViewerState } from '../types/dicom';
import type { HangingAssignment, HangingLayout } from '../types/hangingProtocol';
import type { ClinicalMouseTool, ConfigurableMouseButton, MouseToolBindings } from '../types/tools';
import { CLINICAL_MOUSE_TOOLS, DEFAULT_MOUSE_TOOL_BINDINGS } from '../types/tools';
import { getDicomRequestHeaders } from '../services/auth';
import {
  applyMouseToolBindings, clearClinicalMeasurements, configureDicomLoader, cornerstoneTools, createRenderingEngine,
  createToolGroup, Enums, initializeCornerstone, isImageCached, loadImageToCache,
  purgeMemoryCache, registerTools, setupToolGroup, undoClinicalAction,
} from '../services/cornerstone';
import { expandMultiframeInstances, getDicomFrameImageId } from '../services/dicomFrames';
import { dicomWebService, mergeDefinedDicomMetadata } from '../services/dicomWeb';
import { getUsLosslessImageId } from '../services/usLosslessImageLoader';
import { isClinicalImageModality, isSupportedVisualInstance, resolveViewerModality } from '../services/viewerModality';

const PRELOAD_RANGE = 6;
const STACK_NEW_IMAGE = 'CORNERSTONE_STACK_NEW_IMAGE';
const RENDERING_ENGINE_ID = 'clinicalRenderingEngine';
const TOOL_GROUP_ID = 'clinicalToolGroup';
const MOUSE_BINDINGS_STORAGE_KEY = 'nextviewer.mouseToolBindings';
const defaultWindowLevel = { windowWidth: 4096, windowCenter: 2048 };

function loadMouseToolBindings(): MouseToolBindings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(MOUSE_BINDINGS_STORAGE_KEY) || '{}') as Partial<MouseToolBindings>;
    const availableTools = new Set<string>(CLINICAL_MOUSE_TOOLS);
    const isPreviousDefault = stored.primary === 'WindowLevel' && stored.auxiliary === 'Zoom' && stored.secondary === 'Pan';
    if (isPreviousDefault) return DEFAULT_MOUSE_TOOL_BINDINGS;
    return {
      primary: availableTools.has(stored.primary || '') ? stored.primary! : DEFAULT_MOUSE_TOOL_BINDINGS.primary,
      auxiliary: availableTools.has(stored.auxiliary || '') ? stored.auxiliary! : DEFAULT_MOUSE_TOOL_BINDINGS.auxiliary,
      secondary: availableTools.has(stored.secondary || '') ? stored.secondary! : DEFAULT_MOUSE_TOOL_BINDINGS.secondary,
    };
  } catch {
    return DEFAULT_MOUSE_TOOL_BINDINGS;
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
  }, [preloadAdjacentImages]);

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
      clearClinicalMeasurements();
      cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      renderingEngineRef.current?.destroy();
      purgeMemoryCache();
    };
  }, [handleStackNewImage]);

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
      setupToolGroup(toolGroup, viewportIds, RENDERING_ENGINE_ID, mouseToolBindingsRef.current);
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
    };
    void initializeLayout().catch(error => {
      if (!disposed) setState(previous => ({ ...previous, isLoading: false, error: error instanceof Error ? error.message : 'No se pudo aplicar el protocolo.' }));
    });
    return () => { disposed = true; };
    // layoutVersion owns viewport recreation; navigation state must not recreate the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cornerstoneReady, layoutVersion, scheduleRenderingEngineResize]);

  const applyProtocolLayout = useCallback((layout: HangingLayout, assignments: HangingAssignment[]) => {
    clearClinicalMeasurements();
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
  }, []);

  const loadSeries = useCallback(async (studyUID: string, series: DicomSeries, viewportId = state.activeViewportId) => {
    clearClinicalMeasurements();
    setState(previous => ({ ...previous, isLoading: true, error: null }));
    try {
      await loadIntoViewport(viewportId, studyUID, series);
      setState(previous => ({ ...previous, isLoading: false, isLoaded: true }));
    } catch (error) {
      setState(previous => ({ ...previous, isLoading: false, error: error instanceof Error ? error.message : 'No se pudo cargar la serie.' }));
    }
  }, [loadIntoViewport, state.activeViewportId]);

  useEffect(() => {
    let cancelled = false;
    setState(previous => ({ ...previous, isLoading: true, isLoaded: false, error: null }));
    clearClinicalMeasurements(); purgeMemoryCache();
    void Promise.all([dicomWebService.getStudyByUID(studyInstanceUID), dicomWebService.getStudySeries(studyInstanceUID)])
      .then(([study, allSeries]) => {
        if (cancelled) return;
        if (!study) throw new Error('El estudio solicitado no está disponible o no está autorizado.');
        const series = allSeries.filter(entry => isClinicalImageModality(entry.modality));
        if (!series.length) throw new Error('El estudio no contiene series de imágenes.');
        setState(previous => ({ ...previous, currentStudy: { ...study, series }, isLoading: false }));
      })
      .catch(error => {
        if (!cancelled) setState(previous => ({ ...previous, isLoading: false, error: error instanceof Error ? error.message : 'No se pudo cargar el estudio.' }));
      });
    return () => { cancelled = true; };
  }, [studyInstanceUID]);

  const selectViewport = useCallback((viewportId: string) => {
    setState(previous => {
      const selected = previous.viewports.find(viewport => viewport.id === viewportId);
      return selected ? { ...previous, activeViewportId: viewportId, currentSeries: selected.series,
        currentInstance: selected.instance, imageIndex: selected.imageIndex, windowLevel: selected.windowLevel } : previous;
    });
  }, []);

  const activeViewport = useMemo(() => state.viewports.find(viewport => viewport.id === state.activeViewportId), [state.activeViewportId, state.viewports]);

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

  const setMouseToolBinding = useCallback((button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => {
    const nextBindings = { ...mouseToolBindingsRef.current, [button]: toolName };
    mouseToolBindingsRef.current = nextBindings;
    setMouseToolBindings(nextBindings);
    try {
      window.localStorage.setItem(MOUSE_BINDINGS_STORAGE_KEY, JSON.stringify(nextBindings));
    } catch {
      // The current browser may disallow persistent storage; bindings still work for this viewer session.
    }
    if (toolGroupRef.current) applyMouseToolBindings(toolGroupRef.current, nextBindings);
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

  return { state, registerViewportElement, applyProtocolLayout, loadSeries, selectViewport,
    setWindowLevel, resetView, invertColors, undoLastAnnotation, mouseToolBindings,
    setMouseToolBinding, setImageIndex };
}
