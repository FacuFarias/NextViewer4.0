import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getEnabledElement } from '@cornerstonejs/core';
import { cornerstoneTools } from '../services/cornerstone';
import { useDicomViewer } from '../hooks/useDicomViewer';
import type { ViewerMeasurement } from '../hooks/useDicomViewer';
import { DicomStudy, DicomSeries } from '../types/dicom';
import { dicomWebService } from '../services/dicomWeb';
import { getConfig } from '../services/config';
import { getCurrentUser, isAdmin, logout } from '../services/auth';
import StudyBrowser from './StudyBrowser';
import SeriesPanel from './SeriesPanel';
import Toolbar, { AnnotationToolbar } from './Toolbar';
import MPRView from './MPRView';
import ResizeHandle from './ResizeHandle';
import DownloadButton from './DownloadButton';
import DicomOverlay from './DicomOverlay';
import ReportPanel from './ReportPanel';
import CtSinusesFeaturePanel from './CtSinusesFeaturePanel';
import LinesPanel from './LinesPanel';
import MeasurementsPanel from './MeasurementsPanel';
import ConfirmDialog from './ConfirmDialog';
import { IconBack, IconSettings } from './Icons';
import { getMeasurementLabel, localizeError, useTranslation } from '../i18n';
import {
  NASAL_SEPTUM_DEVIATION_COLOR,
  NASAL_SEPTUM_DEVIATION_CODE,
  NASAL_SEPTUM_DEVIATION_TOOL_NAME,
} from '../services/nasalSeptumDeviation';
import { resolveViewerModality, viewerUsesMpr } from '../services/viewerModality';

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 500;

interface NativeNasalMeasurementOverlayProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  measurements: ViewerMeasurement[];
  currentSeriesUID?: string;
  currentSopInstanceUID?: string;
  isLoaded: boolean;
}

const NativeNasalMeasurementOverlay: React.FC<NativeNasalMeasurementOverlayProps> = ({
  viewportRef,
  measurements,
  currentSeriesUID,
  currentSopInstanceUID,
  isLoaded,
}) => {
  const { t } = useTranslation();
  if (!isLoaded || !currentSeriesUID || !currentSopInstanceUID || !viewportRef.current) {
    return null;
  }

  let viewport: any;
  try {
    viewport = getEnabledElement(viewportRef.current).viewport;
  } catch {
    return null;
  }

  const canvas = viewport.getCanvas?.();
  const width = canvas?.width || viewportRef.current.clientWidth;
  const height = canvas?.height || viewportRef.current.clientHeight;
  if (!width || !height) return null;

  const currentImageId = viewport.getCurrentImageId?.();
  const annotations = cornerstoneTools.annotation.state.getAllAnnotations();
  const toNumberArray = (point: any): number[] => {
    if (Array.isArray(point)) return point.map(Number);
    if (ArrayBuffer.isView(point)) return Array.from(point as unknown as ArrayLike<number>).map(Number);
    return [];
  };
  const currentMeasurements = measurements.filter(measurement =>
    measurement.measurementType === NASAL_SEPTUM_DEVIATION_CODE &&
    measurement.seriesInstanceUID === currentSeriesUID &&
    measurement.sopInstanceUID === currentSopInstanceUID
  );

  const lineGroups = currentMeasurements.map(measurement => {
    const annotation = annotations.find(item => item.annotationUID === measurement.annotationUID) as any;
    let worldPoints: number[][] = [];
    const annotationPoints = annotation?.data?.handles?.points;
    const annotationImageId = annotation?.metadata?.referencedImageId;
    const annotationIsForCurrentImage = !annotationImageId || !currentImageId || annotationImageId === currentImageId;
    if (annotationIsForCurrentImage && Array.isArray(annotationPoints) && annotationPoints.length >= 4) {
      worldPoints = annotationPoints.slice(0, 4);
    } else if (measurement.pixelPoints && measurement.pixelPoints.length >= 4) {
      const imageData = viewport.getImageData?.()?.imageData || viewport.getImageData?.();
        const indexToWorld = imageData?.indexToWorld;
        if (typeof indexToWorld === 'function') {
        worldPoints = measurement.pixelPoints.slice(0, 4)
          .map(point => indexToWorld([point.x, point.y, 0]))
          .map(toNumberArray)
          .filter(point => point.length >= 3 && point.slice(0, 3).every(Number.isFinite));
        }
    }

    const canvasPoints = worldPoints
      .map(point => toNumberArray(viewport.worldToCanvas(point)))
      .filter(point => point.length >= 2 && point.slice(0, 2).every(Number.isFinite));
    if (canvasPoints.length < 4) return null;

    return {
      measurement,
      points: canvasPoints,
    };
  }).filter((group): group is { measurement: ViewerMeasurement; points: number[][] } => group !== null);

  if (!lineGroups.length) return null;

  return (
    <svg
      className="native-measurement-overlay"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {lineGroups.map(({ measurement, points }) => {
        const color = measurement.color || NASAL_SEPTUM_DEVIATION_COLOR;
        const axisLength = measurement.axisLengthMm;
        const deviationLength = measurement.deviationLengthMm;
        const labelPoint = [
          (points[0][0] + points[1][0]) / 2 + 12,
          (points[0][1] + points[1][1]) / 2,
        ];
        return (
          <g key={measurement.annotationUID}>
            <line
              x1={points[0][0]}
              y1={points[0][1]}
              x2={points[1][0]}
              y2={points[1][1]}
              stroke={color}
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={points[2][0]}
              y1={points[2][1]}
              x2={points[3][0]}
              y2={points[3][1]}
              stroke={color}
              strokeWidth="3"
              strokeDasharray="8 4"
              vectorEffect="non-scaling-stroke"
            />
            {points.map((point, index) => (
              <circle
                key={`${measurement.annotationUID}-handle-${index}`}
                cx={point[0]}
                cy={point[1]}
                r="5"
                fill={color}
                stroke="#fff"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {Number.isFinite(axisLength) && Number.isFinite(deviationLength) && (
              <text
                x={labelPoint[0]}
                y={labelPoint[1]}
                fill={color}
                fontSize="14"
                fontFamily="monospace"
                paintOrder="stroke"
                stroke="#000"
                strokeWidth="4"
                strokeOpacity="0.8"
              >
                {`${t('measurement.axis')}: ${axisLength!.toFixed(1)} mm · ${t('measurement.deviation')}: ${deviationLength!.toFixed(1)} mm`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

const DicomViewer: React.FC = () => {
  const { t } = useTranslation();
  const { studyInstanceUID } = useParams<{ studyInstanceUID: string }>();
  const navigate = useNavigate();
  
  const {
    state,
    studies,
    viewportRef,
    viewportId,
    loadStudies,
    loadStudyByUID,
    loadSeries,
    setWindowLevel,
    resetView,
    invertColors,
    setActiveAnnotationTool,
    setActiveCtSinusesFeature,
    preloadProgress,
    preloadQueue,
    toggleStudyPreload,
    enqueueStudiesPreload,
    clearPreloadQueue,
    selectMeasurement,
    measurements,
    removeMeasurement,
    saveMeasurement,
    retryMeasurement,
    setImageIndex,
    hasPendingAnnotationChanges,
  } = useDicomViewer();

  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(280);
  const [isSeriesSidebarOpen, setIsSeriesSidebarOpen] = useState(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(340);
  const [activeTool, setActiveTool] = useState('WindowLevel');
  const [selectedCtSinusesFeatureKey, setSelectedCtSinusesFeatureKey] = useState<string | null>(null);
  const [voxelSegmentationDirty, setVoxelSegmentationDirty] = useState(false);

  useEffect(() => {
    setVoxelSegmentationDirty(false);
  }, [state.currentSeries?.seriesInstanceUID]);
  const [nasalSeptumDeviationActive, setNasalSeptumDeviationActive] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const config = getConfig();
  const [showConfigLink, setShowConfigLink] = useState(false);
  const username = getCurrentUser();

  useEffect(() => {
    const checkAdmin = async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      setShowConfigLink(isAdmin());
    };
    checkAdmin();
  }, [state.isLoading]);

  useEffect(() => {
    if (
      studyInstanceUID &&
      state.currentStudy?.studyInstanceUID !== studyInstanceUID
    ) {
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
    const selectStudy = () => {
      setSelectedCtSinusesFeatureKey(null);
      setNasalSeptumDeviationActive(false);
      setActiveCtSinusesFeature(null);
      navigate(`/viewer/${study.studyInstanceUID}`);
    };
    if (hasPendingAnnotationChanges) {
      setConfirmRequest({
        title: t('viewer.pendingChanges'),
        message: t('viewer.pendingStudy'),
        confirmLabel: t('viewer.changeStudy'),
        onConfirm: selectStudy,
      });
      return;
    }
    selectStudy();
  };

  const handleSeriesSelect = (series: DicomSeries) => {
    const selectSeries = () => {
      if (state.currentStudy) {
        setSelectedCtSinusesFeatureKey(null);
        setNasalSeptumDeviationActive(false);
        setActiveCtSinusesFeature(null);
        loadSeries(state.currentStudy.studyInstanceUID, series);
      }
    };
    if (hasPendingAnnotationChanges) {
      setConfirmRequest({
        title: t('viewer.pendingChanges'),
        message: t('viewer.pendingSeries'),
        confirmLabel: t('viewer.changeSeries'),
        onConfirm: selectSeries,
      });
      return;
    }
    selectSeries();
  };

  const handleWindowLevelChange = (windowWidth: number, windowCenter: number) => {
    setWindowLevel(windowWidth, windowCenter);
  };

  const handleBackToStudies = () => {
    const leaveViewer = () => {
      setSelectedCtSinusesFeatureKey(null);
      setNasalSeptumDeviationActive(false);
      setActiveCtSinusesFeature(null);
      navigate('/', { replace: true });
    };
    if (hasPendingAnnotationChanges) {
      setConfirmRequest({
        title: t('viewer.pendingChanges'),
        message: t('viewer.pendingExit'),
        confirmLabel: t('viewer.exitWithoutSaving'),
        danger: true,
        onConfirm: leaveViewer,
      });
      return;
    }
    leaveViewer();
  };

  const viewerModality = resolveViewerModality(
    state.currentSeries?.modality,
    state.currentStudy?.modality,
    state.currentSeries?.instances[0]?.modality
  );
  const isCT = viewerUsesMpr(viewerModality);

  useEffect(() => {
    if (!state.isLoaded || !viewportRef.current) return;

    // Adding the CT reconstruction panel changes the native viewport width.
    // Resize after React commits that layout so Cornerstone keeps the existing
    // Stack element and recreates its framebuffer at the correct dimensions.
    const frame = window.requestAnimationFrame(() => {
      if (!viewportRef.current) return;
      try {
        const enabledElement = getEnabledElement(viewportRef.current);
        enabledElement.renderingEngine.resize(true, true);
        enabledElement.viewport.render();
      } catch (error) {
        console.error('Failed to resize native viewport after layout change:', error);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isCT, state.isLoaded, state.currentSeries?.seriesInstanceUID, viewportRef]);

  const handleToolChange = (toolName: string) => {
    setSelectedCtSinusesFeatureKey(null);
    setNasalSeptumDeviationActive(false);
    setActiveCtSinusesFeature(null);
    setActiveTool(toolName);
    // Toolbar tools always target the native Stack viewport.  MPR panes are
    // intentionally read-only reconstructions.
    setActiveAnnotationTool(toolName);
  };

  const handleCtSinusesFeatureSelect = (feature: Parameters<typeof setActiveCtSinusesFeature>[0]) => {
    setNasalSeptumDeviationActive(false);
    setSelectedCtSinusesFeatureKey(feature.key);
    setActiveCtSinusesFeature(feature);
  };

  const handleNasalSeptumDeviationSelect = () => {
    setSelectedCtSinusesFeatureKey(null);
    setActiveCtSinusesFeature(null);
    setNasalSeptumDeviationActive(true);
    setActiveTool(NASAL_SEPTUM_DEVIATION_TOOL_NAME);
    setActiveAnnotationTool(NASAL_SEPTUM_DEVIATION_TOOL_NAME);
  };

  const handleNativeSliceChange = useCallback((imageIndex: number) => {
    void setImageIndex(imageIndex);
  }, [setImageIndex]);

  const handleMeasurementSelect = useCallback(async (measurement: ViewerMeasurement) => {
    // MPR keeps the native Stack mounted beside the reconstructions. Selection
    // must navigate that native viewport without changing layout; only the
    // native DICOM viewport owns/restores annotations.
    await selectMeasurement(measurement);
  }, [selectMeasurement]);

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
            <h1>{t('viewer.title')}</h1>
            <span className="server-badge">dcm4chee</span>
          </div>
          <div className="header-right">
            {username && <span className="session-user-badge">{username}</span>}
            {showConfigLink && (
              <button className="config-link-btn" onClick={() => navigate('/reference-storage')}>
                {t('viewer.referenceStorage')}
              </button>
            )}
            {showConfigLink && (
              <button className="config-link-btn" onClick={() => navigate('/config')}>
                {t('viewer.config')}
              </button>
            )}
            <button className="logout-btn" onClick={() => void logout()}>
              {t('viewer.logout')}
            </button>
          </div>
        </header>
        <main className="study-browser-container">
          <StudyBrowser
            studies={studies}
            onStudySelect={handleStudySelect}
            isLoading={state.isLoading}
            onRefresh={() => loadStudies()}
            preloadQueue={preloadQueue}
            onToggleStudyPreload={toggleStudyPreload}
            onPreloadStudies={enqueueStudiesPreload}
            onClearPreloadQueue={clearPreloadQueue}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="dicom-viewer viewer-mode">
      <header className="viewer-header compact">
        <div className="header-left">
          <button className="back-to-studies" onClick={handleBackToStudies} title={t('viewer.backToStudies')}>
            <IconBack className="header-icon" />
            <span>{t('viewer.title')}</span>
          </button>
          <button
            className={`series-sidebar-toggle ${isSeriesSidebarOpen ? 'active' : ''}`}
            onClick={() => setIsSeriesSidebarOpen(previous => !previous)}
            title={isSeriesSidebarOpen ? 'Ocultar series' : 'Mostrar series'}
            aria-expanded={isSeriesSidebarOpen}
          >
            <span>Series</span>
          </button>
        </div>
        
        {state.isLoaded && (
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
          {state.currentStudy && (
            <span className="patient-badge">
              {state.currentStudy.patientName || state.currentStudy.patientID}
            </span>
          )}
          {showConfigLink && (
            <button className="config-link-btn" onClick={() => navigate('/reference-storage')} title={t('viewer.referenceStorage')}>
              S3
            </button>
          )}
          {showConfigLink && (
            <button className="config-link-btn" onClick={() => navigate('/config')} title={t('config.title')}>
              <IconSettings className="header-icon" />
            </button>
          )}
          <button className="logout-btn compact" onClick={() => void logout()} title={t('viewer.logout')}>
            {t('viewer.logout')}
          </button>
        </div>
      </header>

      <div className="viewer-content">
        <aside 
          className={`series-sidebar ${isSeriesSidebarOpen ? 'is-open' : 'is-collapsed'}`}
          style={{ width: isSeriesSidebarOpen ? `${leftSidebarWidth}px` : '0px' }}
          aria-hidden={!isSeriesSidebarOpen}
        >
          {state.currentStudy && (
            <SeriesPanel
              study={state.currentStudy}
              currentSeries={state.currentSeries}
              onSeriesSelect={handleSeriesSelect}
              thumbnails={thumbnails}
              preloadProgress={preloadProgress}
              preloadQueue={preloadQueue}
            />
          )}
        </aside>

        {isSeriesSidebarOpen && (
          <ResizeHandle
            direction="right"
            onResize={handleLeftSidebarResize}
            onResizeEnd={handleResizeEnd}
          />
        )}

        <main className="main-viewport">
          {state.error && (
            <div className="error-message">
              <span className="error-icon">⚠</span>
              <span>{localizeError(t, state.error, 'errors.generic')}</span>
              <button className="error-dismiss" onClick={() => {}}>×</button>
            </div>
          )}

          {state.isLoading && (
            <div className="loading-overlay">
              <div className="loading-spinner"></div>
              <p>{t('viewer.loadingImages')}</p>
            </div>
          )}

          <div
            className={`${isCT ? 'mpr-composite-layout recon-only' : 'stack-viewer-layout'} viewer-modality-${viewerModality}`}
          >
            <section className="mpr-native-panel">
              <div className={`mpr-native-header${isCT ? '' : ' mpr-native-header-hidden'}`}>
                <span className="mpr-native-badge">{t('viewer.nativeDicom')}</span>
                <span>{t('viewer.editableViewport')}</span>
              </div>
              <div className="viewport-area">
                <div className="viewport-container">
                  <div
                    ref={viewportRef}
                    id={viewportId}
                    className="dicom-viewport"
                  >
                    {!state.isLoaded && !state.isLoading && (
                      <div className="placeholder">
                        <div className="placeholder-icon" aria-hidden="true"></div>
                        <p>{t('viewer.selectSeries')}</p>
                      </div>
                    )}
                  </div>
                  
                  {state.currentStudy && (
                    <DicomOverlay
                      study={state.currentStudy}
                      instance={state.currentInstance}
                      imageIndex={state.imageIndex}
                      totalImages={state.currentSeries?.instances.length || 0}
                      windowLevel={state.windowLevel}
                    />
                  )}
                  <NativeNasalMeasurementOverlay
                    viewportRef={viewportRef}
                    measurements={measurements}
                    currentSeriesUID={state.currentSeries?.seriesInstanceUID}
                    currentSopInstanceUID={state.currentInstance?.sopInstanceUID}
                    isLoaded={state.isLoaded}
                  />
                </div>
              </div>
              {state.currentInstance && (
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
            </section>
            {isCT && (
              <section className="mpr-reconstruction-panel">
                <div className="mpr-reconstruction-header">
                  <span className="mpr-reconstruction-badge">{t('viewer.mprReconstructions')}</span>
                  <span>{voxelSegmentationDirty ? '● Segmentación sin guardar' : t('viewer.spatialOnly')}</span>
                </div>
                {state.currentStudy && state.currentSeries && state.isLoaded ? (
                  <MPRView
                    studyInstanceUID={state.currentStudy.studyInstanceUID}
                    series={state.currentSeries}
                    patientName={state.currentStudy.patientName}
                    patientID={state.currentStudy.patientID}
                    nativeImageIndex={state.imageIndex}
                    onNativeSliceChange={handleNativeSliceChange}
                    onBack={() => {}}
                    embedded={true}
                    voxelSegmentationEnabled={config.ctSinusesMinicatMeasurementsEnabled && isCT}
                    activeCtSinusesFeatureKey={selectedCtSinusesFeatureKey}
                    onVoxelSegmentationDirty={setVoxelSegmentationDirty}
                  />
                ) : (
                  <div className="mpr-placeholder">
                    <div className="loading-spinner"></div>
                    <span>{t('viewer.firstSlice')}</span>
                  </div>
                )}
              </section>
            )}
          </div>
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
          {state.isLoaded && (
            <>
              {config.ctSinusesMinicatMeasurementsEnabled &&
                isCT &&
                state.currentSeries && (
                  <CtSinusesFeaturePanel
                    selectedFeatureKey={selectedCtSinusesFeatureKey}
                    onFeatureSelect={handleCtSinusesFeatureSelect}
                  />
                )}
              {config.ctSinusesMinicatMeasurementsEnabled && isCT && (
                <div
                  id="mpr-segmentation-controls-slot"
                  className="mpr-segmentation-controls-slot"
                  aria-label="Controles de segmentación voxel"
                />
              )}
              <LinesPanel
                enabled={config.nasalSeptumDeviationEnabled &&
                  isCT}
                active={nasalSeptumDeviationActive}
                onFeatureSelect={handleNasalSeptumDeviationSelect}
              />
              <MeasurementsPanel
                measurements={measurements}
                currentImageIndex={state.imageIndex}
                onMeasurementSelect={measurement => { void handleMeasurementSelect(measurement); }}
                onMeasurementSave={saveMeasurement}
                onMeasurementRemove={measurement => {
                  setConfirmRequest({
                    title: t('viewer.deleteMeasurement'),
                    message: t('viewer.deleteMeasurementMessage', {
                      name: getMeasurementLabel(t, measurement.toolName, measurement.labelCode),
                    }),
                    confirmLabel: t('common.delete'),
                    danger: true,
                    onConfirm: () => { void removeMeasurement(measurement.annotationUID); },
                  });
                }}
                onMeasurementRetry={retryMeasurement}
              />
              {config.windowLevelPresetsEnabled && (
                <Toolbar
                  windowLevel={state.windowLevel}
                  onWindowLevelChange={handleWindowLevelChange}
                  modality={state.currentStudy?.modality}
                />
              )}
              {config.downloadEnabled && state.currentStudy && (
                <DownloadButton
                  study={state.currentStudy}
                  currentSeries={state.currentSeries}
                />
              )}
              {config.reportServiceEnabled && state.currentStudy && (
                <ReportPanel
                  studyInstanceUID={state.currentStudy.studyInstanceUID}
                  patientID={state.currentStudy.patientID}
                  accessionNumber={state.currentStudy.accessionNumber}
                />
              )}
            </>
          )}
        </aside>
      </div>
      <ConfirmDialog
        isOpen={Boolean(confirmRequest)}
        title={confirmRequest?.title || ''}
        message={confirmRequest?.message || ''}
        confirmLabel={confirmRequest?.confirmLabel || t('common.confirm')}
        danger={confirmRequest?.danger}
        onCancel={() => setConfirmRequest(null)}
        onConfirm={() => {
          const request = confirmRequest;
          setConfirmRequest(null);
          request?.onConfirm();
        }}
      />
    </div>
  );
};

export default DicomViewer;
