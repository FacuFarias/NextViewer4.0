import React, { useEffect, useMemo, useState } from 'react';
import { DicomStudy, DicomSeries } from '../types/dicom';

interface SeriesPanelProps {
  study: DicomStudy;
  priorStudies?: DicomStudy[];
  currentSeries: DicomSeries | null;
  onSeriesSelect: (series: DicomSeries) => void;
  thumbnails: Record<string, string>;
  isLoadingPriors?: boolean;
  priorStudiesError?: string | null;
}

const formatPatientDate = (date: string): string => (
  date?.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date
);

const SeriesItems: React.FC<Pick<SeriesPanelProps, 'currentSeries' | 'onSeriesSelect' | 'thumbnails'> & {
  study: DicomStudy;
}> = ({ study, currentSeries, onSeriesSelect, thumbnails }) => {
  const getModalityIcon = (modality: string): string => {
    const icons: Record<string, string> = {
      CT: '🖥', MR: '🧲', DX: '📸', US: '📡', MG: '🔬', CR: '📷',
      NM: '☢', PT: '⚛', XA: '🩻', RF: '📺',
    };
    return icons[modality] || '📋';
  };

  return (
    <div className="series-list study-series-list">
      {study.series.map((series, index) => {
        const isActive = currentSeries?.seriesInstanceUID === series.seriesInstanceUID &&
          (currentSeries.studyInstanceUID || study.studyInstanceUID) === study.studyInstanceUID;
        return (
          <div
            key={`${study.studyInstanceUID}:${series.seriesInstanceUID}`}
            className={`series-item ${isActive ? 'active' : ''}`}
            onClick={() => onSeriesSelect(series)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSeriesSelect(series);
              }
            }}
            role="button"
            tabIndex={0}
            aria-current={isActive ? 'true' : undefined}
          >
            <div className="series-thumbnail-container">
              {thumbnails[series.seriesInstanceUID] ? (
                <img
                  src={thumbnails[series.seriesInstanceUID]}
                  alt={`Serie ${series.seriesNumber || index + 1}`}
                  className="series-thumbnail"
                  loading="lazy"
                />
              ) : <div className="series-thumbnail-placeholder">{getModalityIcon(series.modality)}</div>}
            </div>
            <div className="series-item-info">
              <div className="series-item-header">
                <span className="series-number">Serie {series.seriesNumber || index + 1}</span>
                <span className="series-modality">{series.modality}</span>
              </div>
              <div className="series-item-body">
                <span className="series-description">{series.seriesDescription || 'Sin descripción'}</span>
                <span className="series-count">{series.instances?.length || series.numberOfInstances || 0} img</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const PatientInfo: React.FC<{ study: DicomStudy; className?: string; includeClinicalDetails?: boolean }> = ({
  study,
  className = '',
  includeClinicalDetails = false,
}) => (
  <div className={`patient-info-section${className ? ` ${className}` : ''}`}>
    <div className="patient-info-row">
      <span className="info-label">Paciente:</span>
      <span className="info-value">{study.patientName || 'Sin nombre'}</span>
    </div>
    <div className="patient-info-row">
      <span className="info-label">ID:</span>
      <span className="info-value">{study.patientID}</span>
    </div>
    <div className="patient-info-row">
      <span className="info-label">Fecha:</span>
      <span className="info-value">{formatPatientDate(study.studyDate)}</span>
    </div>
    <div className="patient-info-row">
      <span className="info-label">Modalidad:</span>
      <span className="info-value">{study.modality}</span>
    </div>
    {includeClinicalDetails && study.patientBirthDate && (
      <div className="patient-info-row">
        <span className="info-label">Nacimiento:</span>
        <span className="info-value">{formatPatientDate(study.patientBirthDate)}</span>
      </div>
    )}
    {includeClinicalDetails && study.patientSex && (
      <div className="patient-info-row">
        <span className="info-label">Sexo:</span>
        <span className="info-value">{study.patientSex}</span>
      </div>
    )}
    {study.studyDescription && (
      <div className="patient-info-row">
        <span className="info-label">Descripción:</span>
        <span className="info-value">{study.studyDescription}</span>
      </div>
    )}
  </div>
);

const SeriesPanel: React.FC<SeriesPanelProps> = ({
  study,
  priorStudies = [],
  currentSeries,
  onSeriesSelect,
  thumbnails,
  isLoadingPriors = false,
  priorStudiesError = null,
}) => {
  const [isPatientInfoOpen, setIsPatientInfoOpen] = useState(false);
  const priorStudyUIDs = useMemo(() => priorStudies.map(entry => entry.studyInstanceUID), [priorStudies]);
  const [isCurrentStudyExpanded, setIsCurrentStudyExpanded] = useState(true);
  const [expandedPriorUIDs, setExpandedPriorUIDs] = useState<string[]>([]);

  useEffect(() => {
    setExpandedPriorUIDs(previous => {
      // Los antecedentes permanecen colapsados por defecto. Si el usuario ya
      // abrió alguno, conservamos esa elección mientras siga disponible.
      return previous.filter(uid => priorStudyUIDs.includes(uid));
    });
  }, [priorStudyUIDs]);

  const togglePriorStudy = (studyInstanceUID: string) => {
    setExpandedPriorUIDs(previous => previous.includes(studyInstanceUID)
      ? previous.filter(uid => uid !== studyInstanceUID)
      : [...previous, studyInstanceUID]);
  };

  return (
    <div className="series-panel">
      <div className="series-panel-header">
        <button
          type="button"
          className="patient-data-toggle"
          onClick={() => setIsPatientInfoOpen(previous => !previous)}
          aria-expanded={isPatientInfoOpen}
          aria-controls="patient-info-panel"
        >
          <span className="patient-data-title">Datos del paciente</span>
          <span className="patient-data-chevron" aria-hidden="true">{isPatientInfoOpen ? '⌃' : '⌄'}</span>
        </button>
      </div>
      <div id="patient-info-panel" className={`patient-info-collapsible${isPatientInfoOpen ? ' open' : ''}`}>
        <PatientInfo study={study} />
      </div>

      <div className="series-selector-section">
        <h4>Estudios y series</h4>
        <div className="patient-studies-list">
          <section className="study-series-group current-study-group">
            <button
              type="button"
              className="study-series-heading"
              onClick={() => setIsCurrentStudyExpanded(previous => !previous)}
              aria-expanded={isCurrentStudyExpanded}
            >
              <span className="study-series-copy">
                <strong>{study.studyDescription || 'Estudio actual'}</strong>
                <small>{formatPatientDate(study.studyDate)} · {study.modality || 'N/D'}</small>
              </span>
              <span className="study-heading-actions">
                <span className="study-kind-badge">Actual</span>
                <span className="study-expand-chevron" aria-hidden="true">{isCurrentStudyExpanded ? '−' : '+'}</span>
              </span>
            </button>
            {isCurrentStudyExpanded && <SeriesItems study={study} currentSeries={currentSeries} onSeriesSelect={onSeriesSelect} thumbnails={thumbnails} />}
          </section>

          {(isLoadingPriors || priorStudies.length > 0 || priorStudiesError) && (
            <div className="prior-studies-divider">
              <span>Estudios previos</span>
              {!isLoadingPriors && <span>{priorStudies.length}</span>}
            </div>
          )}
          {isLoadingPriors && <div className="prior-studies-status">Buscando antecedentes del paciente…</div>}
          {priorStudiesError && <div className="prior-studies-status warning">{priorStudiesError}</div>}
          {priorStudies.map(priorStudy => {
            const isExpanded = expandedPriorUIDs.includes(priorStudy.studyInstanceUID);
            return (
              <section className="study-series-group prior-study-group" key={priorStudy.studyInstanceUID}>
                <button
                  type="button"
                  className="study-series-heading"
                  onClick={() => togglePriorStudy(priorStudy.studyInstanceUID)}
                  aria-expanded={isExpanded}
                >
                  <span className="study-series-copy">
                    <strong>{priorStudy.studyDescription || 'Estudio sin descripción'}</strong>
                    <small>{formatPatientDate(priorStudy.studyDate)} · {priorStudy.modality || 'N/D'} · {priorStudy.series.length} series</small>
                  </span>
                  <span className="study-expand-chevron" aria-hidden="true">{isExpanded ? '−' : '+'}</span>
                </button>
                {isExpanded && <SeriesItems study={priorStudy} currentSeries={currentSeries} onSeriesSelect={onSeriesSelect} thumbnails={thumbnails} />}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default SeriesPanel;
