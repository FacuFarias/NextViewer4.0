import { init as coreInit, RenderingEngine, Enums, cache, imageLoader, eventTarget } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import * as polySeg from '@cornerstonejs/polymorphic-segmentation';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import NasalSeptumDeviationTool from '../tools/NasalSeptumDeviationTool';
import { getCacheUserKey } from './auth';
import { registerUsLosslessImageLoader } from './usLosslessImageLoader';

let isInitialized = false;

export async function initializeCornerstone(): Promise<void> {
  if (isInitialized) {
    return;
  }

  try {
    await coreInit();
    await dicomImageLoader.init();
    registerUsLosslessImageLoader();
    
    // PlanarFreehandContourSegmentationTool stores contours in the Contour
    // representation.  In MPR, Cornerstone may need to convert that
    // representation before it can render it, so register the official
    // PolySeg add-on during the single global tools initialization.
    cornerstoneTools.init({ addons: { polySeg } });
    
    isInitialized = true;
    console.log('Cornerstone.js initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Cornerstone.js:', error);
    throw error;
  }
}

export function configureDicomLoader(headers: Record<string, string>): void {
  const { setOptions } = dicomImageLoader.internal;
  const loaderHeaders = {
    ...headers,
    'X-Dicom-Cache-User': getCacheUserKey(),
  };
  setOptions({
    beforeSend: (xhr: XMLHttpRequest) => {
      Object.entries(loaderHeaders).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value);
      });
    },
  });
  console.log('DICOM loader configured with headers:', Object.keys(loaderHeaders));
}

export function getImageCache() {
  return cache;
}

export function loadImageToCache(imageId: string): Promise<any> {
  return imageLoader.loadAndCacheImage(imageId, {
    priority: -1,
    requestType: 'prefetch',
  });
}

export function getCachedImage(imageId: string) {
  return cache.getImage(imageId);
}

export function isImageCached(imageId: string): boolean {
  try {
    return !!cache.getImage(imageId);
  } catch {
    return false;
  }
}

export function registerTools(): void {
  const {
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    PlanarFreehandContourSegmentationTool,
    LengthTool,
    ArrowAnnotateTool,
    CircleROITool,
    AngleTool,
    BidirectionalTool,
    RectangleROITool,
  } = cornerstoneTools;

  cornerstoneTools.addTool(WindowLevelTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(StackScrollTool);
  cornerstoneTools.addTool(PlanarFreehandContourSegmentationTool);
  cornerstoneTools.addTool(LengthTool);
  cornerstoneTools.addTool(ArrowAnnotateTool);
  cornerstoneTools.addTool(CircleROITool);
  cornerstoneTools.addTool(AngleTool);
  cornerstoneTools.addTool(BidirectionalTool);
  cornerstoneTools.addTool(RectangleROITool);
  cornerstoneTools.addTool(NasalSeptumDeviationTool);
}

export function createRenderingEngine(renderingEngineId: string): RenderingEngine {
  return new RenderingEngine(renderingEngineId);
}

export function createToolGroup(toolGroupId: string): any {
  return cornerstoneTools.ToolGroupManager.createToolGroup(toolGroupId);
}

export function setupToolGroup(toolGroup: any, viewportId: string): void {
  toolGroup.addTool('WindowLevel');
  toolGroup.addTool('Pan');
  toolGroup.addTool('Zoom');
  toolGroup.addTool('StackScroll');
  toolGroup.addTool(cornerstoneTools.PlanarFreehandContourSegmentationTool.toolName);
  toolGroup.addTool(cornerstoneTools.LengthTool.toolName);
  toolGroup.addTool(cornerstoneTools.ArrowAnnotateTool.toolName);
  toolGroup.addTool(cornerstoneTools.CircleROITool.toolName);
  toolGroup.addTool(cornerstoneTools.AngleTool.toolName);
  toolGroup.addTool(cornerstoneTools.BidirectionalTool.toolName);
  toolGroup.addTool(cornerstoneTools.RectangleROITool.toolName);
  toolGroup.addTool(NasalSeptumDeviationTool.toolName);
  
  toolGroup.addViewport(viewportId);
  
  toolGroup.setToolActive('WindowLevel', {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });
  
  toolGroup.setToolActive('Pan', {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
  
  toolGroup.setToolActive('Zoom', {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
  });
  
  toolGroup.setToolActive('StackScroll', {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  toolGroup.setToolPassive(cornerstoneTools.PlanarFreehandContourSegmentationTool.toolName);
}

export { cornerstoneTools, Enums, cache, eventTarget };
