import React, { useState, useEffect } from 'react';
import { getReport, saveReport, deleteReport } from '../services/report';
import { useTranslation } from '../i18n';

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
  const { t } = useTranslation();
  const [report, setReport] = useState('');
  const [reportId, setReportId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadReport();
  }, [studyInstanceUID, t]);

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
      setError(t('report.loadError'));
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
        setError(t('report.saveError'));
      }
    } catch (err) {
      console.error('Failed to save report:', err);
      setError(t('report.saveError'));
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (confirm(t('report.clearConfirm'))) {
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
        <h4>{t('report.title')}</h4>
        {saved && <span className="report-saved-badge">{t('report.saved')}</span>}
        {loading && <span className="report-loading-badge">{t('report.saving')}</span>}
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
        placeholder={t('report.placeholder')}
        rows={8}
        disabled={loading}
      />
      
      <div className="report-actions">
        <button 
          className="report-btn report-btn-clear" 
          onClick={handleClear}
          disabled={loading}
        >
          {t('report.clear')}
        </button>
        <button 
          className="report-btn report-btn-save" 
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? t('report.saving') : t('report.save')}
        </button>
      </div>
    </div>
  );
};

export default ReportPanel;
