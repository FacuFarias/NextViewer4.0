import React, { useState, useEffect } from 'react';

interface ReportPanelProps {
  studyInstanceUID: string;
  seriesInstanceUID?: string;
}

const STORAGE_KEY = 'dicom-viewer-reports';

const ReportPanel: React.FC<ReportPanelProps> = ({ studyInstanceUID, seriesInstanceUID }) => {
  const [report, setReport] = useState('');
  const [saved, setSaved] = useState(false);
  const reportKey = seriesInstanceUID 
    ? `${studyInstanceUID}_${seriesInstanceUID}` 
    : studyInstanceUID;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const reports = JSON.parse(stored);
        setReport(reports[reportKey] || '');
      }
    } catch (error) {
      console.error('Failed to load report:', error);
    }
    setSaved(false);
  }, [reportKey]);

  const handleSave = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const reports = stored ? JSON.parse(stored) : {};
      reports[reportKey] = report;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('Failed to save report:', error);
    }
  };

  const handleClear = () => {
    if (confirm('¿Está seguro de limpiar el reporte?')) {
      setReport('');
      handleSave();
    }
  };

  return (
    <div className="report-panel">
      <div className="report-header">
        <h4>Reporte</h4>
        {saved && <span className="report-saved-badge">✓ Guardado</span>}
      </div>
      
      <textarea
        className="report-textarea"
        value={report}
        onChange={(e) => {
          setReport(e.target.value);
          setSaved(false);
        }}
        placeholder="Escriba su reporte aquí..."
        rows={8}
      />
      
      <div className="report-actions">
        <button className="report-btn report-btn-clear" onClick={handleClear}>
          Limpiar
        </button>
        <button className="report-btn report-btn-save" onClick={handleSave}>
          💾 Guardar
        </button>
      </div>
    </div>
  );
};

export default ReportPanel;
