export const CLINICAL_MOUSE_TOOLS = [
  'StackScroll',
  'Zoom',
  'Magnify',
  'WindowLevel',
  'Pan',
  'Length',
  'ArrowAnnotate',
  'Angle',
  'Probe',
  'CircleROI',
  'EllipticalROI',
  'RectangleROI',
  'Bidirectional',
  'PlanarFreehandROI',
] as const;

export type ClinicalMouseTool = typeof CLINICAL_MOUSE_TOOLS[number];
export type ConfigurableMouseButton = 'primary' | 'auxiliary' | 'secondary';

export interface MouseToolBindings {
  primary: ClinicalMouseTool;
  auxiliary: ClinicalMouseTool;
  secondary: ClinicalMouseTool;
}

export const DEFAULT_MOUSE_TOOL_BINDINGS: MouseToolBindings = {
  primary: 'WindowLevel',
  auxiliary: 'Pan',
  secondary: 'Zoom',
};
