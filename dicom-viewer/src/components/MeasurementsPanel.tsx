import React, { useState } from 'react';
import type { ViewerMeasurement } from '../hooks/useDicomViewer';
import { getMeasurementLabel, useTranslation } from '../i18n';

interface MeasurementsPanelProps {
  measurements: ViewerMeasurement[];
  currentImageIndex: number;
  onMeasurementSelect: (measurement: ViewerMeasurement) => void;
  onMeasurementSave: (annotationUID: string) => void;
  onMeasurementRemove: (measurement: ViewerMeasurement) => void;
  onMeasurementRetry: (annotationUID: string) => void;
}

const MeasurementsPanel: React.FC<MeasurementsPanelProps> = ({
  measurements,
  currentImageIndex,
  onMeasurementSelect,
  onMeasurementSave,
  onMeasurementRemove,
  onMeasurementRetry,
}) => (
  <MeasurementsPanelContent
    measurements={measurements}
    currentImageIndex={currentImageIndex}
    onMeasurementSelect={onMeasurementSelect}
    onMeasurementSave={onMeasurementSave}
    onMeasurementRemove={onMeasurementRemove}
    onMeasurementRetry={onMeasurementRetry}
  />
);

const MeasurementsPanelContent: React.FC<MeasurementsPanelProps> = ({
  measurements,
  currentImageIndex,
  onMeasurementSelect,
  onMeasurementSave,
  onMeasurementRemove,
  onMeasurementRetry,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const getMeasurementValue = (measurement: ViewerMeasurement): string => {
    if (measurement.measurementType === 'nasal_septum_deviation' &&
      Number.isFinite(measurement.axisLengthMm) && Number.isFinite(measurement.deviationLengthMm)) {
      return t('measurements.nasalValue', {
        axis: measurement.axisLengthMm!.toFixed(1),
        deviation: measurement.deviationLengthMm!.toFixed(1),
      });
    }
    return measurement.value === 'Sin valor' ? t('measurements.noValue') : measurement.value;
  };

  return (
  <section className="measurements-panel">
    <button
      type="button"
      className="measurements-panel-header"
      onClick={() => setIsOpen(open => !open)}
      aria-expanded={isOpen}
    >
      <span>{t('measurements.title')}</span>
      <span className="measurements-panel-toggle">{isOpen ? '▾' : '▸'}</span>
      <span className="measurements-panel-count">{measurements.length}</span>
    </button>

    {!isOpen ? null : measurements.length === 0 ? (
      <p className="measurements-empty">{t('measurements.empty')}</p>
    ) : (
      <div className="measurements-list">
        {measurements.map(measurement => (
          <div
            key={measurement.annotationUID}
            className={`measurement-item ${measurement.imageIndex === currentImageIndex ? 'active' : ''}`}
          >
            <button
              type="button"
              className="measurement-select-btn"
              onClick={() => onMeasurementSelect(measurement)}
              title={t('measurements.goToImage')}
            >
              <span className="measurement-tool-name">
                <span className="measurement-color" style={{ backgroundColor: measurement.color }} />
                {getMeasurementLabel(t, measurement.toolName, measurement.labelCode)}
              </span>
              <span className="measurement-details">
                {measurement.seriesNumber !== undefined
                  ? t('measurements.series', { number: measurement.seriesNumber })
                  : ''}
                {measurement.imageIndex >= 0
                  ? t('measurements.image', { number: measurement.imageIndex + 1 })
                  : t('measurements.otherSeries')}
                {measurement.instanceNumber
                  ? t('measurements.instance', { number: measurement.instanceNumber })
                  : ''}
              </span>
              <span className="measurement-value">{getMeasurementValue(measurement)}</span>
              {measurement.saveStatus === 'saving' && <span className="measurement-save-state">{t('measurements.saving')}</span>}
              {measurement.saveStatus === 'error' && <span className="measurement-save-state error">{t('measurements.saveError')}</span>}
            </button>
            <button
              type="button"
              className={`measurement-save-btn ${measurement.saveStatus === 'saved' ? 'saved' : ''}`}
              onClick={() => onMeasurementSave(measurement.annotationUID)}
              disabled={measurement.saveStatus === 'saving' || measurement.saveStatus === 'saved'}
              title={measurement.saveStatus === 'saved' ? t('measurements.saved') : t('measurements.save')}
              aria-label={measurement.saveStatus === 'saved' ? t('measurements.saved') : t('measurements.save')}
            >
              {measurement.saveStatus === 'saving' ? '…' : measurement.saveStatus === 'saved' ? 'Saved' : 'Save'}
            </button>
            {measurement.saveStatus === 'error' && (
              <button
                type="button"
                className="measurement-retry-btn"
                onClick={() => onMeasurementRetry(measurement.annotationUID)}
                title={t('measurements.retry')}
                aria-label={t('measurements.retry')}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              className="measurement-delete-btn"
              onClick={() => onMeasurementRemove(measurement)}
              title={t('measurements.delete')}
              aria-label={t('measurements.deleteAria', {
                name: getMeasurementLabel(t, measurement.toolName, measurement.labelCode),
              })}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    )}
  </section>
  );
};

export default MeasurementsPanel;
