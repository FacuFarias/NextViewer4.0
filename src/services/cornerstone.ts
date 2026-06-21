import { init as coreInit, RenderingEngine, Enums, cache, imageLoader } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';

let isInitialized = false;

export async function initializeCornerstone(): Promise<void> {
  if (isInitialized) {
    return;
  }

  try {
    await coreInit();
    await dicomImageLoader.init();
    
    cornerstoneTools.init();
    
    isInitialized = true;
    console.log('Cornerstone.js initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Cornerstone.js:', error);
    throw error;
  }
}

export function configureDicomLoader(headers: Record<string, string>): void {
  const { setOptions } = dicomImageLoader.internal;
  setOptions({
    beforeSend: (xhr: XMLHttpRequest) => {
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value);
      });
    },
  });
  console.log('DICOM loader configured with headers:', Object.keys(headers));
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
  const { WindowLevelTool, PanTool, ZoomTool, StackScrollTool } = cornerstoneTools;

  cornerstoneTools.addTool(WindowLevelTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(StackScrollTool);
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
}

export { cornerstoneTools, Enums, cache };
