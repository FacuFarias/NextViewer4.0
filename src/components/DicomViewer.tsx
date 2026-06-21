import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDicomViewer } from '../hooks/useDicomViewer';
import { DicomStudy, DicomSeries, ViewerLayoutMode } from '../types/dicom';
import { dicomWebService } from '../services/dicomWeb';
import { getConfig } from '../services/config';
import { isAdmin } from '../services/auth';
import StudyBrowser from './StudyBrowser';
import SeriesPanel from './SeriesPanel';
import Filmstrip from './Filmstrip';
import Toolbar, { AnnotationToolbar } from './Toolbar';
import MPRView from './MPRView';
import ResizeHandle from './ResizeHandle';
import DownloadButton from './DownloadButton';
import DicomOverlay from './DicomOverlay';
import ReportPanel from './ReportPanel';
import { IconBack, IconSettings, IconMPR, IconStack } from './Icons';

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 500;

const DicomViewer: React.FC = () => {
  const { studyInstanceUID } = useParams<{ studyInstanceUID: string }>();
  const navigate = useNavigate();
  
  const {
    state,
    studies,
    viewportRef,
    viewportId,
    loadStudies,
    loadStudy,
    loadStudyByUID,
    loadSeries,
    setWindowLevel,
    resetView,
    invertColors,
    navigateToStudies,
    setActiveAnnotationTool,
  } = useDicomViewer();

  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [layoutMode, setLayoutMode] = useState<ViewerLayoutMode>('stack');
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(280);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(240);
  const [activeTool, setActiveTool] = useState('WindowLevel');
  const config = getConfig();
  const [showConfigLink, setShowConfigLink] = useState(false);

  useEffect(() => {
    const checkAdmin = async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      setShowConfigLink(isAdmin());
    };
    checkAdmin();
  }, [state.isLoading]);

  useEffect(() => {
    if (studyInstanceUID && !state.currentStudy) {
      loadStudyByUID(studyInstanceUID);
    } else if (!studyInstanceUID) {
      loadStudies();
    }
  }, [studyInstanceUID, state.currentStudy, loadStudyByUID, loadStudies]);

  const loadThumbnails = useCallback(async (study: DicomStudy) => {
    const thumbnailMap: Record<string, string> = {};
    
    const promises = study.series.map(async (series) => {
      try {
        const url = await dicomWebService.getSeriesThumbnailUrl(
          study.studyInstanceUID,
          series.seriesInstanceUID
        );
        if (url) {
          thumbnailMap[series.seriesInstanceUID] = url;
        }
      } catch (error) {
        console.error('Failed to load thumbnail for series:', series.seriesInstanceUID, error);
      }
    });

    await Promise.allSettled(promises);
    setThumbnails(prev => ({ ...prev, ...thumbnailMap }));
  }, []);

  useEffect(() => {
    if (state.currentStudy) {
      loadThumbnails(state.currentStudy);
    }
  }, [state.currentStudy, loadThumbnails]);

  const handleStudySelect = (study: DicomStudy) => {
    loadStudy(study);
    navigate(`/viewer/${study.studyInstanceUID}`);
    setLayoutMode('stack');
  };

  const handleSeriesSelect = (series: DicomSeries) => {
    if (state.currentStudy) {
      loadSeries(state.currentStudy.studyInstanceUID, series);
      setLayoutMode('stack');
    }
  };

  const handleWindowLevelChange = (windowWidth: number, windowCenter: number) => {
    setWindowLevel(windowWidth, windowCenter);
  };

  const handleBackToStudies = () => {
    navigateToStudies();
    navigate('/');
    setLayoutMode('stack');
  };

  const isCT = state.currentSeries?.modality === 'CT';

  const handleMPRToggle = () => {
    if (layoutMode === 'mpr') {
      setLayoutMode('stack');
    } else {
      setLayoutMode('mpr');
    }
  };

  const handleToolChange = (toolName: string) => {
    setActiveTool(toolName);
    setActiveAnnotationTool(toolName);
  };

  const handleLeftSidebarResize = useCallback((delta: number) => {
    setLeftSidebarWidth(prev => {
      const newWidth = prev + delta;
      return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth));
    });
  }, []);

  const handleRightSidebarResize = useCallback((delta: number) => {
    setRightSidebarWidth(prev => {
      const newWidth = prev + delta;
      return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth));
    });
  }, []);

  const handleResizeEnd = useCallback(() => {
    // Trigger resize event for Cornerstone to update
    window.dispatchEvent(new Event('resize'));
  }, []);

  if (state.viewMode === 'studies') {
    return (
      <div className="dicom-viewer">
        <header className="viewer-header">
          <div className="header-left">
            <h1>DICOM Viewer</h1>
            <span className="server-badge">dcm4chee</span>
          </div>
          <div className="header-right">
            {showConfigLink && (
              <button className="config-link-btn" onClick={() => navigate('/config')}>
                ⚙️ Config
              </button>
            )}
          </div>
        </header>
        <main className="study-browser-container">
          <StudyBrowser
            studies={studies}
            onStudySelect={handleStudySelect}
            isLoading={state.isLoading}
            onRefresh={() => loadStudies()}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="dicom-viewer viewer-mode">
      <header className="viewer-header compact">
        <div className="header-left">
          <button className="back-to-studies" onClick={handleBackToStudies} title="Volver a estudios">
            <IconBack className="header-icon" />
            <span>Estudios</span>
          </button>
        </div>
        
        {state.isLoaded && layoutMode !== 'mpr' && (
          <div className="header-center">
            <AnnotationToolbar
              activeTool={activeTool}
              onToolChange={handleToolChange}
              onResetView={resetView}
              onInvertColors={invertColors}
            />
          </div>
        )}

        <div className="header-right">
          {config.mprEnabled && isCT && state.isLoaded && (
            <button className="mpr-toggle-btn" onClick={handleMPRToggle} title={layoutMode === 'mpr' ? 'Modo Stack' : 'Modo MPR'}>
              {layoutMode === 'mpr' ? (
                <><IconStack className="header-icon" /> <span>Stack</span></>
              ) : (
                <><IconMPR className="header-icon" /> <span>MPR</span></>
              )}
            </button>
          )}
          {state.currentStudy && (
            <span className="patient-badge">
              {state.currentStudy.patientName || state.currentStudy.patientID}
            </span>
          )}
          {showConfigLink && (
            <button className="config-link-btn" onClick={() => navigate('/config')} title="Configuración">
              <IconSettings className="header-icon" />
            </button>
          )}
        </div>
      </header>

      <div className="viewer-content">
        <aside 
          className="series-sidebar"
          style={{ width: `${leftSidebarWidth}px` }}
        >
          {state.currentStudy && (
            <SeriesPanel
              study={state.currentStudy}
              currentSeries={state.currentSeries}
              onSeriesSelect={handleSeriesSelect}
              onBackToStudies={handleBackToStudies}
              thumbnails={thumbnails}
            />
          )}
        </aside>

        <ResizeHandle
          direction="right"
          onResize={handleLeftSidebarResize}
          onResizeEnd={handleResizeEnd}
        />

        <main className="main-viewport">
          {state.error && (
            <div className="error-message">
              <span className="error-icon">⚠</span>
              <span>{state.error}</span>
              <button className="error-dismiss" onClick={() => {}}>×</button>
            </div>
          )}

          {state.isLoading && (
            <div className="loading-overlay">
              <div className="loading-spinner"></div>
              <p>Cargando imágenes...</p>
            </div>
          )}

          {layoutMode === 'mpr' && state.currentStudy && state.currentSeries ? (
            <MPRView
              studyInstanceUID={state.currentStudy.studyInstanceUID}
              series={state.currentSeries}
              onBack={() => setLayoutMode('stack')}
              embedded={true}
            />
          ) : (
            <>
              <div className="viewport-area">
                <div className="viewport-container">
                  <div
                    ref={viewportRef}
                    id={viewportId}
                    className="dicom-viewport"
                  >
                    {!state.isLoaded && !state.isLoading && (
                      <div className="placeholder">
                        <div className="placeholder-icon">📋</div>
                        <p>Seleccione una serie para visualizar</p>
                      </div>
                    )}
                  </div>
                  
                  {state.isLoaded && state.currentStudy && (
                    <DicomOverlay
                      study={state.currentStudy}
                      instance={state.currentInstance}
                      imageIndex={state.imageIndex}
                      totalImages={state.currentSeries?.instances.length || 0}
                      windowLevel={state.windowLevel}
                    />
                  )}
                </div>

                {config.filmstripEnabled && state.isLoaded && state.currentSeries && state.currentSeries.instances.length > 0 && (
                  <Filmstrip
                    instances={state.currentSeries.instances}
                    currentIndex={state.imageIndex}
                  />
                )}
              </div>

              {state.isLoaded && state.currentInstance && (
                <div className="image-info-bar">
                  <span>Im: {state.imageIndex + 1}/{state.currentSeries?.instances.length}</span>
                  <span>|</span>
                  <span>{state.currentInstance.rows}x{state.currentInstance.columns}</span>
                  <span>|</span>
                  <span>{state.currentInstance.bitsAllocated} bits</span>
                  <span>|</span>
                  <span>W: {Math.round(state.windowLevel.windowWidth)} L: {Math.round(state.windowLevel.windowCenter)}</span>
                </div>
              )}
            </>
          )}
        </main>

        <ResizeHandle
          direction="left"
          onResize={handleRightSidebarResize}
          onResizeEnd={handleResizeEnd}
        />

        <aside 
          className="tools-sidebar"
          style={{ width: `${rightSidebarWidth}px` }}
        >
          {state.isLoaded && layoutMode !== 'mpr' && (
            <>
              <Toolbar
                windowLevel={state.windowLevel}
                onWindowLevelChange={handleWindowLevelChange}
                modality={state.currentStudy?.modality}
              />
              {config.downloadEnabled && state.currentStudy && (
                <DownloadButton
                  study={state.currentStudy}
                  currentSeries={state.currentSeries}
                />
              )}
              {state.currentStudy && (
                <ReportPanel
                  studyInstanceUID={state.currentStudy.studyInstanceUID}
                  seriesInstanceUID={state.currentSeries?.seriesInstanceUID}
                />
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
};

export default DicomViewer;
