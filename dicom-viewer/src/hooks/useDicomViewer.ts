import { useState, useEffect, useCallback, useRef } from 'react';
import { ViewerState, DicomStudy, DicomSeries } from '../types/dicom';
import { dicomWebService } from '../services/dicomWeb';
import { getAccessToken } from '../services/auth';
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
} from '../services/cornerstone';

const PRELOAD_RANGE = 10;
const STACK_NEW_IMAGE = 'CORNERSTONE_STACK_NEW_IMAGE';

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
  const initRef = useRef(false);
  const preloadTimerRef = useRef<number | null>(null);
  
  const renderingEngineId = 'dicomRenderingEngine';
  const viewportId = 'dicomViewport';
  const toolGroupId = 'dicomToolGroup';

  useEffect(() => {
    const init = async () => {
      if (initRef.current) return;
      initRef.current = true;
      
      await initializeCornerstone();
      registerTools();
      
      try {
        const token = await getAccessToken('admin', 'Sih.123');
        configureDicomLoader({
          'Authorization': `Bearer ${token}`,
        });
        console.log('DICOM loader configured with auth token');
      } catch (error) {
        console.error('Failed to configure DICOM loader:', error);
      }
    };
    init();
  }, []);

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
        if (!isImageCached(imageId)) {
          loadImageToCache(imageId).catch(() => {});
          count++;
        }
      }

      if (count > 0) {
        console.log(`Pre-loading ${count} images around index ${currentIndex}`);
      }
    }, 50);
  }, []);

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
  }, [handleStackNewImage]);

  useEffect(() => {
    if (state.viewMode === 'viewer' && viewportRef.current && !renderingEngineRef.current) {
      setTimeout(() => {
        initViewport();
      }, 100);
    }

    return () => {
      if (state.viewMode !== 'viewer' && renderingEngineRef.current) {
        if (viewportRef.current) {
          viewportRef.current.removeEventListener(STACK_NEW_IMAGE, handleStackNewImage);
        }
        renderingEngineRef.current.destroy();
        renderingEngineRef.current = null;
      }
    };
  }, [state.viewMode, initViewport, handleStackNewImage]);

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
    if (viewportRef.current) {
      viewportRef.current.removeEventListener(STACK_NEW_IMAGE, handleStackNewImage);
    }
    if (renderingEngineRef.current) {
      renderingEngineRef.current.destroy();
      renderingEngineRef.current = null;
    }
    
    setState(prev => ({
      ...prev,
      viewMode: 'studies',
      isLoaded: false,
      currentStudy: null,
      currentSeries: null,
      currentInstance: null,
      imageIndex: 0,
    }));
  }, [handleStackNewImage]);

  const loadStudy = useCallback(async (study: DicomStudy) => {
    setState(prev => ({ ...prev, isLoading: true, error: null, viewMode: 'viewer' }));
    
    try {
      const seriesList = await dicomWebService.getStudySeries(study.studyInstanceUID);
      
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
        await loadSeries(study.studyInstanceUID, seriesList[0]);
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load study',
      }));
    }
  }, []);

  const loadStudyByUID = useCallback(async (studyInstanceUID: string) => {
    setState(prev => ({ ...prev, isLoading: true, error: null, viewMode: 'viewer' }));
    
    try {
      const studiesData = await dicomWebService.searchStudies({});
      const studyData = studiesData.find(s => s.studyInstanceUID === studyInstanceUID);
      
      if (!studyData) {
        throw new Error('Study not found');
      }

      const seriesList = await dicomWebService.getStudySeries(studyInstanceUID);
      
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
        await loadSeries(studyInstanceUID, seriesList[0]);
      }
    } catch (error) {
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
    series: DicomSeries
  ) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      let instances = await dicomWebService.getSeriesInstances(
        studyInstanceUID,
        series.seriesInstanceUID
      );
      
      instances.sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0));
      
      const fullSeries: DicomSeries = {
        ...series,
        instances,
      };
      
      setState(prev => ({
        ...prev,
        currentSeries: fullSeries,
        isLoading: false,
      }));
      
      if (instances.length > 0) {
        const imageIds = instances.map((instance) => {
          const imageUrl = dicomWebService.getInstanceWadoUriUrl(
            studyInstanceUID,
            series.seriesInstanceUID,
            instance.sopInstanceUID
          );
          return `wadouri:${imageUrl}`;
        });
        
        imageIdsRef.current = imageIds;
        
        const viewportReady = await waitForViewport();
        
        if (viewportReady && renderingEngineRef.current) {
          const viewport = renderingEngineRef.current.getViewport(viewportId);
          
          let windowWidth = 4096;
          let windowCenter = 2048;
          
          const firstMetadata = await dicomWebService.getInstanceMetadata(
            studyInstanceUID,
            series.seriesInstanceUID,
            instances[0].sopInstanceUID
          );
          
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
          await viewport.setStack(imageIds, 0);
          
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
      console.error('Failed to load series:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load series',
      }));
    }
  }, [waitForViewport, preloadAdjacentImages]);

  const setImageIndex = useCallback(async (index: number) => {
    if (!renderingEngineRef.current || !imageIdsRef.current.length) {
      return;
    }

    if (index === state.imageIndex) {
      return;
    }

    setState(prev => ({
      ...prev,
      imageIndex: index,
    }));

    try {
      const viewport = renderingEngineRef.current.getViewport(viewportId);
      await viewport.setStack(imageIdsRef.current, index);
      viewport.render();
      
      setState(prev => ({
        ...prev,
        currentInstance: state.currentSeries?.instances[index] || null,
      }));

      preloadAdjacentImages(index);
    } catch (error) {
      console.error('Failed to set image index:', error);
      setState(prev => ({
        ...prev,
        imageIndex: prev.imageIndex,
      }));
    }
  }, [state.imageIndex, state.currentSeries, preloadAdjacentImages]);

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
    setImageIndex,
    setWindowLevel,
    resetView,
    invertColors,
    navigateToStudies,
    initViewport,
    setActiveAnnotationTool,
  };
}
