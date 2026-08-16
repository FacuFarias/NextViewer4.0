import React from 'react';
import { DicomStudy, DicomSeries } from '../types/dicom';
import type { SeriesPreloadProgress } from '../hooks/useDicomViewer';
import type { PreloadQueueState, SeriesPreloadItem } from '../services/preloadQueue';
import { useTranslation } from '../i18n';

interface SeriesPanelProps {
  study: DicomStudy;
  currentSeries: DicomSeries | null;
  onSeriesSelect: (series: DicomSeries) => void;
  thumbnails: Record<string, string>;
  preloadProgress: Record<string, SeriesPreloadProgress>;
  preloadQueue: PreloadQueueState;
}

const SeriesPanel: React.FC<SeriesPanelProps> = ({
  study,
  currentSeries,
  onSeriesSelect,
  thumbnails,
  preloadProgress,
  preloadQueue,
}) => {
  const { t } = useTranslation();
  const visibleSeries = study.series.filter(series => {
    const seriesModality = series.modality?.trim().toUpperCase();
    const instanceModality = series.instances?.[0]?.modality?.trim().toUpperCase();
    return seriesModality !== 'SEG' && instanceModality !== 'SEG';
  });
  const getModalityIcon = (modality: string): string => {
    return modality || 'DICOM';
  };

  return (
    <div className="series-panel">
      <div className="patient-info-section">
        <div className="patient-info-row">
          <span className="info-label">{t('series.patient')}</span>
          <span className="info-value">{study.patientName || t('common.noName')}</span>
        </div>
        <div className="patient-info-row">
          <span className="info-label">{t('series.id')}</span>
          <span className="info-value">{study.patientID}</span>
        </div>
        <div className="patient-info-row">
          <span className="info-label">{t('series.accession')}</span>
          <span className="info-value">{study.accessionNumber || '—'}</span>
        </div>
        <div className="patient-info-row">
          <span className="info-label">{t('series.date')}</span>
          <span className="info-value">{study.studyDate}</span>
        </div>
        <div className="patient-info-row">
          <span className="info-label">{t('series.modality')}</span>
          <span className="info-value">{study.modality}</span>
        </div>
        {study.studyDescription && (
          <div className="patient-info-row">
            <span className="info-label">{t('series.description')}</span>
            <span className="info-value">{study.studyDescription}</span>
          </div>
        )}
      </div>

      <div className="series-selector-section">
        <h4>{t('series.title', { count: visibleSeries.length })}</h4>
        <div className="series-list">
          {visibleSeries.map((series, index) => (
            <div
              key={series.seriesInstanceUID}
              className={`series-item ${currentSeries?.seriesInstanceUID === series.seriesInstanceUID ? 'active' : ''}`}
              onClick={() => onSeriesSelect(series)}
            >
              <div className="series-thumbnail-container">
                {thumbnails[series.seriesInstanceUID] ? (
                  <img
                    src={thumbnails[series.seriesInstanceUID]}
                    alt={t('series.alt', { number: series.seriesNumber || index + 1 })}
                    className="series-thumbnail"
                    loading="lazy"
                  />
                ) : (
                  <div className="series-thumbnail-placeholder">
                    {getModalityIcon(series.modality)}
                  </div>
                )}
              </div>
              <div className="series-item-info">
                <div className="series-item-header">
                  <span className="series-number">{t('series.label', { number: series.seriesNumber || index + 1 })}</span>
                  <span className="series-modality">{series.modality}</span>
                </div>
                <div className="series-item-body">
                  <span className="series-description">
                    {series.seriesDescription || t('common.noDescription')}
                  </span>
                  <span className="series-count">
                    {t('series.imagesShort', { count: series.instances?.length || series.numberOfInstances || 0 })}
                  </span>
                </div>
                {(() => {
                  const queuedStudy = preloadQueue.items[study.studyInstanceUID];
                  const persistentProgress: SeriesPreloadItem | undefined = queuedStudy?.series?.[series.seriesInstanceUID] ||
                    (queuedStudy?.status === 'complete' && !queuedStudy.series
                      ? {
                        status: 'complete',
                        completed: series.numberOfInstances || series.instances?.length || 0,
                        total: series.numberOfInstances || series.instances?.length || 0,
                        failed: 0,
                      }
                      : undefined);
                  const runtimeProgress = preloadProgress[series.seriesInstanceUID];
                  const progress = persistentProgress || runtimeProgress;
                  if (!progress) return null;
                  const loaded = 'completed' in progress ? progress.completed : progress.loaded;
                  const percentage = Math.round(
                    (loaded / Math.max(1, progress.total)) * 100
                  );
                  const statusLabel = 'status' in progress
                    ? progress.status === 'complete'
                      ? t('series.cached')
                      : progress.status === 'error'
                        ? t('series.error')
                        : progress.status === 'queued'
                          ? t('studies.queued')
                          : t('studies.downloading', { completed: loaded, total: progress.total })
                    : progress.done ? t('series.cached') : t('series.preparing');
                  return (
                    <div
                      className="series-cache-progress"
                      title={t('series.titleProgress', { loaded, total: progress.total })}
                    >
                      <div className="series-cache-progress-label">
                        <span>{statusLabel}</span>
                        <span>{percentage}%</span>
                      </div>
                      <div className="series-cache-progress-track" role="progressbar" aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100}>
                        <div className="series-cache-progress-bar" style={{ width: `${percentage}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SeriesPanel;
