import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { DicomSeries, DicomStudy } from '../types/dicom';
import type { PreloadQueueState, PreloadQueueItem } from '../services/preloadQueue';
import { annotationService } from '../services/annotations';
import { dicomWebService } from '../services/dicomWeb';
import { segmentationJobService } from '../services/segmentationJobs';
import { segmentationObjectService } from '../services/segmentationObjects';
import type { StudySegmentationStatus } from '../types/segmentationJobs';
import { useTranslation } from '../i18n';

type MeasurementFilter = 'all' | 'with' | 'without';
type MeasurementStatus = 'loading' | 'with' | 'without' | 'error';
type SegmentationFilter = 'all' | 'with' | 'without' | 'processing' | 'failed';

interface StudyMeasurementStatus {
  status: MeasurementStatus;
  count?: number;
}

interface StudyBrowserProps {
  studies: DicomStudy[];
  onStudySelect: (study: DicomStudy) => void;
  isLoading: boolean;
  onRefresh: () => void;
  preloadQueue: PreloadQueueState;
  onToggleStudyPreload: (studyInstanceUID: string) => Promise<void>;
  onPreloadStudies: (studyInstanceUIDs: string[]) => Promise<void>;
  onClearPreloadQueue: () => Promise<void>;
}

const MODALITIES = ['CT', 'MR', 'DX', 'US', 'MG', 'CR', 'NM', 'PT', 'XA', 'RF'];
const PAGE_SIZE = 20;

const StudyBrowser: React.FC<StudyBrowserProps> = ({
  studies,
  onStudySelect,
  isLoading,
  onRefresh,
  preloadQueue,
  onToggleStudyPreload,
  onPreloadStudies,
  onClearPreloadQueue,
}) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedModality, setSelectedModality] = useState<string>('');
  const [measurementFilter, setMeasurementFilter] = useState<MeasurementFilter>('all');
  const [measurementStatuses, setMeasurementStatuses] = useState<Record<string, StudyMeasurementStatus>>({});
  const [segmentationFilter, setSegmentationFilter] = useState<SegmentationFilter>('all');
  const [segmentationStatuses, setSegmentationStatuses] = useState<Record<string, StudySegmentationStatus>>({});
  const [selectedStudyUIDs, setSelectedStudyUIDs] = useState<Set<string>>(new Set());
  const [segmentationDialogOpen, setSegmentationDialogOpen] = useState(false);
  const [eligibleSeries, setEligibleSeries] = useState<Record<string, DicomSeries[]>>({});
  const [selectedSeriesUIDs, setSelectedSeriesUIDs] = useState<Record<string, string>>({});
  const [segmentationDialogBusy, setSegmentationDialogBusy] = useState(false);
  const [segmentationDialogError, setSegmentationDialogError] = useState<string | null>(null);
  const [expandedSegmentationUID, setExpandedSegmentationUID] = useState<string | null>(null);
  const [sortField, setSortField] = useState<'studyDate' | 'patientName' | 'modality'>('studyDate');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [pushingSegmentationUIDs, setPushingSegmentationUIDs] = useState<Set<string>>(new Set());
  const [pushSegmentationError, setPushSegmentationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeasurementStatuses(Object.fromEntries(
      studies.map(study => [study.studyInstanceUID, { status: 'loading' as const }])
    ));

    const loadStatuses = async () => {
      const statuses: Record<string, StudyMeasurementStatus> = {};
      let nextIndex = 0;

      const worker = async () => {
        while (!cancelled) {
          const index = nextIndex++;
          if (index >= studies.length) return;
          const study = studies[index];

          try {
            const result = await annotationService.listAnnotations({
              studyInstanceUID: study.studyInstanceUID,
              latestOnly: true,
              limit: 1,
              offset: 0,
            });
            statuses[study.studyInstanceUID] = {
              status: result.total > 0 ? 'with' : 'without',
              count: result.total,
            };
          } catch (error) {
            console.warn('[Studies] No se pudo consultar measurements', study.studyInstanceUID, error);
            statuses[study.studyInstanceUID] = { status: 'error' };
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(6, studies.length) }, () => worker())
      );

      if (!cancelled) setMeasurementStatuses(statuses);
    };

    void loadStatuses();
    return () => { cancelled = true; };
  }, [studies]);

  const loadSegmentationStatuses = useCallback(async () => {
    try {
      const items = await segmentationJobService.statuses(studies.map(study => study.studyInstanceUID));
      setSegmentationStatuses(Object.fromEntries(items.map(item => [item.studyInstanceUID, item])));
    } catch (error) {
      console.warn('[Studies] No se pudieron consultar los estados SEG', error);
    }
  }, [studies]);

  useEffect(() => {
    void loadSegmentationStatuses();
  }, [loadSegmentationStatuses]);

  useEffect(() => {
    const hasActiveJobs = Object.values(segmentationStatuses).some(status =>
      status.activeJobId || status.state === 'queued' || status.state === 'processing'
    );
    if (!hasActiveJobs) return undefined;
    const interval = window.setInterval(() => void loadSegmentationStatuses(), 10_000);
    return () => window.clearInterval(interval);
  }, [segmentationStatuses, loadSegmentationStatuses]);

  const filteredStudies = useMemo(() => {
    let filtered = studies.filter((study) => {
      const matchesSearch = !searchTerm || 
        study.patientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        study.patientID.toLowerCase().includes(searchTerm.toLowerCase()) ||
        study.studyDescription.toLowerCase().includes(searchTerm.toLowerCase()) ||
        study.studyDate.includes(searchTerm) ||
        (study.accessionNumber && study.accessionNumber.includes(searchTerm));

      const studyModalities = (study.modality || '')
        .split(',')
        .map(modality => modality.trim().toUpperCase())
        .filter(Boolean);
      const matchesModality = !selectedModality ||
        studyModalities.includes(selectedModality);

      const studyMeasurementStatus = measurementStatuses[study.studyInstanceUID]?.status;
      const matchesMeasurement = measurementFilter === 'all' ||
        studyMeasurementStatus === measurementFilter;

      const segmentation = segmentationStatuses[study.studyInstanceUID];
      const matchesSegmentation = segmentationFilter === 'all' ||
        (segmentationFilter === 'with' && Boolean(segmentation?.hasSeg)) ||
        (segmentationFilter === 'without' && (!segmentation || segmentation.state === 'without_seg')) ||
        (segmentationFilter === 'processing' && Boolean(segmentation?.activeJobId)) ||
        (segmentationFilter === 'failed' && segmentation?.state === 'failed');

      return matchesSearch && matchesModality && matchesMeasurement && matchesSegmentation;
    });

    filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'studyDate':
          comparison = (a.studyDate || '').localeCompare(b.studyDate || '');
          break;
        case 'patientName':
          comparison = (a.patientName || '').localeCompare(b.patientName || '');
          break;
        case 'modality':
          comparison = (a.modality || '').localeCompare(b.modality || '');
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [studies, searchTerm, selectedModality, measurementFilter, measurementStatuses,
    segmentationFilter, segmentationStatuses, sortField, sortDirection]);

  useEffect(() => { setPage(0); }, [searchTerm, selectedModality, measurementFilter, segmentationFilter, sortField, sortDirection]);

  const pageCount = Math.max(1, Math.ceil(filteredStudies.length / PAGE_SIZE));
  const visibleStudies = filteredStudies.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const visibleSelected = visibleStudies.filter(study => selectedStudyUIDs.has(study.studyInstanceUID));
  const allVisibleSelected = visibleStudies.length > 0 && visibleSelected.length === visibleStudies.length;

  const handleSort = (field: 'studyDate' | 'patientName' | 'modality') => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const formatDate = (date: string): string => {
    if (!date || date.length !== 8) return date;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  };

  const getSortIcon = (field: string) => {
    if (sortField !== field) return '↕';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  const queueItems = Object.values(preloadQueue.items);
  const downloadingCount = queueItems.filter(item => item.status === 'downloading').length;
  const queuedCount = queueItems.filter(item => item.status === 'queued').length;
  const completeCount = queueItems.filter(item => item.status === 'complete').length;

  const getPreloadLabel = (item: PreloadQueueItem | null): string => {
    if (!item) return t('studies.noMark');
    if (item.status === 'queued') return t('studies.queued');
    if (item.status === 'complete') return t('studies.available');
    if (item.status === 'error') return t('studies.preloadError');
    if (item.total > 0) return t('studies.downloading', { completed: item.completed, total: item.total });
    return t('studies.preparing');
  };

  const handlePreloadToggle = (event: React.ChangeEvent<HTMLInputElement>, study: DicomStudy) => {
    event.stopPropagation();
    void onToggleStudyPreload(study.studyInstanceUID);
  };

  const handlePreloadVisibleStudies = () => {
    void onPreloadStudies(filteredStudies.map(study => study.studyInstanceUID));
  };

  const getMeasurementLabel = (studyInstanceUID: string): string => {
    const measurement = measurementStatuses[studyInstanceUID];
    if (!measurement || measurement.status === 'loading') return t('studies.querying');
    if (measurement.status === 'with') return t('studies.yes') + (measurement.count ? ` (${measurement.count})` : '');
    if (measurement.status === 'without') return t('studies.no');
    return t('studies.notAvailable');
  };

  const getSegmentationLabel = (studyInstanceUID: string): string => {
    const status = segmentationStatuses[studyInstanceUID];
    if (!status) return t('studies.segQuerying');
    if (status.hasSeg) {
      const base = t('studies.segWith', { count: status.segmentationCount });
      return status.activeJobId ? `${base} · ${t('studies.segUpdating')}` : base;
    }
    if (status.state === 'queued') return t('studies.segQueued');
    if (status.state === 'processing') return t('studies.segProcessing');
    if (status.state === 'failed') return t('studies.segFailed');
    return t('studies.segWithout');
  };

  const pushSegmentation = async (study: DicomStudy) => {
    const objectId = segmentationStatuses[study.studyInstanceUID]?.latestSegmentationObjectId;
    if (!objectId) return;
    setPushSegmentationError(null);
    setPushingSegmentationUIDs(current => new Set(current).add(study.studyInstanceUID));
    try {
      await segmentationObjectService.pushToS3(objectId);
    } catch (error) {
      console.error('[Studies] No se pudo enviar el SEG a S3', error);
      setPushSegmentationError(error instanceof Error ? error.message : 'No se pudo enviar el SEG a S3');
    } finally {
      setPushingSegmentationUIDs(current => {
        const next = new Set(current); next.delete(study.studyInstanceUID); return next;
      });
    }
  };

  const toggleStudySelection = (studyInstanceUID: string) => {
    setSelectedStudyUIDs(current => {
      const next = new Set(current);
      next.has(studyInstanceUID) ? next.delete(studyInstanceUID) : next.add(studyInstanceUID);
      return next;
    });
  };

  const openSegmentationDialog = async () => {
    const selected = studies.filter(study => selectedStudyUIDs.has(study.studyInstanceUID));
    if (!selected.length) return;
    setSegmentationDialogOpen(true);
    setSegmentationDialogBusy(true);
    setSegmentationDialogError(null);
    setEligibleSeries({});
    setSelectedSeriesUIDs({});
    try {
      const entries = await Promise.all(selected.map(async study => {
        const series = (await dicomWebService.getStudySeries(study.studyInstanceUID))
          .filter(item => item.modality.toUpperCase() === 'CT');
        return [study.studyInstanceUID, series] as const;
      }));
      const byStudy = Object.fromEntries(entries);
      setEligibleSeries(byStudy);
      setSelectedSeriesUIDs(Object.fromEntries(entries
        .filter(([, series]) => series.length === 1)
        .map(([studyUID, series]) => [studyUID, series[0].seriesInstanceUID])));
    } catch (error) {
      setSegmentationDialogError(error instanceof Error ? error.message : t('studies.segSeriesError'));
    } finally { setSegmentationDialogBusy(false); }
  };

  const enqueueSegmentations = async () => {
    const items = Array.from(selectedStudyUIDs).map(studyInstanceUID => ({
      studyInstanceUID,
      sourceSeriesInstanceUID: selectedSeriesUIDs[studyInstanceUID],
    }));
    if (items.some(item => !item.sourceSeriesInstanceUID)) {
      setSegmentationDialogError(t('studies.segSelectAllSeries')); return;
    }
    setSegmentationDialogBusy(true);
    setSegmentationDialogError(null);
    try {
      await segmentationJobService.enqueue({
        items,
        modelName: import.meta.env.VITE_SEGMENTATION_MODEL_NAME || 'minicat-3d',
        modelVersion: import.meta.env.VITE_SEGMENTATION_MODEL_VERSION || '1',
        idempotencyKey: crypto.randomUUID(),
      });
      setSegmentationDialogOpen(false);
      setSelectedStudyUIDs(new Set());
      await loadSegmentationStatuses();
    } catch (error) {
      setSegmentationDialogError(error instanceof Error ? error.message : t('studies.segEnqueueError'));
    } finally { setSegmentationDialogBusy(false); }
  };

  return (
    <div className="study-browser">
      <div className="study-browser-header">
        <h2>{t('studies.title')}</h2>
        <div className="study-browser-header-actions">
          <button
            className="segmentation-generate-btn"
            onClick={() => void openSegmentationDialog()}
            disabled={selectedStudyUIDs.size === 0}
            title={t('studies.segGenerateTitle')}
          >
            ◈ {t('studies.segGenerate', { count: selectedStudyUIDs.size })}
          </button>
          {queueItems.length > 0 && (
            <button
              className="clear-preload-btn"
              onClick={() => void onClearPreloadQueue()}
              title={t('studies.clearPreloadsTitle')}
            >
              {t('studies.clearPreloads')}
            </button>
          )}
          <button
            className="preload-list-btn"
            onClick={handlePreloadVisibleStudies}
            disabled={isLoading || filteredStudies.length === 0}
            title={t('studies.preloadListTitle')}
          >
            {t('studies.preloadList', { count: filteredStudies.length })}
          </button>
          <button className="refresh-btn" onClick={() => {
            onRefresh();
            void loadSegmentationStatuses();
          }} disabled={isLoading}>
          {t('studies.refresh')}
          </button>
        </div>
      </div>

      <div className="study-browser-filters">
        <div className="search-box">
          <input
            type="text"
            placeholder={t('studies.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          {searchTerm && (
            <button className="clear-search" onClick={() => setSearchTerm('')}>×</button>
          )}
        </div>

        <div className="modality-filters">
          <button
            className={`modality-chip ${!selectedModality ? 'active' : ''}`}
            onClick={() => setSelectedModality('')}
          >
            {t('studies.all')}
          </button>
          {MODALITIES.map(mod => (
            <button
              key={mod}
              className={`modality-chip ${selectedModality === mod ? 'active' : ''}`}
              onClick={() => setSelectedModality(selectedModality === mod ? '' : mod)}
            >
              {mod}
            </button>
          ))}
        </div>

        <div className="measurement-filters" aria-label={t('studies.filterMeasurements')}>
          <span className="measurement-filter-label">{t('studies.measurements')}:</span>
          {([
            ['all', 'studies.all'],
            ['with', 'studies.withMeasurements'],
            ['without', 'studies.withoutMeasurements'],
          ] as const).map(([value, labelKey]) => (
            <button
              key={value}
              className={`measurement-filter-chip ${measurementFilter === value ? 'active' : ''}`}
              onClick={() => setMeasurementFilter(value)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="measurement-filters" aria-label={t('studies.filterSeg')}>
          <span className="measurement-filter-label">SEG:</span>
          {([
            ['all', 'studies.all'],
            ['with', 'studies.segFilterWith'],
            ['without', 'studies.segFilterWithout'],
            ['processing', 'studies.segFilterProcessing'],
            ['failed', 'studies.segFilterFailed'],
          ] as const).map(([value, labelKey]) => (
            <button
              key={value}
              className={`measurement-filter-chip ${segmentationFilter === value ? 'active' : ''}`}
              onClick={() => setSegmentationFilter(value)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="study-browser-stats">
        {t('studies.stats', { visible: filteredStudies.length, total: studies.length })}
        {queueItems.length > 0 && (
          <span className="preload-summary" aria-live="polite">
            {t('studies.downloadSummary', {
              downloading: downloadingCount,
              queued: queuedCount,
              available: completeCount,
            })}
          </span>
        )}
      </div>
      {pushSegmentationError && <div className="segmentation-study-detail-error study-push-error">{pushSegmentationError}</div>}

      <div className="study-table-container">
        {isLoading && studies.length === 0 ? (
          <div className="loading-state">
            <div className="loading-spinner"></div>
            <p>{t('studies.loading')}</p>
          </div>
        ) : filteredStudies.length === 0 ? (
          <div className="empty-state">
            <p>{t('studies.empty')}</p>
            {(searchTerm || selectedModality || measurementFilter !== 'all' || segmentationFilter !== 'all') && (
              <button
                className="clear-filters-btn"
                onClick={() => {
                  setSearchTerm('');
                  setSelectedModality('');
                  setMeasurementFilter('all');
                  setSegmentationFilter('all');
                }}
              >
                {t('studies.clearFilters')}
              </button>
            )}
          </div>
        ) : (
          <table className="study-table">
            <thead>
              <tr>
                <th className="study-select-cell">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() => setSelectedStudyUIDs(current => {
                      const next = new Set(current);
                      visibleStudies.forEach(study => allVisibleSelected
                        ? next.delete(study.studyInstanceUID)
                        : next.add(study.studyInstanceUID));
                      return next;
                    })}
                    aria-label={t('studies.segSelectVisible')}
                  />
                </th>
                <th onClick={() => handleSort('patientName')} className="sortable">
                  {t('studies.patient')} {getSortIcon('patientName')}
                </th>
                <th>ID</th>
                <th onClick={() => handleSort('studyDate')} className="sortable">
                  {t('studies.date')} {getSortIcon('studyDate')}
                </th>
                <th onClick={() => handleSort('modality')} className="sortable">
                  {t('studies.modality')} {getSortIcon('modality')}
                </th>
                <th>{t('studies.description')}</th>
                <th>{t('studies.accession')}</th>
                <th>{t('studies.measurements')}</th>
                <th>SEG</th>
                <th>{t('studies.preload')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleStudies.map((study) => (
                <tr
                  key={study.studyInstanceUID}
                  className="study-row"
                  onClick={() => onStudySelect(study)}
                >
                  <td className="study-select-cell" onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedStudyUIDs.has(study.studyInstanceUID)}
                      onChange={() => toggleStudySelection(study.studyInstanceUID)}
                      aria-label={t('studies.segSelectStudy', { study: study.patientName || study.studyInstanceUID })}
                    />
                  </td>
                  <td className="patient-name-cell">
                    <div className="patient-name-content">
                      <span className="patient-name">{study.patientName || t('common.noName')}</span>
                      {study.patientSex && (
                        <span className="patient-sex">{study.patientSex}</span>
                      )}
                    </div>
                  </td>
                  <td className="patient-id-cell">{study.patientID}</td>
                  <td className="date-cell">{formatDate(study.studyDate)}</td>
                  <td className="modality-cell">
                    <span className="modality-badge">{study.modality || '-'}</span>
                  </td>
                  <td className="description-cell">{study.studyDescription || '-'}</td>
                  <td className="accession-cell">{study.accessionNumber || '-'}</td>
                  <td className="measurement-cell">
                    <span
                      className={`measurement-status measurement-status-${measurementStatuses[study.studyInstanceUID]?.status || 'loading'}`}
                    >
                      {getMeasurementLabel(study.studyInstanceUID)}
                    </span>
                  </td>
                  <td className="segmentation-status-cell" title={segmentationStatuses[study.studyInstanceUID]?.lastError || ''}
                    onClick={event => event.stopPropagation()}>
                    <span className={`segmentation-study-status segmentation-study-status-${segmentationStatuses[study.studyInstanceUID]?.state || 'loading'}`}>
                      {getSegmentationLabel(study.studyInstanceUID)}
                    </span>
                    {(segmentationStatuses[study.studyInstanceUID]?.activeJobId || segmentationStatuses[study.studyInstanceUID]?.lastError) && (
                      <button className="segmentation-study-detail-btn" onClick={() => setExpandedSegmentationUID(current =>
                        current === study.studyInstanceUID ? null : study.studyInstanceUID)} aria-label={t('studies.segDetails')}>ⓘ</button>
                    )}
                    {expandedSegmentationUID === study.studyInstanceUID && segmentationStatuses[study.studyInstanceUID] && (
                      <div className="segmentation-study-detail">
                        {segmentationStatuses[study.studyInstanceUID].activeJobId && (
                          <><div>{segmentationStatuses[study.studyInstanceUID].stage || t('studies.segProcessing')} · {Math.round(segmentationStatuses[study.studyInstanceUID].progress || 0)}%</div>
                          <small>Job {segmentationStatuses[study.studyInstanceUID].activeJobId}</small></>
                        )}
                        {segmentationStatuses[study.studyInstanceUID].lastError && (
                          <div className="segmentation-study-detail-error">{segmentationStatuses[study.studyInstanceUID].lastError}</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="preload-cell">
                    <label
                      className="preload-toggle"
                      title={t('studies.preloadListTitle')}
                      onClick={event => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(preloadQueue.items[study.studyInstanceUID])}
                        onChange={event => handlePreloadToggle(event, study)}
                        aria-label={t('studies.preloadAria', {
                          study: study.patientName || study.studyInstanceUID,
                        })}
                      />
                      <span className="preload-toggle-mark" />
                    </label>
                    <span
                      className={`preload-status preload-status-${preloadQueue.items[study.studyInstanceUID]?.status || 'idle'}`}
                    >
                      {getPreloadLabel(preloadQueue.items[study.studyInstanceUID] || null)}
                    </span>
                  </td>
                  <td className="action-cell">
                    <button
                      className="segmentation-push-btn"
                      disabled={!segmentationStatuses[study.studyInstanceUID]?.latestSegmentationObjectId || pushingSegmentationUIDs.has(study.studyInstanceUID)}
                      onClick={event => { event.stopPropagation(); void pushSegmentation(study); }}
                      title="Enviar el SEG vigente a S3, dentro de la carpeta de este estudio"
                    >
                      {pushingSegmentationUIDs.has(study.studyInstanceUID) ? '…' : 'PUSH SEG'}
                    </button>
                    <button className="view-btn" title={t('studies.viewStudy')}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {filteredStudies.length > 0 && (
        <div className="study-pagination" aria-label="Paginación de estudios">
          <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>← Anterior</button>
          <span>Página {page + 1} de {pageCount} · {visibleStudies.length} visibles</span>
          <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Siguiente →</button>
        </div>
      )}
      {segmentationDialogOpen && (
        <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => {
          if (!segmentationDialogBusy) setSegmentationDialogOpen(false);
        }}>
          <section
            className="segmentation-job-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="segmentation-job-dialog-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <h2 id="segmentation-job-dialog-title">{t('studies.segDialogTitle')}</h2>
            <p>{t('studies.segDialogDescription')}</p>
            {segmentationDialogBusy && Object.keys(eligibleSeries).length === 0 ? (
              <div className="segmentation-job-dialog-loading">{t('common.loading')}</div>
            ) : (
              <div className="segmentation-job-series-list">
                {studies.filter(study => selectedStudyUIDs.has(study.studyInstanceUID)).map(study => (
                  <label key={study.studyInstanceUID} className="segmentation-job-series-row">
                    <span>{study.patientName || study.patientID || study.studyInstanceUID}</span>
                    <select
                      value={selectedSeriesUIDs[study.studyInstanceUID] || ''}
                      onChange={event => setSelectedSeriesUIDs(current => ({
                        ...current, [study.studyInstanceUID]: event.target.value,
                      }))}
                      disabled={segmentationDialogBusy}
                    >
                      <option value="">{t('studies.segChooseSeries')}</option>
                      {(eligibleSeries[study.studyInstanceUID] || []).map(series => (
                        <option key={series.seriesInstanceUID} value={series.seriesInstanceUID}>
                          {t('series.label', { number: series.seriesNumber })} · {series.seriesDescription || series.seriesInstanceUID}
                        </option>
                      ))}
                    </select>
                    {eligibleSeries[study.studyInstanceUID]?.length === 0 && (
                      <small>{t('studies.segNoCtSeries')}</small>
                    )}
                  </label>
                ))}
              </div>
            )}
            {segmentationDialogError && <div className="segmentation-job-dialog-error">{segmentationDialogError}</div>}
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn secondary" disabled={segmentationDialogBusy}
                onClick={() => setSegmentationDialogOpen(false)}>{t('common.cancel')}</button>
              <button className="confirm-dialog-btn primary" disabled={segmentationDialogBusy}
                onClick={() => void enqueueSegmentations()}>{t('studies.segEnqueue')}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default StudyBrowser;
