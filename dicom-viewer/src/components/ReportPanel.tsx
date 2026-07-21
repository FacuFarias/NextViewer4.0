import React, { useState, useEffect } from 'react';
import { getReport, saveReport, deleteReport } from '../services/report';

interface ReportPanelProps {
  studyInstanceUID: string;
  patientID?: string;
  accessionNumber?: string;
}

const ReportPanel: React.FC<ReportPanelProps> = ({ 
  studyInstanceUID, 
  patientID,
  accessionNumber 
}) => {
  const [report, setReport] = useState('');
  const [reportId, setReportId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadReport();
  }, [studyInstanceUID]);

  const loadReport = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const existing = await getReport(studyInstanceUID);
      if (existing) {
        setReport(existing.report || '');
        setReportId(existing.id);
      } else {
        setReport('');
        setReportId(null);
      }
    } catch (err) {
      console.error('Failed to load report:', err);
      setError('Error al cargar reporte');
    } finally {
      setLoading(false);
      setSaved(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await saveReport(
        studyInstanceUID,
        report,
        patientID,
        accessionNumber
      );
      
      if (result) {
        setReportId(result.id);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError('Error al guardar');
      }
    } catch (err) {
      console.error('Failed to save report:', err);
      setError('Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (confirm('¿Está seguro de limpiar el reporte?')) {
      setReport('');
      if (reportId) {
        await deleteReport(reportId);
        setReportId(null);
      }
    }
  };

  return (
    <div className="report-panel">
      <div className="report-header">
        <h4>Reporte</h4>
        {saved && <span className="report-saved-badge">✓ Guardado</span>}
        {loading && <span className="report-loading-badge">Guardando...</span>}
      </div>
      
      {error && (
        <div className="report-error">{error}</div>
      )}
      
      <textarea
        className="report-textarea"
        value={report}
        onChange={(e) => {
          setReport(e.target.value);
          setSaved(false);
        }}
        placeholder="Escriba su reporte aquí..."
        rows={8}
        disabled={loading}
      />
      
      <div className="report-actions">
        <button 
          className="report-btn report-btn-clear" 
          onClick={handleClear}
          disabled={loading}
        >
          Limpiar
        </button>
        <button 
          className="report-btn report-btn-save" 
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? 'Guardando...' : '💾 Guardar'}
        </button>
      </div>
    </div>
  );
};

export default ReportPanel;
