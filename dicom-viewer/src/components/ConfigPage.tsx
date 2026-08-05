import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ViewerConfig, FeatureKey, Language } from '../types/config';
import { getConfig, updateConfig, resetConfig } from '../services/config';
import { getCurrentUser } from '../services/auth';
import { useTranslation } from '../i18n';

const ConfigPage: React.FC = () => {
  const navigate = useNavigate();
  const { language, setLanguage, t } = useTranslation();
  const [config, setConfig] = useState<ViewerConfig>(getConfig());
  const [saved, setSaved] = useState(false);
  const username = getCurrentUser();

  useEffect(() => {
    setConfig(getConfig());
  }, []);

  const handleToggle = (key: FeatureKey) => {
    const nextConfig = {
      ...config,
      [key]: !config[key],
    };

    setConfig(nextConfig);
    updateConfig({ [key]: nextConfig[key] } as Partial<ViewerConfig>);
    setSaved(false);
  };

  const handleLanguageChange = (nextLanguage: Language) => {
    setLanguage(nextLanguage);
    setConfig(prev => ({ ...prev, language: nextLanguage }));
    setSaved(false);
  };

  const handleSave = () => {
    updateConfig({ ...config, language });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    const defaultConfig = resetConfig();
    setLanguage(defaultConfig.language);
    setConfig(defaultConfig);
    setSaved(false);
  };

  const features: Array<{ key: FeatureKey; label: string; description: string; icon: string }> = [
    {
      key: 'downloadEnabled',
      label: t('config.feature.download'),
      description: t('config.feature.downloadDescription'),
      icon: '📥',
    },
    {
      key: 'annotationsEnabled',
      label: t('config.feature.annotations'),
      description: t('config.feature.annotationsDescription'),
      icon: '📏',
    },
    {
      key: 'windowLevelPresetsEnabled',
      label: t('config.feature.presets'),
      description: t('config.feature.presetsDescription'),
      icon: '🎚️',
    },
    {
      key: 'filmstripEnabled',
      label: t('config.feature.filmstrip'),
      description: t('config.feature.filmstripDescription'),
      icon: '🎞️',
    },
    {
      key: 'reportServiceEnabled',
      label: t('config.feature.reports'),
      description: t('config.feature.reportsDescription'),
      icon: '📝',
    },
    {
      key: 'ctSinusesMinicatMeasurementsEnabled',
      label: t('config.feature.ctSinuses'),
      description: t('config.feature.ctSinusesDescription'),
      icon: '🫁',
    },
    {
      key: 'nasalSeptumDeviationEnabled',
      label: t('config.feature.nasalSeptum'),
      description: t('config.feature.nasalSeptumDescription'),
      icon: '📐',
    },
  ];

  return (
    <div className="config-page">
      <header className="config-header">
        <div className="config-header-left">
          <button className="config-back-btn" onClick={() => navigate('/')}>
            {t('config.back')}
          </button>
          <h1>{t('config.title')}</h1>
        </div>
        <div className="config-header-right">
          <span className="config-user-badge">
            👤 {username || t('config.administrator')}
          </span>
        </div>
      </header>

      <main className="config-content">
        <div className="config-section config-language-section">
          <h2>{t('language.title')}</h2>
          <p className="config-description">{t('language.description')}</p>
          <label className="config-language-control">
            <span>{t('language.selectAria')}</span>
            <select
              value={language}
              aria-label={t('language.selectAria')}
              onChange={event => handleLanguageChange(event.target.value as Language)}
            >
              <option value="en">ENG — English</option>
              <option value="es">ESP — Español</option>
            </select>
          </label>
        </div>

        <div className="config-section">
          <h2>{t('config.featuresTitle')}</h2>
          <p className="config-description">{t('config.featuresDescription')}</p>

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
            {t('config.reset')}
          </button>
          <button className="config-btn config-btn-primary" onClick={handleSave}>
            {saved ? `✓ ${t('common.saved')}` : t('common.saveChanges')}
          </button>
        </div>

        {saved && (
          <div className="config-success-message">
            {t('config.savedMessage')}
          </div>
        )}
      </main>
    </div>
  );
};

export default ConfigPage;
