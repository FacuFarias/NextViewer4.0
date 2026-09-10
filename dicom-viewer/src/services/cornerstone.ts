import { cache, Enums, imageLoader, init as coreInit, RenderingEngine, utilities } from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import * as cornerstoneTools from '@cornerstonejs/tools';
import type { MouseToolBindings } from '../types/tools';
import { DEFAULT_MOUSE_TOOL_BINDINGS } from '../types/tools';
import { registerUsLosslessImageLoader } from './usLosslessImageLoader';

let initialized = false;
let toolsRegistered = false;
const CLINICAL_CURSOR_COLOR = 'rgb(139, 92, 246)';
const CLINICAL_TOOL_CLASSES = [
  cornerstoneTools.WindowLevelTool,
  cornerstoneTools.PanTool,
  cornerstoneTools.ZoomTool,
  cornerstoneTools.StackScrollTool,
  cornerstoneTools.MagnifyTool,
  cornerstoneTools.LengthTool,
  cornerstoneTools.ArrowAnnotateTool,
  cornerstoneTools.CircleROITool,
  cornerstoneTools.EllipticalROITool,
  cornerstoneTools.AngleTool,
  cornerstoneTools.ProbeTool,
  cornerstoneTools.BidirectionalTool,
  cornerstoneTools.RectangleROITool,
  cornerstoneTools.PlanarFreehandROITool,
];

function configureClinicalCursorColor(): void {
  const toolStyle = cornerstoneTools.annotation.config.style;
  const defaultStyles = toolStyle.getDefaultToolStyles();
  toolStyle.setDefaultToolStyles({
    ...defaultStyles,
    global: {
      ...defaultStyles.global,
      colorHighlightedActive: CLINICAL_CURSOR_COLOR,
    },
  });
}

export async function initializeCornerstone(): Promise<void> {
  if (initialized) return;
  await coreInit();
  await dicomImageLoader.init();
  cornerstoneTools.init();
  configureClinicalCursorColor();
  registerUsLosslessImageLoader();
  initialized = true;
}

export function configureDicomLoader(headers: Record<string, string>): void {
  dicomImageLoader.internal.setOptions({
    beforeSend: (xhr: XMLHttpRequest) => {
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    },
  });
}

export function loadImageToCache(imageId: string): Promise<any> {
  return imageLoader.loadAndCacheImage(imageId, { priority: -1, requestType: 'prefetch' });
}

export function isImageCached(imageId: string): boolean {
  try {
    return Boolean(cache.getImage(imageId));
  } catch {
    return false;
  }
}

export function clearClinicalMeasurements(): void {
  cornerstoneTools.annotation.state.removeAllAnnotations();
  const history = utilities.HistoryMemo.DefaultHistoryMemo;
  const historySize = history.size;
  history.size = historySize;
}

export function undoClinicalAction(): boolean {
  const history = utilities.HistoryMemo.DefaultHistoryMemo;
  if (!history.canUndo) return false;
  history.undo();
  return true;
}

export function purgeMemoryCache(): void {
  cache.purgeCache();
}

export function registerTools(): void {
  if (toolsRegistered) return;
  for (const tool of CLINICAL_TOOL_CLASSES) cornerstoneTools.addTool(tool);
  toolsRegistered = true;
}

export function createRenderingEngine(id: string): RenderingEngine {
  return new RenderingEngine(id);
}

export function createToolGroup(id: string): any {
  cornerstoneTools.ToolGroupManager.destroyToolGroup(id);
  return cornerstoneTools.ToolGroupManager.createToolGroup(id);
}

export function applyMouseToolBindings(toolGroup: any, bindings: MouseToolBindings): void {
  const mouseButtons = cornerstoneTools.Enums.MouseBindings;
  const buttonBindings = {
    primary: mouseButtons.Primary,
    auxiliary: mouseButtons.Auxiliary,
    secondary: mouseButtons.Secondary,
  };
  const bindingsByTool = new Map<string, Array<{ mouseButton?: number; numTouchPoints?: number }>>();
  for (const [button, toolName] of Object.entries(bindings) as Array<[keyof MouseToolBindings, string]>) {
    const toolBindings = bindingsByTool.get(toolName) || [];
    toolBindings.push({ mouseButton: buttonBindings[button] });
    bindingsByTool.set(toolName, toolBindings);
  }

  const stackBindings = bindingsByTool.get(cornerstoneTools.StackScrollTool.toolName) || [];
  stackBindings.push({ mouseButton: mouseButtons.Wheel });
  bindingsByTool.set(cornerstoneTools.StackScrollTool.toolName, stackBindings);

  const zoomBindings = bindingsByTool.get(cornerstoneTools.ZoomTool.toolName) || [];
  zoomBindings.push({ numTouchPoints: 2 });
  bindingsByTool.set(cornerstoneTools.ZoomTool.toolName, zoomBindings);

  for (const tool of CLINICAL_TOOL_CLASSES) toolGroup.setToolPassive(tool.toolName);
  for (const [toolName, toolBindings] of bindingsByTool) {
    toolGroup.setToolActive(toolName, { bindings: toolBindings });
  }
}

export function setupToolGroup(
  toolGroup: any,
  viewportIds: string | string[],
  renderingEngineId?: string,
  mouseToolBindings: MouseToolBindings = DEFAULT_MOUSE_TOOL_BINDINGS,
): void {
  for (const tool of CLINICAL_TOOL_CLASSES) toolGroup.addTool(tool.toolName);
  for (const viewportId of Array.isArray(viewportIds) ? viewportIds : [viewportIds]) {
    if (renderingEngineId) toolGroup.addViewport(viewportId, renderingEngineId);
    else toolGroup.addViewport(viewportId);
  }
  applyMouseToolBindings(toolGroup, mouseToolBindings);
}

export { cache, cornerstoneTools, Enums };
