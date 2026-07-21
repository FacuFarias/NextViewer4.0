import React, { useState, useMemo } from 'react';
import { DicomStudy } from '../types/dicom';

interface StudyBrowserProps {
  studies: DicomStudy[];
  onStudySelect: (study: DicomStudy) => void;
  isLoading: boolean;
  onRefresh: () => void;
}

const MODALITIES = ['CT', 'MR', 'DX', 'US', 'MG', 'CR', 'NM', 'PT', 'XA', 'RF'];

const StudyBrowser: React.FC<StudyBrowserProps> = ({
  studies,
  onStudySelect,
  isLoading,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedModality, setSelectedModality] = useState<string>('');
  const [sortField, setSortField] = useState<'studyDate' | 'patientName' | 'modality'>('studyDate');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const filteredStudies = useMemo(() => {
    let filtered = studies.filter((study) => {
      const matchesSearch = !searchTerm || 
        study.patientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        study.patientID.toLowerCase().includes(searchTerm.toLowerCase()) ||
        study.studyDescription.toLowerCase().includes(searchTerm.toLowerCase()) ||
        study.studyDate.includes(searchTerm) ||
        (study.accessionNumber && study.accessionNumber.includes(searchTerm));

      const matchesModality = !selectedModality || 
        study.modality.includes(selectedModality);

      return matchesSearch && matchesModality;
    });

    filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'studyDate':
          comparison = (a.studyDate || '').localeCompare(b.studyDate || '');
          break;
        case 'patientName':
          comparison = (a.patientName || '').localeCompare(b.patientName || '');
          break;
        case 'modality':
          comparison = (a.modality || '').localeCompare(b.modality || '');
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [studies, searchTerm, selectedModality, sortField, sortDirection]);

  const handleSort = (field: 'studyDate' | 'patientName' | 'modality') => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const formatDate = (date: string): string => {
    if (!date || date.length !== 8) return date;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  };

  const getSortIcon = (field: string) => {
    if (sortField !== field) return '↕';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  return (
    <div className="study-browser">
      <div className="study-browser-header">
        <h2>Estudios</h2>
        <button className="refresh-btn" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? '⟳' : '↻'} Actualizar
        </button>
      </div>

      <div className="study-browser-filters">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Buscar por nombre, ID, descripción..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          {searchTerm && (
            <button className="clear-search" onClick={() => setSearchTerm('')}>×</button>
          )}
        </div>

        <div className="modality-filters">
          <button
            className={`modality-chip ${!selectedModality ? 'active' : ''}`}
            onClick={() => setSelectedModality('')}
          >
            Todos
          </button>
          {MODALITIES.map(mod => (
            <button
              key={mod}
              className={`modality-chip ${selectedModality === mod ? 'active' : ''}`}
              onClick={() => setSelectedModality(selectedModality === mod ? '' : mod)}
            >
              {mod}
            </button>
          ))}
        </div>
      </div>

      <div className="study-browser-stats">
        {filteredStudies.length} de {studies.length} estudios
      </div>

      <div className="study-table-container">
        {isLoading && studies.length === 0 ? (
          <div className="loading-state">
            <div className="loading-spinner"></div>
            <p>Cargando estudios...</p>
          </div>
        ) : filteredStudies.length === 0 ? (
          <div className="empty-state">
            <p>No se encontraron estudios</p>
            {searchTerm && (
              <button className="clear-filters-btn" onClick={() => setSearchTerm('')}>
                Limpiar filtros
              </button>
            )}
          </div>
        ) : (
          <table className="study-table">
            <thead>
              <tr>
                <th onClick={() => handleSort('patientName')} className="sortable">
                  Paciente {getSortIcon('patientName')}
                </th>
                <th>ID</th>
                <th onClick={() => handleSort('studyDate')} className="sortable">
                  Fecha {getSortIcon('studyDate')}
                </th>
                <th onClick={() => handleSort('modality')} className="sortable">
                  Modal. {getSortIcon('modality')}
                </th>
                <th>Descripción</th>
                <th>Acceso</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredStudies.map((study) => (
                <tr
                  key={study.studyInstanceUID}
                  className="study-row"
                  onClick={() => onStudySelect(study)}
                >
                  <td className="patient-name-cell">
                    <span className="patient-name">{study.patientName || 'Sin nombre'}</span>
                    {study.patientSex && (
                      <span className="patient-sex">{study.patientSex}</span>
                    )}
                  </td>
                  <td className="patient-id-cell">{study.patientID}</td>
                  <td className="date-cell">{formatDate(study.studyDate)}</td>
                  <td className="modality-cell">
                    <span className="modality-badge">{study.modality}</span>
                  </td>
                  <td className="description-cell">{study.studyDescription || '-'}</td>
                  <td className="accession-cell">{study.accessionNumber || '-'}</td>
                  <td className="action-cell">
                    <button className="view-btn" title="Ver estudio">
                      👁
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default StudyBrowser;
