import React from 'react';
import { DicomStudy, DicomSeries } from '../types/dicom';

interface SeriesPanelProps {
  study: DicomStudy;
  currentSeries: DicomSeries | null;
  onSeriesSelect: (series: DicomSeries) => void;
  onBackToStudies: () => void;
  thumbnails: Record<string, string>;
}

const SeriesPanel: React.FC<SeriesPanelProps> = ({
  study,
  currentSeries,
  onSeriesSelect,
  onBackToStudies,
  thumbnails,
}) => {
  const getModalityIcon = (modality: string): string => {
    const icons: Record<string, string> = {
      CT: '🖥',
      MR: '🧲',
      DX: '📸',
      US: '📡',
      MG: '🔬',
      CR: '📷',
      NM: '☢',
      PT: '⚛',
      XA: '🩻',
      RF: '📺',
    };
    return icons[modality] || '📋';
  };

  return (
    <div className="series-panel">
      <div className="series-panel-header">
        <button className="back-btn" onClick={onBackToStudies}>
          ← Estudios
        </button>
      </div>

      <div className="patient-info-section">
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
          <span className="info-value">{study.studyDate}</span>
        </div>
        <div className="patient-info-row">
          <span className="info-label">Modalidad:</span>
          <span className="info-value">{study.modality}</span>
        </div>
        {study.studyDescription && (
          <div className="patient-info-row">
            <span className="info-label">Descripción:</span>
            <span className="info-value">{study.studyDescription}</span>
          </div>
        )}
      </div>

      <div className="series-selector-section">
        <h4>Series ({study.series.length})</h4>
        <div className="series-list">
          {study.series.map((series, index) => (
            <div
              key={series.seriesInstanceUID}
              className={`series-item ${currentSeries?.seriesInstanceUID === series.seriesInstanceUID ? 'active' : ''}`}
              onClick={() => onSeriesSelect(series)}
            >
              <div className="series-thumbnail-container">
                {thumbnails[series.seriesInstanceUID] ? (
                  <img
                    src={thumbnails[series.seriesInstanceUID]}
                    alt={`Serie ${series.seriesNumber || index + 1}`}
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
                  <span className="series-number">Serie {series.seriesNumber || index + 1}</span>
                  <span className="series-modality">{series.modality}</span>
                </div>
                <div className="series-item-body">
                  <span className="series-description">
                    {series.seriesDescription || 'Sin descripción'}
                  </span>
                  <span className="series-count">
                    {series.instances?.length || series.numberOfInstances || 0} img
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SeriesPanel;
