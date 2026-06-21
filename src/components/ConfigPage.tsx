import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ViewerConfig } from '../types/config';
import { getConfig, updateConfig, resetConfig } from '../services/config';
import { getCurrentUser } from '../services/auth';

const ConfigPage: React.FC = () => {
  const navigate = useNavigate();
  const [config, setConfig] = useState<ViewerConfig>(getConfig());
  const [saved, setSaved] = useState(false);
  const username = getCurrentUser();

  useEffect(() => {
    setConfig(getConfig());
  }, []);

  const handleToggle = (key: keyof ViewerConfig) => {
    setConfig(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
    setSaved(false);
  };

  const handleSave = () => {
    updateConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    const defaultConfig = resetConfig();
    setConfig(defaultConfig);
    setSaved(false);
  };

  const features: Array<{ key: keyof ViewerConfig; label: string; description: string; icon: string }> = [
    {
      key: 'mprEnabled',
      label: 'MPR (Multi-Planar Reconstruction)',
      description: 'Permite visualizar imágenes CT en tres planos: axial, sagital y coronal',
      icon: '🔬',
    },
    {
      key: 'downloadEnabled',
      label: 'Descargar DICOM',
      description: 'Permite descargar archivos DICOM al equipo local',
      icon: '📥',
    },
    {
      key: 'annotationsEnabled',
      label: 'Herramientas de Medición',
      description: 'Permite crear anotaciones como medidas, flechas, círculos y ángulos',
      icon: '📏',
    },
    {
      key: 'windowLevelPresetsEnabled',
      label: 'Presets de Window/Level',
      description: 'Muestra los presets predefinidos de window/level en la barra de herramientas',
      icon: '🎚️',
    },
    {
      key: 'filmstripEnabled',
      label: 'Filmstrip de Imágenes',
      description: 'Muestra la barra lateral de miniaturas para navegar entre imágenes',
      icon: '🎞️',
    },
  ];

  return (
    <div className="config-page">
      <header className="config-header">
        <div className="config-header-left">
          <button className="config-back-btn" onClick={() => navigate('/')}>
            ← Volver
          </button>
          <h1>Configuración del Visor</h1>
        </div>
        <div className="config-header-right">
          <span className="config-user-badge">
            👤 {username || 'Administrador'}
          </span>
        </div>
      </header>

      <main className="config-content">
        <div className="config-section">
          <h2>Funcionalidades del Visor</h2>
          <p className="config-description">
            Active o desactive las funcionalidades disponibles en el visor DICOM.
          </p>

          <div className="config-features-list">
            {features.map(feature => (
              <div key={feature.key} className="config-feature-item">
                <div className="config-feature-info">
                  <span className="config-feature-icon">{feature.icon}</span>
                  <div className="config-feature-text">
                    <h3>{feature.label}</h3>
                    <p>{feature.description}</p>
                  </div>
                </div>
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={config[feature.key]}
                    onChange={() => handleToggle(feature.key)}
                  />
                  <span className="config-toggle-slider"></span>
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="config-actions">
          <button className="config-btn config-btn-secondary" onClick={handleReset}>
            Restablecer Valores
          </button>
          <button className="config-btn config-btn-primary" onClick={handleSave}>
            {saved ? '✓ Guardado' : 'Guardar Cambios'}
          </button>
        </div>

        {saved && (
          <div className="config-success-message">
            Configuración guardada exitosamente
          </div>
        )}
      </main>
    </div>
  );
};

export default ConfigPage;
