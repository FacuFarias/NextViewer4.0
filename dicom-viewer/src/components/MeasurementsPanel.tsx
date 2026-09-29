import React from 'react';
import type { ViewerMeasurement } from '../hooks/useDicomViewer';
import type { PresentationState } from '../types/presentationState';

interface MeasurementsPanelProps {
  measurements: ViewerMeasurement[];
  currentImageIndex: number;
  onMeasurementSelect: (measurement: ViewerMeasurement) => void;
  onMeasurementRemove: (annotationUID: string) => void;
  presentationStates?: PresentationState[];
  activeSopInstanceUID?: string;
  activeFrameNumber?: number;
  activePresentationStateUID?: string | null;
  onPresentationStateApply?: (state: PresentationState | null) => void;
  onPresentationStateSave?: () => Promise<void>;
}

const MeasurementsPanel: React.FC<MeasurementsPanelProps> = ({
  measurements,
  currentImageIndex,
  onMeasurementSelect,
  onMeasurementRemove,
  presentationStates = [], activeSopInstanceUID, activeFrameNumber, activePresentationStateUID,
  onPresentationStateApply, onPresentationStateSave,
}) => (
  <section className="measurements-panel" aria-label="Mediciones realizadas">
    <div className="measurements-panel-header">
      <span>Mediciones</span>
      <span className="measurements-panel-count">{measurements.length}</span>
    </div>
    {measurements.length === 0 ? (
      <p className="measurements-empty">Las medidas que realices aparecerán aquí. Selecciona una y pulsa Delete para eliminarla.</p>
    ) : (
      <div className="measurements-list">
        {measurements.map(measurement => (
          <div
            key={measurement.annotationUID}
            className={`measurement-item${measurement.selected ? ' selected' : ''}${measurement.imageIndex === currentImageIndex ? ' active' : ''}`}
          >
            <button
              type="button"
              className="measurement-select-btn"
              onClick={() => onMeasurementSelect(measurement)}
              title="Seleccionar medida"
              aria-pressed={measurement.selected}
            >
              <span className="measurement-tool-name">
                <span className="measurement-color" style={{ backgroundColor: measurement.color }} />
                {measurement.label}
              </span>
              <span className="measurement-details">
                {measurement.imageIndex >= 0 ? `Imagen ${measurement.imageIndex + 1}` : 'Otra imagen'}
              </span>
              <span className="measurement-value">{measurement.value}</span>
            </button>
            <button
              type="button"
              className="measurement-delete-btn"
              onClick={() => onMeasurementRemove(measurement.annotationUID)}
              title="Eliminar medida"
              aria-label={`Eliminar ${measurement.label}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    )}
    {onPresentationStateSave && <section className="presentation-state-panel" aria-label="Presentation States">
      <div className="measurements-panel-header"><span>Presentation State</span><span className="measurements-panel-count">{presentationStates.length}</span></div>
      <button type="button" className="measurement-save-btn" onClick={() => void onPresentationStateSave()} disabled={!activeSopInstanceUID}>Guardar PR</button>
      {presentationStates.filter(item => item.referencedSopInstanceUID === activeSopInstanceUID && (!item.referencedFrameNumber || item.referencedFrameNumber === activeFrameNumber)).map(item => (
        <button type="button" key={item.sopInstanceUID} className={`presentation-state-item${item.sopInstanceUID === activePresentationStateUID ? ' active' : ''}`} onClick={() => onPresentationStateApply?.(item)}>
          {item.creationDate} {item.creationTime.slice(0, 6)}
        </button>
      ))}
      {activePresentationStateUID && <button type="button" className="presentation-state-item" onClick={() => onPresentationStateApply?.(null)}>Vista original</button>}
    </section>}
  </section>
);

export default MeasurementsPanel;
