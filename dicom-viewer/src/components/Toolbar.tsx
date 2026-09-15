import React, { useEffect, useRef, useState } from 'react';
import { WindowLevel } from '../types/dicom';
import type { GridLayout, HangingLayout } from '../types/hangingProtocol';
import type { ClinicalMouseTool, ConfigurableMouseButton, MouseToolBindings } from '../types/tools';
import { getConfig } from '../services/config';
import {
  IconWindowLevel,
  IconPan,
  IconZoom,
  IconStack,
  IconLength,
  IconArrow,
  IconCircle,
  IconAngle,
  IconBidirectional,
  IconRectangle,
  IconEllipse,
  IconProbe,
  IconFreehand,
  IconMouseButton,
  IconReset,
  IconUndo,
  IconReferenceLines,
  IconInvert,
  IconSettings,
} from './Icons';

const GRID_LAYOUTS: GridLayout[] = [
  '1x1', '1x2', '1x3',
  '2x1', '2x2', '2x3',
  '3x1', '3x2', '3x3',
];

function gridDimensions(layout: GridLayout): [number, number] {
  const [rows, columns] = layout.split('x').map(Number);
  return [rows, columns];
}

interface LayoutSelectorProps {
  layout: HangingLayout;
  onLayoutChange: (layout: GridLayout) => void;
}

function LayoutPreview({ layout }: { layout: HangingLayout }) {
  const previewLayout = layout === 'mpr' ? '1x1' : layout;
  const [rows, columns] = gridDimensions(previewLayout);
  return (
    <span
      className="layout-preview"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      aria-hidden="true"
    >
      {Array.from({ length: rows * columns }, (_, index) => <span key={index} />)}
    </span>
  );
}

export const LayoutSelector: React.FC<LayoutSelectorProps> = ({ layout, onLayoutChange }) => {
  const [open, setOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const currentLabel = layout === 'mpr' ? 'MPR' : layout.replace('x', '×');

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !selectorRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('mousedown', closeOnOutsideClick);
    };
  }, [open]);

  return (
    <div ref={selectorRef} className={`layout-selector${open ? ' open' : ''}`}>
      <button
        type="button"
        className="layout-selector-trigger"
        onClick={() => setOpen(previous => !previous)}
        aria-label="Cambiar layout"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Layout actual: ${currentLabel}`}
      >
        <LayoutPreview layout={layout} />
        <span className="layout-selector-label">{currentLabel}</span>
        <span className="layout-selector-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="layout-selector-menu" role="menu" aria-label="Seleccionar layout">
          <div className="layout-selector-menu-header">Distribución</div>
          <div className="layout-options-grid">
            {GRID_LAYOUTS.map(option => (
              <button
                key={option}
                type="button"
                className={`layout-option${layout === option ? ' active' : ''}`}
                role="menuitemradio"
                aria-checked={layout === option}
                onClick={() => {
                  onLayoutChange(option);
                  setOpen(false);
                }}
              >
                <LayoutPreview layout={option} />
                <span>{option.replace('x', '×')}</span>
                {layout === option && <span className="layout-option-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

interface ToolbarProps {
  windowLevel: WindowLevel;
  onWindowLevelChange: (windowWidth: number, windowCenter: number) => void;
  modality?: string;
  mouseToolBindings?: MouseToolBindings;
  onMouseToolChange?: (button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => void;
  shiftMouseToolBindings?: MouseToolBindings;
  onShiftMouseToolChange?: (button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => void;
}

interface WindowPreset {
  name: string;
  width: number;
  center: number;
  modalities: string[];
}

const WINDOW_PRESETS: WindowPreset[] = [
  { name: 'Abdomen', width: 400, center: 40, modalities: ['CT'] },
  { name: 'Hueso', width: 2000, center: 300, modalities: ['CT'] },
  { name: 'Pulmón', width: 1500, center: -600, modalities: ['CT'] },
  { name: 'Cerebro', width: 80, center: 40, modalities: ['CT', 'MR'] },
  { name: 'Subdural', width: 200, center: 75, modalities: ['CT'] },
  { name: 'Hematoma', width: 200, center: 50, modalities: ['CT'] },
  { name: 'Tejido blando', width: 400, center: 40, modalities: ['CT', 'MR'] },
  { name: 'Rodilla MR', width: 2000, center: 1000, modalities: ['MR'] },
  { name: 'Cerebro MR', width: 800, center: 400, modalities: ['MR'] },
  { name: 'Tórax RX', width: 2500, center: 500, modalities: ['DX', 'CR'] },
  { name: 'Mamografía', width: 4000, center: 2000, modalities: ['MG'] },
  { name: 'Genérico', width: 4096, center: 2048, modalities: [] },
];

interface ClinicalToolOption {
  name: ClinicalMouseTool;
  Icon: React.FC<{ className?: string }>;
  title: string;
  shortTitle: string;
}

const NAVIGATION_TOOLS: ClinicalToolOption[] = [
  { name: 'StackScroll', Icon: IconStack, title: 'Recorrer imágenes', shortTitle: 'Stack' },
  { name: 'Zoom', Icon: IconZoom, title: 'Zoom', shortTitle: 'Zoom' },
  { name: 'Magnify', Icon: IconZoom, title: 'Lupa de aumento', shortTitle: 'Lupa' },
  { name: 'WindowLevel', Icon: IconWindowLevel, title: 'Window/Level', shortTitle: 'W/L' },
  { name: 'Pan', Icon: IconPan, title: 'Desplazar imagen', shortTitle: 'Pan' },
];

const ANNOTATION_TOOLS: ClinicalToolOption[] = [
  { name: 'Length', Icon: IconLength, title: 'Medir distancia', shortTitle: 'Longitud' },
  { name: 'ArrowAnnotate', Icon: IconArrow, title: 'Flecha', shortTitle: 'Flecha' },
  { name: 'CircleROI', Icon: IconCircle, title: 'ROI circular', shortTitle: 'ROI círculo' },
  { name: 'Angle', Icon: IconAngle, title: 'Ángulo', shortTitle: 'Ángulo' },
  { name: 'Bidirectional', Icon: IconBidirectional, title: 'Bidireccional', shortTitle: 'Bidirecc.' },
  { name: 'RectangleROI', Icon: IconRectangle, title: 'Rectángulo', shortTitle: 'Rectángulo' },
  { name: 'EllipticalROI', Icon: IconEllipse, title: 'ROI elíptica', shortTitle: 'Elipse' },
  { name: 'Probe', Icon: IconProbe, title: 'Sonda de valores', shortTitle: 'Sonda' },
  { name: 'PlanarFreehandROI', Icon: IconFreehand, title: 'ROI a mano alzada', shortTitle: 'Mano alzada' },
];

const PRIMARY_TOOLS = NAVIGATION_TOOLS.filter(({ name }) =>
  name === 'WindowLevel' || name === 'Pan' || name === 'Zoom'
);

function availableToolOptions(annotationsEnabled: boolean): ClinicalToolOption[] {
  return [
    ...NAVIGATION_TOOLS,
    ...(annotationsEnabled ? ANNOTATION_TOOLS : []),
  ];
}

const MOUSE_BUTTONS: Array<{ value: ConfigurableMouseButton; label: string }> = [
  { value: 'primary', label: 'Clic izquierdo' },
  { value: 'auxiliary', label: 'Clic central' },
  { value: 'secondary', label: 'Clic derecho' },
];

const MeasurementSelector: React.FC<{
  activeTool: ClinicalMouseTool;
  onToolChange?: (toolName: ClinicalMouseTool) => void;
}> = ({ activeTool, onToolChange }) => {
  const [open, setOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const selectedTool = ANNOTATION_TOOLS.find(tool => tool.name === activeTool);
  const currentTool = selectedTool || ANNOTATION_TOOLS[0];
  const CurrentIcon = currentTool.Icon;

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !selectorRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('mousedown', closeOnOutsideClick);
    };
  }, [open]);

  return (
    <div ref={selectorRef} className={`measurement-selector${open ? ' open' : ''}${selectedTool ? ' active' : ''}`}>
      <button
        type="button"
        className="measurement-selector-main"
        onClick={() => onToolChange?.(currentTool.name)}
        title={currentTool.title}
        aria-label={`Activar ${currentTool.title}`}
        aria-pressed={Boolean(selectedTool)}
      >
        <CurrentIcon className="annotation-icon" />
        <span className="toolbar-button-label">Medir</span>
      </button>
      <button
        type="button"
        className="measurement-selector-toggle"
        onClick={() => setOpen(previous => !previous)}
        title="Elegir herramienta de medición o anotación"
        aria-label="Elegir herramienta de medición o anotación"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span aria-hidden="true">⌄</span>
      </button>
      {open && <div className="measurement-selector-menu" role="menu" aria-label="Mediciones y anotaciones">
        <div className="measurement-selector-menu-header">
          <strong>Medición y anotación</strong>
          <span>Selecciona una herramienta</span>
        </div>
        <div className="measurement-selector-options">
          {ANNOTATION_TOOLS.map(({ name, Icon, title, shortTitle }) => (
            <button
              key={name}
              type="button"
              className={`measurement-option${activeTool === name ? ' active' : ''}`}
              role="menuitemradio"
              aria-checked={activeTool === name}
              onClick={() => {
                onToolChange?.(name);
                setOpen(false);
              }}
              title={title}
            >
              <Icon className="annotation-icon" />
              <span>{shortTitle}</span>
            </button>
          ))}
        </div>
      </div>}
    </div>
  );
};

export const AnnotationToolbar: React.FC<{
  activeTool?: ClinicalMouseTool;
  onToolChange?: (toolName: ClinicalMouseTool) => void;
  onResetView?: () => void;
  onInvertColors?: () => void;
  onUndo?: () => void;
  onReferenceLinesToggle?: () => void;
  referenceLinesEnabled?: boolean;
  layout?: HangingLayout;
  onLayoutChange?: (layout: GridLayout) => void;
  toolsSidebarOpen?: boolean;
  onToolsToggle?: () => void;
  mobile?: boolean;
}> = ({
  activeTool = 'WindowLevel', onToolChange, onResetView, onInvertColors, onUndo,
  onReferenceLinesToggle, referenceLinesEnabled = false,
  layout, onLayoutChange, toolsSidebarOpen = false, onToolsToggle,
  mobile = false,
}) => {
  const config = getConfig();
  const availableTools = availableToolOptions(config.annotationsEnabled);

  return (
    <div className={`annotation-toolbar${mobile ? ' annotation-toolbar-mobile' : ''}`} aria-label="Herramientas del visor">
      {!mobile ? <>
        <div className="toolbar-group toolbar-mode-group" role="group" aria-label="Herramienta principal">
          {PRIMARY_TOOLS.map(({ name, Icon, title, shortTitle }) => (
            <button
              key={name}
              type="button"
              className={`toolbar-mode-btn${activeTool === name ? ' active' : ''}`}
              onClick={() => onToolChange?.(name)}
              title={title}
              aria-label={`Activar ${title}`}
              aria-pressed={activeTool === name}
            >
              <Icon className="annotation-icon" />
              <span>{shortTitle}</span>
            </button>
          ))}
        </div>
        {config.annotationsEnabled && <>
          <div className="toolbar-divider" aria-hidden="true" />
          <MeasurementSelector activeTool={activeTool} onToolChange={onToolChange} />
        </>}
      </> : availableTools.map(({ name, Icon, title }) => (
          <button
            key={name}
            type="button"
            className={`annotation-icon-btn ${activeTool === name ? 'active' : ''}`}
            onClick={() => onToolChange?.(name)}
            title={title}
            aria-label={title}
            aria-pressed={activeTool === name}
          >
            <Icon className="annotation-icon" />
          </button>
        ))}

      <div className="toolbar-divider" aria-hidden="true" />
      <div className="toolbar-group toolbar-action-group" role="group" aria-label="Acciones de visualización">
        <button type="button" className="annotation-icon-btn" onClick={onUndo} title="Deshacer (Ctrl+Z)" aria-label="Deshacer última acción">
          <IconUndo className="annotation-icon" />
        </button>
        <button type="button" className="toolbar-action-btn" onClick={onInvertColors} title="Invertir colores" aria-label="Invertir colores">
          <IconInvert className="annotation-icon" />
          <span className="toolbar-button-label">Invertir</span>
        </button>
        <button type="button" className="toolbar-action-btn" onClick={onResetView} title="Restablecer vista" aria-label="Restablecer vista">
          <IconReset className="annotation-icon" />
          <span className="toolbar-button-label">Restablecer</span>
        </button>
      </div>

      {onReferenceLinesToggle && <>
        <div className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={`toolbar-sync-btn${referenceLinesEnabled ? ' active' : ''}`}
          onClick={onReferenceLinesToggle}
          title={referenceLinesEnabled ? 'Ocultar líneas de referencia entre viewports' : 'Mostrar líneas de referencia entre viewports'}
          aria-label={referenceLinesEnabled ? 'Desactivar referencias entre viewports' : 'Activar referencias entre viewports'}
          aria-pressed={referenceLinesEnabled}
        >
          <IconReferenceLines className="annotation-icon" />
          <span className="toolbar-button-label">Referencias</span>
          <span className="toolbar-toggle-state" aria-hidden="true">{referenceLinesEnabled ? 'ON' : 'OFF'}</span>
        </button>
      </>}

      {layout && onLayoutChange && <>
        <div className="toolbar-divider" aria-hidden="true" />
        <LayoutSelector layout={layout} onLayoutChange={onLayoutChange} />
      </>}

      {onToolsToggle && <button
          type="button"
          className={`annotation-icon-btn tools-sidebar-toolbar-toggle${toolsSidebarOpen ? ' active' : ''}`}
          onClick={onToolsToggle}
          title="Abrir configuración y herramientas secundarias"
          aria-label="Abrir configuración y herramientas secundarias"
          aria-controls="clinical-tools-sidebar"
          aria-expanded={toolsSidebarOpen}
        >
          <IconSettings className="annotation-icon" />
        </button>}
    </div>
  );
};

const Toolbar: React.FC<ToolbarProps> = ({
  windowLevel,
  onWindowLevelChange,
  modality,
  mouseToolBindings,
  onMouseToolChange,
  shiftMouseToolBindings,
  onShiftMouseToolChange,
}) => {
  const [showPresets, setShowPresets] = useState(false);
  const config = getConfig();

  const filteredPresets = WINDOW_PRESETS.filter(preset => 
    preset.modalities.length === 0 || 
    !modality || 
    preset.modalities.includes(modality)
  );

  const handleWindowWidthChange = (value: number) => {
    onWindowLevelChange(Math.max(1, value), windowLevel.windowCenter);
  };

  const handleWindowCenterChange = (value: number) => {
    onWindowLevelChange(windowLevel.windowWidth, value);
  };

  return (
    <div className="toolbar">
      <div className="toolbar-section">
        <h4>Window/Level</h4>
        <div className="wl-controls">
          <div className="wl-control">
            <label>
              <span className="control-label">W:</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={Math.round(windowLevel.windowWidth)}
                onChange={(e) => handleWindowWidthChange(parseInt(e.target.value) || 1)}
                className="wl-input"
              />
            </label>
            <input
              type="range"
              min="1"
              max="4096"
              value={Math.min(windowLevel.windowWidth, 4096)}
              onChange={(e) => handleWindowWidthChange(parseInt(e.target.value))}
              className="wl-slider"
            />
          </div>
          <div className="wl-control">
            <label>
              <span className="control-label">L:</span>
              <input
                type="number"
                min="-1024"
                max="65535"
                value={Math.round(windowLevel.windowCenter)}
                onChange={(e) => handleWindowCenterChange(parseInt(e.target.value) || 0)}
                className="wl-input"
              />
            </label>
            <input
              type="range"
              min="-1024"
              max="3000"
              value={windowLevel.windowCenter}
              onChange={(e) => handleWindowCenterChange(parseInt(e.target.value))}
              className="wl-slider"
            />
          </div>
        </div>
      </div>

      {config.windowLevelPresetsEnabled && (
        <div className="toolbar-section">
          <div className="presets-header">
            <h4>Presets</h4>
            <button 
              className="toggle-presets"
              onClick={() => setShowPresets(!showPresets)}
            >
              {showPresets ? '▲' : '▼'}
            </button>
          </div>
          {showPresets && (
            <div className="presets-grid">
              {filteredPresets.map((preset) => (
                <button
                  key={preset.name}
                  className={`preset-btn ${windowLevel.windowWidth === preset.width && windowLevel.windowCenter === preset.center ? 'active' : ''}`}
                  onClick={() => onWindowLevelChange(preset.width, preset.center)}
                  title={`W: ${preset.width} L: ${preset.center}`}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mouseToolBindings && onMouseToolChange && <div className="toolbar-section mouse-bindings-panel">
        <div className="mouse-bindings-heading">
          <h4>Asignación del ratón</h4>
          <span>Herramientas por botón</span>
        </div>
        <div className="mouse-binding-rows">
          {MOUSE_BUTTONS.map(({ value, label }) => <label key={value} className="mouse-binding-row">
            <span className="mouse-binding-row-label">
              <IconMouseButton className="mouse-binding-icon" button={value} />
              <span>{label}</span>
            </span>
            <select
              value={mouseToolBindings[value]}
              onChange={event => onMouseToolChange(value, event.target.value as ClinicalMouseTool)}
              aria-label={`Herramienta para ${label.toLowerCase()}`}
            >
              {availableToolOptions(config.annotationsEnabled).map(option => <option key={option.name} value={option.name}>{option.shortTitle}</option>)}
            </select>
          </label>)}
        </div>

        {shiftMouseToolBindings && onShiftMouseToolChange && <details className="shift-bindings-details">
          <summary>Combinaciones con Shift</summary>
          <div className="mouse-binding-rows">
            {MOUSE_BUTTONS.map(({ value, label }) => <label key={value} className="mouse-binding-row">
              <span className="mouse-binding-row-label">
                <IconMouseButton className="mouse-binding-icon" button={value} />
                <span>Shift + {label.toLowerCase()}</span>
              </span>
              <select
                value={shiftMouseToolBindings[value]}
                onChange={event => onShiftMouseToolChange(value, event.target.value as ClinicalMouseTool)}
                aria-label={`Herramienta para Shift y ${label.toLowerCase()}`}
              >
                {availableToolOptions(config.annotationsEnabled).map(option => <option key={option.name} value={option.name}>{option.shortTitle}</option>)}
              </select>
            </label>)}
          </div>
        </details>}
      </div>}
    </div>
  );
};

export default Toolbar;
