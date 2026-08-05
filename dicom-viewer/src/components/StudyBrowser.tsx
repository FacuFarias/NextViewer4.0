import React, { useEffect, useState, useMemo } from 'react';
import { DicomStudy } from '../types/dicom';
import type { PreloadQueueState, PreloadQueueItem } from '../services/preloadQueue';
import { annotationService } from '../services/annotations';
import { useTranslation } from '../i18n';

type MeasurementFilter = 'all' | 'with' | 'without';
type MeasurementStatus = 'loading' | 'with' | 'without' | 'error';

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
  const [sortField, setSortField] = useState<'studyDate' | 'patientName' | 'modality'>('studyDate');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

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

      return matchesSearch && matchesModality && matchesMeasurement;
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
  }, [studies, searchTerm, selectedModality, measurementFilter, measurementStatuses, sortField, sortDirection]);

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

  return (
    <div className="study-browser">
      <div className="study-browser-header">
        <h2>{t('studies.title')}</h2>
        <div className="study-browser-header-actions">
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
            ⬇ {t('studies.preloadList', { count: filteredStudies.length })}
          </button>
          <button className="refresh-btn" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? '⟳' : '↻'} {t('studies.refresh')}
          </button>
        </div>
      </div>

      <div className="study-browser-filters">
        <div className="search-box">
          <span className="search-icon">🔍</span>
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

      <div className="study-table-container">
        {isLoading && studies.length === 0 ? (
          <div className="loading-state">
            <div className="loading-spinner"></div>
            <p>{t('studies.loading')}</p>
          </div>
        ) : filteredStudies.length === 0 ? (
          <div className="empty-state">
            <p>{t('studies.empty')}</p>
            {(searchTerm || selectedModality || measurementFilter !== 'all') && (
              <button
                className="clear-filters-btn"
                onClick={() => {
                  setSearchTerm('');
                  setSelectedModality('');
                  setMeasurementFilter('all');
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
                <th>{t('studies.preload')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredStudies.map((study) => (
                <tr
                  key={study.studyInstanceUID}
                  className="study-row"
                  onClick={() => onStudySelect(study)}
                >
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
                    <button className="view-btn" title={t('studies.viewStudy')}>
                      👁
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default StudyBrowser;
