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
  IconInvert,
  IconSettings,
} from './Icons';

const MAX_GRID_SIZE = 3;

function gridDimensions(layout: GridLayout): [number, number] {
  const [rows, columns] = layout.split('x').map(Number);
  return [rows, columns];
}

function gridLayout(rows: number, columns: number): GridLayout {
  return `${rows}x${columns}` as GridLayout;
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
  const [hoveredLayout, setHoveredLayout] = useState<GridLayout | null>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const currentLabel = layout === 'mpr' ? 'MPR' : layout.replace('x', '×');
  const currentGridLayout: GridLayout = layout === 'mpr' ? '1x1' : layout;
  const highlightedLayout = hoveredLayout || currentGridLayout;
  const [highlightedRows, highlightedColumns] = gridDimensions(highlightedLayout);

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
        <div className="layout-selector-menu" role="dialog" aria-label="Seleccionar layout">
          <div className="layout-selector-menu-label" aria-live="polite">{highlightedLayout.replace('x', '×')}</div>
          <div
            className="layout-selector-matrix"
            role="grid"
            aria-label={`Seleccionar hasta ${MAX_GRID_SIZE} por ${MAX_GRID_SIZE}`}
            onMouseLeave={() => setHoveredLayout(null)}
          >
            {Array.from({ length: MAX_GRID_SIZE * MAX_GRID_SIZE }, (_, index) => {
              const row = Math.floor(index / MAX_GRID_SIZE) + 1;
              const column = (index % MAX_GRID_SIZE) + 1;
              const option = gridLayout(row, column);
              const highlighted = row <= highlightedRows && column <= highlightedColumns;
              return (
                <button
                  key={option}
                  type="button"
                  className={`layout-matrix-cell${highlighted ? ' highlighted' : ''}${layout === option ? ' active' : ''}`}
                  role="gridcell"
                  aria-label={`Layout ${row} por ${column}`}
                  aria-selected={layout === option}
                  title={`${row}×${column}`}
                  onMouseEnter={() => setHoveredLayout(option)}
                  onFocus={() => setHoveredLayout(option)}
                  onClick={() => {
                    onLayoutChange(option);
                    setHoveredLayout(null);
                    setOpen(false);
                  }}
                />
              );
            })}
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

const MOUSE_BUTTONS: Array<{ value: ConfigurableMouseButton; label: string }> = [
  { value: 'primary', label: 'Clic izquierdo' },
  { value: 'auxiliary', label: 'Clic central' },
  { value: 'secondary', label: 'Clic derecho' },
];

const MouseToolSelector: React.FC<{
  button: ConfigurableMouseButton;
  toolName: ClinicalMouseTool;
  options: ClinicalToolOption[];
  onChange: (button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => void;
}> = ({ button, toolName, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const currentTool = options.find(tool => tool.name === toolName) || NAVIGATION_TOOLS[0];
  const buttonLabel = MOUSE_BUTTONS.find(item => item.value === button)?.label || 'Botón del mouse';

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
    <div ref={selectorRef} className={`mouse-tool-selector${open ? ' open' : ''}`}>
      <button
        type="button"
        className="mouse-tool-trigger"
        onClick={() => setOpen(previous => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${buttonLabel}: ${currentTool.title}`}
      >
        <IconMouseButton className="mouse-binding-icon" button={button} />
        <span className="mouse-tool-current-name">{currentTool.shortTitle}</span>
        <span className="mouse-tool-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && <div className="mouse-tool-menu" role="menu" aria-label={`Herramienta para ${buttonLabel.toLowerCase()}`}>
        <strong>{buttonLabel}</strong>
        <div className="mouse-tool-options">
          {options.map(({ name, Icon, title, shortTitle }) => (
            <button
              key={name}
              type="button"
              className={`mouse-tool-option${name === toolName ? ' active' : ''}`}
              role="menuitemradio"
              aria-checked={name === toolName}
              onClick={() => {
                onChange(button, name);
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
  layout?: HangingLayout;
  onLayoutChange?: (layout: GridLayout) => void;
  toolsSidebarOpen?: boolean;
  onToolsToggle?: () => void;
  mouseToolBindings?: MouseToolBindings;
  onMouseToolChange?: (button: ConfigurableMouseButton, toolName: ClinicalMouseTool) => void;
  mobile?: boolean;
}> = ({
  activeTool = 'WindowLevel', onToolChange, onResetView, onInvertColors, onUndo,
  layout, onLayoutChange, toolsSidebarOpen = false, onToolsToggle,
  mouseToolBindings, onMouseToolChange, mobile = false,
}) => {
  const config = getConfig();
  const availableTools = [
    ...NAVIGATION_TOOLS,
    ...(config.annotationsEnabled ? ANNOTATION_TOOLS : []),
  ];

  return (
    <div className={`annotation-toolbar${mobile ? ' annotation-toolbar-mobile' : ''}`} aria-label="Herramientas del visor">
      {!mobile && mouseToolBindings && onMouseToolChange
        ? MOUSE_BUTTONS.map(({ value }) => <MouseToolSelector
            key={value}
            button={value}
            toolName={mouseToolBindings[value]}
            options={availableTools}
            onChange={onMouseToolChange}
          />)
        : availableTools.map(({ name, Icon, title }) => (
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
      
      <div className="toolbar-divider" />

      <button
        type="button"
        className="annotation-icon-btn"
        onClick={onUndo}
        title="Deshacer (Ctrl+Z)"
        aria-label="Deshacer última acción"
      >
        <IconUndo className="annotation-icon" />
      </button>
      
      <button
        type="button"
        className="annotation-icon-btn"
        onClick={onResetView}
        title="Restablecer vista"
        aria-label="Restablecer vista"
      >
        <IconReset className="annotation-icon" />
      </button>
      
      <button
        type="button"
        className="annotation-icon-btn"
        onClick={onInvertColors}
        title="Invertir colores"
        aria-label="Invertir colores"
      >
        <IconInvert className="annotation-icon" />
      </button>

      {layout && onLayoutChange && <>
        <div className="toolbar-divider" />
        <LayoutSelector layout={layout} onLayoutChange={onLayoutChange} />
      </>}

      {onToolsToggle && <button
        type="button"
        className={`annotation-icon-btn tools-sidebar-toolbar-toggle${toolsSidebarOpen ? ' active' : ''}`}
        onClick={onToolsToggle}
        title="Abrir información y herramientas"
        aria-label="Abrir información y herramientas"
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
    </div>
  );
};

export default Toolbar;
