import React, { useEffect, useRef, useCallback, useState } from 'react';
import { RenderingEngine, Enums, volumeLoader, cache, setVolumesForViewports } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { DicomSeries } from '../types/dicom';
import { dicomWebService } from '../services/dicomWeb';

interface MPRViewProps {
  studyInstanceUID: string;
  series: DicomSeries;
  onBack: () => void;
  embedded?: boolean;
}

const VOLUME_ID = 'mpr-volume';
const AXIAL_VIEWPORT_ID = 'mpr-axial';
const SAGITTAL_VIEWPORT_ID = 'mpr-sagittal';
const CORONAL_VIEWPORT_ID = 'mpr-coronal';
const TOOL_GROUP_ID = 'mpr-tool-group';

type ViewportId = 'axial' | 'sagittal' | 'coronal';

const MPRView: React.FC<MPRViewProps> = ({
  studyInstanceUID,
  series,
  onBack,
  embedded = false,
}) => {
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const renderingEngineRef = useRef<RenderingEngine | null>(null);
  const toolGroupRef = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maximizedViewport, setMaximizedViewport] = useState<ViewportId | null>(null);
  const [activeTool, setActiveTool] = useState<string>('WindowLevel');

  const handleDoubleClick = useCallback((viewportId: ViewportId) => {
    setMaximizedViewport(prev => prev === viewportId ? null : viewportId);
    
    setTimeout(() => {
      if (renderingEngineRef.current) {
        renderingEngineRef.current.resize();
      }
    }, 100);
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

    toolGroupRef.current.setToolPassive(WindowLevelTool.toolName);
    toolGroupRef.current.setToolPassive(LengthTool.toolName);
    toolGroupRef.current.setToolPassive(ArrowAnnotateTool.toolName);
    toolGroupRef.current.setToolPassive(CircleROITool.toolName);
    toolGroupRef.current.setToolPassive(AngleTool.toolName);
    toolGroupRef.current.setToolPassive(BidirectionalTool.toolName);
    toolGroupRef.current.setToolPassive(RectangleROITool.toolName);

    toolGroupRef.current.setToolActive(toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });

    setActiveTool(toolName);
  }, []);

  const initMPR = useCallback(async () => {
    if (!axialRef.current || !sagittalRef.current || !coronalRef.current) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const {
        WindowLevelTool,
        StackScrollTool,
        CrosshairsTool,
        LengthTool,
        ArrowAnnotateTool,
        CircleROITool,
        AngleTool,
        BidirectionalTool,
        RectangleROITool,
        PanTool,
        ZoomTool,
        ToolGroupManager,
        addTool,
      } = cornerstoneTools;

      addTool(PanTool);
      addTool(ZoomTool);
      addTool(WindowLevelTool);
      addTool(StackScrollTool);
      addTool(CrosshairsTool);
      addTool(LengthTool);
      addTool(ArrowAnnotateTool);
      addTool(CircleROITool);
      addTool(AngleTool);
      addTool(BidirectionalTool);
      addTool(RectangleROITool);

      const renderingEngineId = 'mpr-rendering-engine';
      const renderingEngine = new RenderingEngine(renderingEngineId);
      renderingEngineRef.current = renderingEngine;

      const imageIds = series.instances
        .sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0))
        .map((instance) => {
          const imageUrl = dicomWebService.getInstanceWadoUriUrl(
            studyInstanceUID,
            series.seriesInstanceUID,
            instance.sopInstanceUID
          );
          return `wadouri:${imageUrl}`;
        });

      const volumeId = VOLUME_ID;
      
      const volume = await volumeLoader.createAndCacheVolume(volumeId, {
        imageIds,
      });

      await volume.load();

      const viewportInputs = [
        {
          viewportId: AXIAL_VIEWPORT_ID,
          element: axialRef.current,
          type: Enums.ViewportType.ORTHOGRAPHIC,
          defaultOptions: {
            orientation: Enums.OrientationAxis.AXIAL,
          },
        },
        {
          viewportId: SAGITTAL_VIEWPORT_ID,
          element: sagittalRef.current,
          type: Enums.ViewportType.ORTHOGRAPHIC,
          defaultOptions: {
            orientation: Enums.OrientationAxis.SAGITTAL,
          },
        },
        {
          viewportId: CORONAL_VIEWPORT_ID,
          element: coronalRef.current,
          type: Enums.ViewportType.ORTHOGRAPHIC,
          defaultOptions: {
            orientation: Enums.OrientationAxis.CORONAL,
          },
        },
      ];

      renderingEngine.setViewports(viewportInputs);

      const toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
      toolGroupRef.current = toolGroup;

      if (toolGroup) {
        toolGroup.addTool(PanTool.toolName);
        toolGroup.addTool(ZoomTool.toolName);
        toolGroup.addTool(WindowLevelTool.toolName);
        toolGroup.addTool(StackScrollTool.toolName);
        toolGroup.addTool(CrosshairsTool.toolName);
        toolGroup.addTool(LengthTool.toolName);
        toolGroup.addTool(ArrowAnnotateTool.toolName);
        toolGroup.addTool(CircleROITool.toolName);
        toolGroup.addTool(AngleTool.toolName);
        toolGroup.addTool(BidirectionalTool.toolName);
        toolGroup.addTool(RectangleROITool.toolName);

        toolGroup.addViewport(AXIAL_VIEWPORT_ID, renderingEngineId);
        toolGroup.addViewport(SAGITTAL_VIEWPORT_ID, renderingEngineId);
        toolGroup.addViewport(CORONAL_VIEWPORT_ID, renderingEngineId);

        toolGroup.setToolActive(WindowLevelTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });

        toolGroup.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
        });

        toolGroup.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
        });

        toolGroup.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
        });

        toolGroup.setToolActive(CrosshairsTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Ctrl }],
        });

        toolGroup.setToolPassive(LengthTool.toolName);
        toolGroup.setToolPassive(ArrowAnnotateTool.toolName);
        toolGroup.setToolPassive(CircleROITool.toolName);
        toolGroup.setToolPassive(AngleTool.toolName);
        toolGroup.setToolPassive(BidirectionalTool.toolName);
        toolGroup.setToolPassive(RectangleROITool.toolName);
      }

      await setVolumesForViewports(
        renderingEngine,
        [{ volumeId }],
        [AXIAL_VIEWPORT_ID, SAGITTAL_VIEWPORT_ID, CORONAL_VIEWPORT_ID]
      );

      renderingEngine.renderViewports([
        AXIAL_VIEWPORT_ID,
        SAGITTAL_VIEWPORT_ID,
        CORONAL_VIEWPORT_ID,
      ]);

      setIsLoading(false);
    } catch (err) {
      console.error('Failed to initialize MPR:', err);
      setError(err instanceof Error ? err.message : 'Failed to initialize MPR');
      setIsLoading(false);
    }
  }, [studyInstanceUID, series]);

  useEffect(() => {
    initMPR();

    return () => {
      if (toolGroupRef.current) {
        cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
        toolGroupRef.current = null;
      }
      if (renderingEngineRef.current) {
        renderingEngineRef.current.destroy();
        renderingEngineRef.current = null;
      }
      try {
        cache.removeVolumeLoadObject(VOLUME_ID);
      } catch (e) {
        // Ignore
      }
    };
  }, [initMPR]);

  const getViewportClass = (viewportId: ViewportId) => {
    if (maximizedViewport === null) return 'mpr-viewport-container';
    if (maximizedViewport === viewportId) return 'mpr-viewport-container maximized';
    return 'mpr-viewport-container hidden';
  };

  const annotationTools = [
    { name: 'Length', label: '📏 Longitud', toolName: cornerstoneTools.LengthTool.toolName },
    { name: 'Arrow', label: '➡️ Flecha', toolName: cornerstoneTools.ArrowAnnotateTool.toolName },
    { name: 'Circle', label: '⭕ Círculo', toolName: cornerstoneTools.CircleROITool.toolName },
    { name: 'Angle', label: '📐 Ángulo', toolName: cornerstoneTools.AngleTool.toolName },
    { name: 'Bidirectional', label: '↔️ Bidireccional', toolName: cornerstoneTools.BidirectionalTool.toolName },
    { name: 'Rectangle', label: '⬜ Rectángulo', toolName: cornerstoneTools.RectangleROITool.toolName },
  ];

  const renderViewports = () => (
    <>
      <div className={getViewportClass('axial')}>
        <div className="mpr-viewport-label">Axial</div>
        <div 
          ref={axialRef} 
          className="mpr-viewport"
          onDoubleClick={() => handleDoubleClick('axial')}
        />
      </div>
      <div className={getViewportClass('sagittal')}>
        <div className="mpr-viewport-label">Sagital</div>
        <div 
          ref={sagittalRef} 
          className="mpr-viewport"
          onDoubleClick={() => handleDoubleClick('sagittal')}
        />
      </div>
      <div className={getViewportClass('coronal')}>
        <div className="mpr-viewport-label">Coronal</div>
        <div 
          ref={coronalRef} 
          className="mpr-viewport"
          onDoubleClick={() => handleDoubleClick('coronal')}
        />
      </div>
    </>
  );

  const renderAnnotationToolbar = () => (
    <div className="mpr-annotation-toolbar">
      <button
        className={`annotation-tool-btn ${activeTool === 'WindowLevel' ? 'active' : ''}`}
        onClick={() => setActiveAnnotationTool('WindowLevel')}
        title="Window/Level"
      >
        🖱️ W/L
      </button>
      {annotationTools.map(tool => (
        <button
          key={tool.name}
          className={`annotation-tool-btn ${activeTool === tool.toolName ? 'active' : ''}`}
          onClick={() => setActiveAnnotationTool(tool.toolName)}
          title={tool.name}
        >
          {tool.label}
        </button>
      ))}
    </div>
  );

  if (embedded) {
    return (
      <div className="mpr-view-embedded">
        {error && (
          <div className="mpr-error">
            <span>⚠ {error}</span>
          </div>
        )}

        {isLoading && (
          <div className="mpr-loading">
            <div className="loading-spinner"></div>
            <p>Cargando volumen para MPR...</p>
          </div>
        )}

        {renderAnnotationToolbar()}

        <div className={`mpr-grid ${maximizedViewport ? 'single-viewport' : ''}`}>
          {renderViewports()}
        </div>

        <div className="mpr-tools-info">
          <span>🖱 Izq: {activeTool === 'WindowLevel' ? 'Window/Level' : 'Anotación'}</span>
          <span>🖱 Der: Pan</span>
          <span>🖱 Medio: Zoom</span>
          <span>🔄 Rueda: Scroll</span>
          <span>🖱 Ctrl+Izq: Crosshair</span>
          <span>🖱 Doble click: Maximizar/Restaurar</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mpr-view">
      <div className="mpr-header">
        <button className="mpr-back-btn" onClick={onBack}>
          ← Volver al visor
        </button>
        <h3>MPR - {series.seriesDescription || `Serie ${series.seriesNumber}`}</h3>
        <span className="mpr-info">{series.instances.length} imágenes</span>
      </div>

      {error && (
        <div className="mpr-error">
          <span>⚠ {error}</span>
        </div>
      )}

      {isLoading && (
        <div className="mpr-loading">
          <div className="loading-spinner"></div>
          <p>Cargando volumen para MPR...</p>
        </div>
      )}

      {renderAnnotationToolbar()}

      <div className={`mpr-grid ${maximizedViewport ? 'single-viewport' : ''}`}>
        {renderViewports()}
      </div>

      <div className="mpr-tools-info">
        <span>🖱 Izq: {activeTool === 'WindowLevel' ? 'Window/Level' : 'Anotación'}</span>
        <span>🖱 Der: Pan</span>
        <span>🖱 Medio: Zoom</span>
        <span>🔄 Rueda: Scroll</span>
        <span>🖱 Ctrl+Izq: Crosshair</span>
        <span>🖱 Doble click: Maximizar/Restaurar</span>
      </div>
    </div>
  );
};

export default MPRView;
