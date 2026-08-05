import React, { useState } from 'react';
import { DicomStudy, DicomSeries } from '../types/dicom';
import { downloadSeriesAsZip } from '../services/download';
import { useTranslation } from '../i18n';

interface DownloadButtonProps {
  study: DicomStudy;
  currentSeries: DicomSeries | null;
}

const DownloadButton: React.FC<DownloadButtonProps> = ({ study, currentSeries }) => {
  const { t } = useTranslation();
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
      alert(t('download.errorSeries'));
    } finally {
      setIsDownloading(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const handleDownloadAll = async () => {
    setIsDownloading(true);
    
    try {
      const JSZip = (await import('jszip')).default;
      const { saveAs } = await import('file-saver');
      const { DICOM_PASSWORD, DICOM_USERNAME, getAccessToken } = await import('../services/auth');
      const { dicomWebService } = await import('../services/dicomWeb');

      const seriesWithInstances: Array<{ series: DicomSeries; instances: any[] }> = [];
      
      for (const series of study.series) {
        const instances = await dicomWebService.getSeriesInstances(
          study.studyInstanceUID,
          series.seriesInstanceUID
        );
        seriesWithInstances.push({ series, instances });
      }

      let totalInstances = 0;
      seriesWithInstances.forEach(s => {
        totalInstances += s.instances.length;
      });
      
      setProgress({ current: 0, total: totalInstances });

      const zip = new JSZip();
      let downloaded = 0;

      for (const { series, instances } of seriesWithInstances) {
        const seriesName = `Serie_${series.seriesNumber || 1}_${series.seriesDescription || series.modality}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const folder = zip.folder(seriesName);
        if (!folder) continue;

        for (const instance of instances) {
          try {
            const token = await getAccessToken(DICOM_USERNAME, DICOM_PASSWORD);
            const wadoUrl = dicomWebService.getInstanceWadoUriUrl(
              study.studyInstanceUID,
              series.seriesInstanceUID,
              instance.sopInstanceUID
            );

            const response = await fetch(wadoUrl, {
              headers: { 'Authorization': `Bearer ${token}` },
            });

            if (response.ok) {
              const blob = await response.blob();
              folder.file(`${instance.sopInstanceUID}.dcm`, blob);
            }
            
            downloaded++;
            setProgress({ current: downloaded, total: totalInstances });
          } catch (error) {
            console.error(`Error downloading instance:`, error);
          }
        }
      }

      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
      });

      const patientName = study.patientName || study.patientID || 'study';
      const safeName = patientName.replace(/[^a-zA-Z0-9_-]/g, '_');
      saveAs(content, `${safeName}_${study.studyInstanceUID}.zip`);
    } catch (error) {
      console.error('Download failed:', error);
      alert(t('download.errorStudy'));
    } finally {
      setIsDownloading(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  return (
    <div className="download-section">
      <h4>{t('download.title')}</h4>
      
      {currentSeries && (
        <button
          className="download-btn"
          onClick={handleDownloadSeries}
          disabled={isDownloading}
        >
          {isDownloading ? (
            <>
              <span className="download-spinner"></span>
              {t('download.downloading', { current: progress.current, total: progress.total })}
            </>
          ) : (
            <>
              {t('download.currentSeries', { count: currentSeries.instances.length })}
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
            {t('download.downloading', { current: progress.current, total: progress.total })}
          </>
        ) : (
          <>
            {t('download.allStudy')}
          </>
        )}
      </button>

      {isDownloading && (
        <div className="download-progress">
          <div 
            className="download-progress-bar"
            style={{ width: `${(progress.current / progress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
};

export default DownloadButton;
