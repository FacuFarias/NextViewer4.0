import React from 'react';
import { DicomStudy, DicomInstance } from '../types/dicom';
import { getMeasurementUnit } from '../services/measurementCalibration';

interface DicomOverlayProps {
  study: DicomStudy | null;
  instance: DicomInstance | null;
  imageIndex: number;
  totalImages: number;
  windowLevel: { windowWidth: number; windowCenter: number };
}

const formatDate = (date: string): string => {
  if (!date || date.length !== 8) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
};

const DicomOverlay: React.FC<DicomOverlayProps> = ({
  study,
  instance,
  imageIndex,
  totalImages,
  windowLevel,
}) => {
  if (!study) return null;

  return (
    <div className="dicom-overlay">
      <div className="overlay-top-left">
        <div className="overlay-row">
          <span className="overlay-label">Paciente:</span>
          <span className="overlay-value">{study.patientName || 'N/A'}</span>
        </div>
        <div className="overlay-row">
          <span className="overlay-label">ID:</span>
          <span className="overlay-value">{study.patientID || 'N/A'}</span>
        </div>
        {study.patientBirthDate && (
          <div className="overlay-row overlay-secondary">
            <span className="overlay-label">Nacimiento:</span>
            <span className="overlay-value">{formatDate(study.patientBirthDate)}</span>
          </div>
        )}
        {study.patientSex && (
          <div className="overlay-row overlay-secondary">
            <span className="overlay-label">Sexo:</span>
            <span className="overlay-value">{study.patientSex}</span>
          </div>
        )}
      </div>

      <div className="overlay-top-right">
        <div className="overlay-row overlay-secondary">
          <span className="overlay-label">Descripción:</span>
          <span className="overlay-value">{study.studyDescription || 'N/A'}</span>
        </div>
        <div className="overlay-row">
          <span className="overlay-label">Fecha:</span>
          <span className="overlay-value">{formatDate(study.studyDate)}</span>
        </div>
        <div className="overlay-row">
          <span className="overlay-label">Modalidad:</span>
          <span className="overlay-value">{study.modality}</span>
        </div>
      </div>

      <div className="overlay-bottom-left">
        {instance && (
          <>
            <div className="overlay-row">
              <span className="overlay-label">Im:</span>
              <span className="overlay-value">{imageIndex + 1}/{totalImages}</span>
            </div>
            <div className="overlay-row overlay-secondary">
              <span className="overlay-label">Tamaño:</span>
              <span className="overlay-value">{instance.rows}x{instance.columns}</span>
            </div>
            <div className="overlay-row overlay-secondary">
              <span className="overlay-label">Bits:</span>
              <span className="overlay-value">{instance.bitsAllocated}</span>
            </div>
            <div className="overlay-row">
              <span className="overlay-label">Medición:</span>
              <span className="overlay-value">{getMeasurementUnit(instance.pixelSpacing)}</span>
            </div>
          </>
        )}
      </div>

      <div className="overlay-bottom-right">
        <div className="overlay-row">
          <span className="overlay-label">W:</span>
          <span className="overlay-value">{Math.round(windowLevel.windowWidth)}</span>
        </div>
        <div className="overlay-row">
          <span className="overlay-label">L:</span>
          <span className="overlay-value">{Math.round(windowLevel.windowCenter)}</span>
        </div>
        {instance?.photometricInterpretation && (
          <div className="overlay-row overlay-secondary">
            <span className="overlay-value">{instance.photometricInterpretation}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default DicomOverlay;
