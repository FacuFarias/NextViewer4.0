import React, { useState } from 'react';
import { DicomStudy, DicomSeries } from '../types/dicom';
import { downloadSeriesAsZip, downloadStudyAsZip } from '../services/download';

interface DownloadButtonProps {
  study: DicomStudy;
  currentSeries: DicomSeries | null;
}

const DownloadButton: React.FC<DownloadButtonProps> = ({ study, currentSeries }) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const handleDownloadSeries = async () => {
    if (!currentSeries) return;

    setIsDownloading(true);
    setProgress({ current: 0, total: currentSeries.instances.length });

    try {
      await downloadSeriesAsZip(
        study.studyInstanceUID,
        currentSeries,
        (current, total) => {
          setProgress({ current, total });
        }
      );
    } catch (error) {
      console.error('Download failed:', error);
      alert('Error al descargar la serie');
    } finally {
      setIsDownloading(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const handleDownloadAll = async () => {
    setIsDownloading(true);
    setProgress({ current: 0, total: study.numberOfInstances || 0 });
    try {
      await downloadStudyAsZip(study, (current, total) => setProgress({ current, total }));
    } catch (error) {
      console.error('Download failed:', error);
      alert('Error al descargar el estudio');
    } finally {
      setIsDownloading(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  return (
    <div className="download-section">
      <h4>Descargar</h4>
      
      {currentSeries && (
        <button
          className="download-btn"
          onClick={handleDownloadSeries}
          disabled={isDownloading}
        >
          {isDownloading ? (
            <>
              <span className="download-spinner"></span>
              Descargando... {progress.current}/{progress.total}
            </>
          ) : (
            <>
              📥 Serie actual ({currentSeries.instances.length} imgs)
            </>
          )}
        </button>
      )}

      <button
        className="download-btn download-btn-all"
        onClick={handleDownloadAll}
        disabled={isDownloading}
      >
        {isDownloading ? (
          <>
            <span className="download-spinner"></span>
            Descargando... {progress.current}/{progress.total}
          </>
        ) : (
          <>
            📦 Todo el estudio
          </>
        )}
      </button>

      {isDownloading && (
        <div className="download-progress">
          <div 
            className="download-progress-bar"
            style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
          />
        </div>
      )}
    </div>
  );
};

export default DownloadButton;
