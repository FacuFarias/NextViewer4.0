import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DicomSeries, DicomStudy } from '../types/dicom';
import type { GridLayout, HangingAssignment, HangingProtocol } from '../types/hangingProtocol';
import type { ClinicalMouseTool } from '../types/tools';
import { dicomWebService } from '../services/dicomWeb';
import { getConfig } from '../services/config';
import { selectPriorStudies } from '../services/priorStudies';
import { isClinicalImageModality, isSeriesMprCapable, resolveViewerModality } from '../services/viewerModality';
import {
  assignSeries, layoutSlotCount, listPersonalProtocols, resolvePrimaryModality, selectHangingProtocol,
} from '../services/hangingProtocols';
import { hasPersonalizationAccess } from '../services/tokenHandoff';
import { useDicomViewer } from '../hooks/useDicomViewer';
import DicomOverlay from './DicomOverlay';
import DownloadButton from './DownloadButton';
import HangingProtocolsPanel from './HangingProtocolsPanel';
import { IconMPR } from './Icons';
import MPRView from './MPRView';
import ResizeHandle from './ResizeHandle';
import SeriesPanel, { PatientInfo } from './SeriesPanel';
import Toolbar, { AnnotationToolbar } from './Toolbar';

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 500;
const MOBILE_VIEWER_QUERY = '(max-width: 900px)';

interface DicomViewerProps { studyInstanceUID: string; shareAccess: boolean }

interface LayoutSnapshot {
  layout: HangingProtocol['layout'];
  assignments: HangingAssignment[];
  activeProtocol: HangingProtocol | null;
}

function defaultHorizontalViewportRatios(layout: string): number[] {
  if (layout === '1x2') return [1, 1];
  if (layout === '1x3') return [1, 1, 1];
  return [];
}

export default function DicomViewer({ studyInstanceUID, shareAccess }: DicomViewerProps) {
  const {
    state, registerViewportElement, applyProtocolLayout, loadSeries, selectViewport,
    setWindowLevel, resetView, invertColors, mouseToolBindings, setMouseToolBinding,
    setImageIndex, undoLastAnnotation,
  } = useDicomViewer(studyInstanceUID);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [priorStudies, setPriorStudies] = useState<DicomStudy[]>([]);
  const [isLoadingPriors, setIsLoadingPriors] = useState(false);
  const [priorStudiesError, setPriorStudiesError] = useState<string | null>(null);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(280);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(240);
  const [isToolsSidebarOpen, setIsToolsSidebarOpen] = useState(false);
  const [isMobileToolsOpen, setIsMobileToolsOpen] = useState(false);
  const [isHangingPanelOpen, setIsHangingPanelOpen] = useState(false);
  const [personalProtocols, setPersonalProtocols] = useState<HangingProtocol[]>([]);
  const [protocolsReady, setProtocolsReady] = useState(false);
  const [activeProtocol, setActiveProtocol] = useState<HangingProtocol | null>(null);
  const [layoutHistory, setLayoutHistory] = useState<LayoutSnapshot[]>([]);
  const [horizontalViewportRatios, setHorizontalViewportRatios] = useState<number[]>(() => defaultHorizontalViewportRatios('1x1'));
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia(MOBILE_VIEWER_QUERY).matches);
  const appliedStudyRef = useRef('');
  const horizontalViewportGridRef = useRef<HTMLDivElement | null>(null);
  const config = getConfig();
  const canEditProtocols = !shareAccess && hasPersonalizationAccess();
  const activeViewport = useMemo(
    () => state.viewports.find(viewport => viewport.id === state.activeViewportId) || state.viewports[0],
    [state.activeViewportId, state.viewports]
  );
  const activeSeries = activeViewport?.series || null;
  const availableStudies = useMemo(
    () => state.currentStudy ? [state.currentStudy, ...priorStudies] : [],
    [priorStudies, state.currentStudy]
  );
  const activeStudy = useMemo(() => {
    const activeStudyUID = activeSeries?.studyInstanceUID || state.currentStudy?.studyInstanceUID;
    return availableStudies.find(study => study.studyInstanceUID === activeStudyUID) || state.currentStudy;
  }, [activeSeries?.studyInstanceUID, availableStudies, state.currentStudy]);
  const mprCapable = Boolean(config.mprEnabled && activeSeries && isSeriesMprCapable(activeSeries));
  const mprActive = state.layoutMode === 'mpr';
  const mprAvailable = Boolean(mprActive && mprCapable);
  const showMprToggle = Boolean(config.mprEnabled && activeSeries && (mprCapable || mprActive));
  const isHorizontalResizableLayout = !isMobileViewport && (state.layoutMode === '1x2' || state.layoutMode === '1x3');

  useEffect(() => {
    setHorizontalViewportRatios(defaultHorizontalViewportRatios(state.layoutMode));
  }, [state.layoutMode, state.currentStudy?.studyInstanceUID]);

  const handleHorizontalDividerPointerDown = useCallback((dividerIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (!isHorizontalResizableLayout || horizontalViewportRatios.length < 2) return;
    const grid = horizontalViewportGridRef.current;
    if (!grid) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const initialRatios = [...horizontalViewportRatios];
    const totalWeight = initialRatios.reduce((sum, ratio) => sum + ratio, 0) || 1;
    const dividerWidth = 10;
    const availableWidth = Math.max(1, grid.clientWidth - 6 - (initialRatios.length - 1) * dividerWidth);
    const minimumWeight = Math.min(totalWeight / initialRatios.length * 0.7, (150 / availableWidth) * totalWeight);
    const pairWeight = initialRatios[dividerIndex] + initialRatios[dividerIndex + 1];
    const startX = event.clientX;

    const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaWeight = ((moveEvent.clientX - startX) / availableWidth) * totalWeight;
      const leftWeight = clamp(initialRatios[dividerIndex] + deltaWeight, minimumWeight, pairWeight - minimumWeight);
      const nextRatios = [...initialRatios];
      nextRatios[dividerIndex] = leftWeight;
      nextRatios[dividerIndex + 1] = pairWeight - leftWeight;
      setHorizontalViewportRatios(nextRatios);
    };
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [horizontalViewportRatios, isHorizontalResizableLayout]);

  const recordLayoutSnapshot = useCallback(() => {
    if (!state.viewports.length) return;
    setLayoutHistory(previous => [...previous, {
      layout: state.layoutMode,
      assignments: state.viewports.map(viewport => ({
        slot: viewport.slot,
        label: viewport.label,
        series: viewport.series || undefined,
      })),
      activeProtocol,
    }]);
  }, [activeProtocol, state.layoutMode, state.viewports]);

  useEffect(() => {
    let cancelled = false;
    setProtocolsReady(false);
    if (!canEditProtocols) {
      setPersonalProtocols([]);
      setProtocolsReady(true);
      return () => { cancelled = true; };
    }
    void listPersonalProtocols()
      .then(protocols => { if (!cancelled) setPersonalProtocols(protocols); })
      .catch(error => {
        console.warn('No se pudieron cargar los hanging protocols personales.', error);
        if (!cancelled) setPersonalProtocols([]);
      })
      .finally(() => { if (!cancelled) setProtocolsReady(true); });
    return () => { cancelled = true; };
  }, [canEditProtocols, studyInstanceUID]);

  useEffect(() => {
    setLayoutHistory([]);
  }, [studyInstanceUID]);

  useEffect(() => {
    let cancelled = false;
    const currentStudy = state.currentStudy;
    setPriorStudies([]);
    setPriorStudiesError(null);

    if (!currentStudy || shareAccess || !currentStudy.patientID) {
      setIsLoadingPriors(false);
      return () => { cancelled = true; };
    }

    setIsLoadingPriors(true);
    void dicomWebService.searchStudies({ PatientID: currentStudy.patientID, limit: '100' })
      .then(candidates => Promise.allSettled(
        selectPriorStudies(currentStudy, candidates).map(async priorStudy => {
          const allSeries = await dicomWebService.getStudySeries(priorStudy.studyInstanceUID);
          const series = allSeries.filter(entry => isClinicalImageModality(entry.modality));
          return { ...priorStudy, series };
        })
      ))
      .then(results => {
        if (cancelled) return;
        const studies = results
          .filter((result): result is PromiseFulfilledResult<DicomStudy> => result.status === 'fulfilled')
          .map(result => result.value)
          .filter(priorStudy => priorStudy.series.length > 0);
        setPriorStudies(studies);
        if (results.some(result => result.status === 'rejected')) {
          setPriorStudiesError('Algunos estudios previos no pudieron cargarse.');
        }
      })
      .catch(error => {
        console.warn('No se pudieron consultar los estudios previos del paciente.', error);
        if (!cancelled) setPriorStudiesError('No se pudieron consultar los estudios previos.');
      })
      .finally(() => { if (!cancelled) setIsLoadingPriors(false); });

    return () => { cancelled = true; };
  }, [shareAccess, state.currentStudy]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_VIEWER_QUERY);
    const updateMobileViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateMobileViewport();
    mediaQuery.addEventListener('change', updateMobileViewport);
    return () => mediaQuery.removeEventListener('change', updateMobileViewport);
  }, []);

  useEffect(() => {
    if (!isToolsSidebarOpen && !isMobileToolsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsToolsSidebarOpen(false);
        setIsMobileToolsOpen(false);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isMobileToolsOpen, isToolsSidebarOpen]);

  const applyProtocol = useCallback((protocol: HangingProtocol, allowMpr = false) => {
    if (!state.currentStudy) return;
    // MPR is an explicit viewer action. An old active personal protocol may
    // still contain layout=mpr, so never let automatic study initialization
    // open that layout.
    const effectiveProtocol = !allowMpr && protocol.layout === 'mpr'
      ? { ...protocol, layout: '1x1' as const }
      : protocol;
    setActiveProtocol(effectiveProtocol);
    applyProtocolLayout(effectiveProtocol.layout, assignSeries(effectiveProtocol, state.currentStudy.series));
  }, [applyProtocolLayout, state.currentStudy]);

  useEffect(() => {
    if (!state.currentStudy || !protocolsReady) return;
    const signature = `${state.currentStudy.studyInstanceUID}:${personalProtocols
      .filter(protocol => protocol.isActive).map(protocol => protocol.id).sort().join(',')}`;
    if (appliedStudyRef.current === signature) return;
    appliedStudyRef.current = signature;
    applyProtocol(selectHangingProtocol(state.currentStudy, personalProtocols));
  }, [applyProtocol, personalProtocols, protocolsReady, state.currentStudy]);

  useEffect(() => {
    const objectUrls: string[] = [];
    let cancelled = false;
    const loadThumbnails = async (studies: DicomStudy[]) => {
      const entries = await Promise.all(studies.flatMap(study => study.series.map(async series => {
        const url = await dicomWebService.getSeriesThumbnailUrl(
          series.studyInstanceUID || study.studyInstanceUID,
          series.seriesInstanceUID
        );
        if (url) objectUrls.push(url);
        return [series.seriesInstanceUID, url] as const;
      })));
      if (!cancelled) setThumbnails(Object.fromEntries(entries.filter(([, url]) => Boolean(url))) as Record<string, string>);
    };
    if (availableStudies.length) void loadThumbnails(availableStudies);
    return () => { cancelled = true; objectUrls.forEach(url => URL.revokeObjectURL(url)); };
  }, [availableStudies]);

  const handleSeriesSelect = useCallback((series: DicomSeries) => {
    if (!state.currentStudy) return;
    void loadSeries(series.studyInstanceUID || state.currentStudy.studyInstanceUID, series, state.activeViewportId);
  }, [loadSeries, state.activeViewportId, state.currentStudy]);
  const toggleMpr = useCallback(() => {
    if (!activeSeries || !config.mprEnabled || (!mprActive && !mprCapable)) return;
    recordLayoutSnapshot();
    applyProtocolLayout(mprActive ? '1x1' : 'mpr', [{
      slot: 0,
      label: 'Serie principal',
      series: activeSeries,
    }]);
  }, [activeSeries, applyProtocolLayout, config.mprEnabled, mprActive, mprCapable, recordLayoutSnapshot]);
  const handleToolChange = useCallback((toolName: ClinicalMouseTool) => {
    setMouseToolBinding('primary', toolName);
  }, [setMouseToolBinding]);
  const resizeLeft = useCallback((delta: number) => setLeftSidebarWidth(previous => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, previous + delta))), []);
  const resizeRight = useCallback((delta: number) => setRightSidebarWidth(previous => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, previous + delta))), []);
  const finishResize = useCallback(() => window.dispatchEvent(new Event('resize')), []);

  const handleProtocolApply = useCallback((protocol: HangingProtocol) => {
    if (!state.currentStudy || protocol.modality !== resolvePrimaryModality(state.currentStudy)) return;
    recordLayoutSnapshot();
    applyProtocol(protocol, true);
  }, [applyProtocol, recordLayoutSnapshot, state.currentStudy]);

  const handleLayoutChange = useCallback((layout: GridLayout) => {
    if (!state.currentStudy || state.layoutMode === layout) return;

    const visibleSeries = state.viewports
      .map(viewport => viewport.series)
      .filter((series): series is DicomSeries => Boolean(series));
    const visibleSeriesIds = new Set(visibleSeries.map(series => series.seriesInstanceUID));
    const remainingSeries = state.currentStudy.series.filter(
      series => !visibleSeriesIds.has(series.seriesInstanceUID)
    );
    const seriesForLayout = [...visibleSeries, ...remainingSeries].slice(0, layoutSlotCount(layout));
    const assignments = Array.from({ length: layoutSlotCount(layout) }, (_, slot) => ({
      slot,
      label: `Viewport ${slot + 1}`,
      series: seriesForLayout[slot],
    }));

    recordLayoutSnapshot();
    setActiveProtocol(null);
    applyProtocolLayout(layout, assignments);
  }, [applyProtocolLayout, recordLayoutSnapshot, state.currentStudy, state.layoutMode, state.viewports]);

  const handleUndoLayout = useCallback(() => {
    if (!state.currentStudy || !layoutHistory.length) return;
    const snapshot = layoutHistory[layoutHistory.length - 1];
    setLayoutHistory(previous => previous.slice(0, -1));
    setActiveProtocol(snapshot.activeProtocol);
    applyProtocolLayout(snapshot.layout, snapshot.assignments);
  }, [applyProtocolLayout, layoutHistory, state.currentStudy]);

  const handleUndo = useCallback(() => {
    if (!undoLastAnnotation()) handleUndoLayout();
  }, [handleUndoLayout, undoLastAnnotation]);

  useEffect(() => {
    const undoOnShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (isEditing || event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handleUndo();
    };
    window.addEventListener('keydown', undoOnShortcut, true);
    return () => window.removeEventListener('keydown', undoOnShortcut, true);
  }, [handleUndo]);

  const renderStackViewport = (viewport: typeof activeViewport, flexRatio?: number) => {
    if (!viewport) return null;
    const modality = resolveViewerModality(viewport.series?.modality, state.currentStudy?.modality, viewport.instance?.modality);
    const viewportStudyUID = viewport.series?.studyInstanceUID || state.currentStudy?.studyInstanceUID;
    const viewportStudy = availableStudies.find(study => study.studyInstanceUID === viewportStudyUID) || state.currentStudy;
    return (
      <section
        key={viewport.id}
        className={`clinical-stack-panel viewer-modality-${modality} ${state.activeViewportId === viewport.id ? 'active' : ''}`}
        style={flexRatio === undefined ? undefined : { flex: `${flexRatio} 1 0%` }}
        onMouseDown={() => selectViewport(viewport.id)}
        onContextMenu={event => event.preventDefault()}
      >
        <div className="viewport-area">
          <div className="viewport-container">
            <div ref={element => registerViewportElement(viewport.id, element)} id={viewport.id} className="dicom-viewport">
              {!viewport.series && !state.isLoading && <div className="placeholder"><p>Sin serie coincidente</p></div>}
            </div>
            {viewport.label && <span className="clinical-viewport-label">{viewport.label}</span>}
            {viewport.isLoaded && viewportStudy && (
              <DicomOverlay study={viewportStudy} instance={viewport.instance} imageIndex={viewport.imageIndex} totalImages={viewport.series?.instances.length || 0} windowLevel={viewport.windowLevel} />
            )}
          </div>
          {viewport.isLoaded && (viewport.series?.instances.length || 0) > 1 && (
            <div className="mobile-instance-navigator" aria-label="Navegación vertical de instancias">
              <span className="mobile-instance-counter">{viewport.imageIndex + 1}/{viewport.series?.instances.length}</span>
              <input
                type="range"
                min="0"
                max={(viewport.series?.instances.length || 1) - 1}
                value={viewport.imageIndex}
                onChange={event => setImageIndex(Number(event.currentTarget.value), viewport.id)}
                aria-label="Instancia activa"
                aria-orientation="vertical"
                aria-valuetext={`Instancia ${viewport.imageIndex + 1} de ${viewport.series?.instances.length}`}
              />
            </div>
          )}
        </div>
        {viewport.isLoaded && viewport.instance && (
          <div className="image-info-bar">
            <span>Im: {viewport.imageIndex + 1}/{viewport.series?.instances.length}</span><span>|</span>
            <span>{viewport.instance.rows}×{viewport.instance.columns}</span><span>|</span><span>{viewport.instance.bitsAllocated} bits</span>
            {(viewport.instance.numberOfFrames || 1) > 1 && <><span>|</span><span>Frame {viewport.instance.frameNumber}/{viewport.instance.numberOfFrames}</span></>}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="dicom-viewer viewer-mode">
      <header
        className={`viewer-header compact ${state.layoutMode === '1x2' ? 'layout-1x2' : ''}`}
        style={{ '--viewer-sidebar-width': `${leftSidebarWidth}px` } as React.CSSProperties}
      >
        <div className="header-left"><span className="viewer-brand">NextViewer</span></div>
        {state.isLoaded && <div className="header-center">
          <AnnotationToolbar
            activeTool={mouseToolBindings.primary}
            onToolChange={handleToolChange}
            mouseToolBindings={mouseToolBindings}
            onMouseToolChange={setMouseToolBinding}
            onUndo={handleUndo}
            onResetView={resetView}
            onInvertColors={invertColors}
            layout={state.layoutMode}
            onLayoutChange={handleLayoutChange}
            toolsSidebarOpen={isToolsSidebarOpen}
            onToolsToggle={() => setIsToolsSidebarOpen(previous => !previous)}
          />
        </div>}
        <div className="header-right">
          {state.isLoaded && showMprToggle && <button
            type="button"
            className={`mpr-toggle-btn ${mprActive ? 'active' : ''}`}
            onClick={toggleMpr}
            aria-pressed={mprActive}
            title={mprActive ? 'Cerrar reconstrucciones MPR' : 'Activar reconstrucciones MPR'}
          >
            <IconMPR className="mpr-toggle-icon" />
            <span className="desktop-only">{mprActive ? 'Cerrar MPR' : 'Activar MPR'}</span>
            <span className="mobile-only" aria-hidden="true">MPR</span>
          </button>}
          {state.currentStudy && <span
            className="patient-badge"
            role={isMobileViewport ? 'button' : undefined}
            tabIndex={isMobileViewport ? 0 : undefined}
            aria-controls={isMobileViewport ? 'clinical-tools-sidebar' : undefined}
            aria-expanded={isMobileViewport ? isToolsSidebarOpen : undefined}
            onClick={() => {
              if (isMobileViewport) setIsToolsSidebarOpen(previous => !previous);
            }}
            onKeyDown={event => {
              if (isMobileViewport && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                setIsToolsSidebarOpen(previous => !previous);
              }
            }}
          >{state.currentStudy.patientName || state.currentStudy.patientID}</span>}
        </div>
      </header>

      <div className="viewer-content">
        <aside className="series-sidebar" style={{ width: leftSidebarWidth }}>
          {state.currentStudy && <SeriesPanel
            study={state.currentStudy}
            priorStudies={priorStudies}
            currentSeries={activeViewport?.series || null}
            onSeriesSelect={handleSeriesSelect}
            thumbnails={thumbnails}
            isLoadingPriors={isLoadingPriors}
            priorStudiesError={priorStudiesError}
          />}
        </aside>
        <ResizeHandle direction="right" onResize={resizeLeft} onResizeEnd={finishResize} />
        <main className="main-viewport">
          {state.error && <div className="error-message" role="alert"><span className="error-icon">⚠</span><span>{state.error}</span></div>}
          {state.isLoading && <div className="loading-overlay"><div className="loading-spinner" /><p>Cargando imágenes clínicas…</p></div>}
          {state.layoutMode === 'mpr' && activeViewport ? (
            <div className={`clinical-viewport-grid layout-mpr ${mprAvailable ? 'mpr-composite-layout' : ''}`}>
              {renderStackViewport(activeViewport)}
              {!isMobileViewport && config.mprEnabled && mprAvailable && state.currentStudy && activeViewport.series && (
                <section className="mpr-reconstruction-panel">
                  <div className="mpr-reconstruction-header"><span className="mpr-reconstruction-badge">Reconstrucciones MPR</span><span>CT/MR con geometría válida</span></div>
                  <MPRView studyInstanceUID={activeViewport.series.studyInstanceUID || state.currentStudy.studyInstanceUID} series={activeViewport.series} onBack={() => undefined} embedded />
                </section>
              )}
            </div>
          ) : <div
            ref={horizontalViewportGridRef}
            className={`clinical-viewport-grid layout-${state.layoutMode}${isHorizontalResizableLayout ? ' clinical-horizontal-resizable' : ''}`}
          >
            {isHorizontalResizableLayout
              ? state.viewports.map((viewport, index) => (
                <React.Fragment key={viewport.id}>
                  {renderStackViewport(viewport, horizontalViewportRatios[index] || 1)}
                  {index < state.viewports.length - 1 && (
                    <div
                      className="viewport-divider"
                      role="separator"
                      tabIndex={0}
                      aria-label={`Redimensionar entre viewport ${index + 1} y ${index + 2}`}
                      onPointerDown={event => handleHorizontalDividerPointerDown(index, event)}
                    />
                  )}
                </React.Fragment>
              ))
              : state.viewports.map(viewport => renderStackViewport(viewport))}
          </div>}
        </main>
        {isToolsSidebarOpen && <ResizeHandle direction="left" onResize={resizeRight} onResizeEnd={finishResize} />}
          {isToolsSidebarOpen && <button type="button" className="mobile-drawer-backdrop" onClick={() => setIsToolsSidebarOpen(false)} aria-label="Cerrar información y herramientas" />}
          <aside
            id="clinical-tools-sidebar"
            className={`tools-sidebar tools-sidebar-animated ${isToolsSidebarOpen ? 'open' : 'closed'}`}
            style={{ width: isToolsSidebarOpen ? rightSidebarWidth : 0 }}
            aria-hidden={!isToolsSidebarOpen}
            aria-label="Información y herramientas secundarias"
            onTransitionEnd={finishResize}
          >
            <div className="mobile-drawer-header"><strong>Información y herramientas</strong><button type="button" onClick={() => setIsToolsSidebarOpen(false)} aria-label="Cerrar">×</button></div>
            {state.currentStudy && <section className="mobile-secondary-content"><h4>Datos del paciente</h4><PatientInfo study={state.currentStudy} className="mobile-patient-info" includeClinicalDetails /></section>}
            {activeViewport?.instance && <section className="mobile-secondary-content mobile-image-details"><h4>Imagen activa</h4><div className="mobile-technical-info"><div><span>Tamaño:</span><strong>{activeViewport.instance.rows}×{activeViewport.instance.columns}</strong></div><div><span>Bits:</span><strong>{activeViewport.instance.bitsAllocated}</strong></div>{activeViewport.instance.photometricInterpretation && <div><span>Fotometría:</span><strong>{activeViewport.instance.photometricInterpretation}</strong></div>}</div></section>}
            {!shareAccess && <section className="hanging-tools-section"><h4>Presentación</h4><button type="button" className="hanging-open-btn" onClick={() => { setIsToolsSidebarOpen(false); setIsHangingPanelOpen(true); }}>Hanging protocols<small>{activeProtocol ? `${activeProtocol.modality} · ${activeProtocol.layout.toUpperCase()}` : `Manual · ${state.layoutMode.toUpperCase()}`}</small></button></section>}
            {state.isLoaded && <><Toolbar windowLevel={state.windowLevel} onWindowLevelChange={setWindowLevel} modality={activeViewport?.series?.modality} />{config.downloadEnabled && activeStudy && <DownloadButton study={activeStudy} currentSeries={activeViewport?.series || null} />}</>}
          </aside>
      </div>

      {state.isLoaded && isMobileToolsOpen && <div id="mobile-tools-menu" className="mobile-tools-menu">
        <AnnotationToolbar
          mobile
          activeTool={mouseToolBindings.primary}
          onToolChange={toolName => {
            handleToolChange(toolName);
            setIsMobileToolsOpen(false);
          }}
          onResetView={() => {
            resetView();
            setIsMobileToolsOpen(false);
          }}
          onInvertColors={() => {
            invertColors();
            setIsMobileToolsOpen(false);
          }}
          onUndo={() => {
            handleUndo();
            setIsMobileToolsOpen(false);
          }}
          layout={state.layoutMode}
          onLayoutChange={layout => {
            handleLayoutChange(layout);
            setIsMobileToolsOpen(false);
          }}
          toolsSidebarOpen={isToolsSidebarOpen}
          onToolsToggle={() => {
            setIsToolsSidebarOpen(previous => !previous);
            setIsMobileToolsOpen(false);
          }}
        />
      </div>}
      {state.isLoaded && <div className="mobile-toolbar-shell">
        <button
          type="button"
          className="mobile-toolbar-brand"
          onClick={() => setIsMobileToolsOpen(previous => !previous)}
          aria-controls="mobile-tools-menu"
          aria-expanded={isMobileToolsOpen}
          aria-label="Abrir herramientas de medición"
        >NextViewer</button>
      </div>}

      {!shareAccess && <HangingProtocolsPanel open={isHangingPanelOpen} canEdit={canEditProtocols} personalProtocols={personalProtocols} onClose={() => setIsHangingPanelOpen(false)} onProtocolsChanged={protocols => { appliedStudyRef.current = ''; setPersonalProtocols(protocols); }} onApply={handleProtocolApply} />}
    </div>
  );
}
