import React, { useState } from 'react';
import {
  CT_SINUSES_FEATURES,
  CtSinusesFeature,
} from '../services/ctSinusesMeasurements';
import { useTranslation } from '../i18n';

interface CtSinusesFeaturePanelProps {
  selectedFeatureKey: string | null;
  onFeatureSelect: (feature: CtSinusesFeature) => void;
}

const CtSinusesFeaturePanel: React.FC<CtSinusesFeaturePanelProps> = ({
  selectedFeatureKey,
  onFeatureSelect,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="ct-sinuses-feature-panel">
      <button
        type="button"
        className="ct-sinuses-feature-header"
        onClick={() => setIsOpen(open => !open)}
        aria-expanded={isOpen}
      >
        <span>{t('ct.polygons')}</span>
        <span className="ct-sinuses-feature-toggle">{isOpen ? '▾' : '▸'}</span>
      </button>
      <div className={`ct-sinuses-feature-content ${isOpen ? 'open' : ''}`}>
        <div className="ct-sinuses-feature-list">
          {CT_SINUSES_FEATURES.map(feature => (
            <button
              key={feature.key}
              type="button"
              className={`ct-sinuses-feature-btn ${selectedFeatureKey === feature.key ? 'active' : ''}`}
              onClick={() => onFeatureSelect(feature)}
              title={t('ct.mark', { feature: t(`ctFeature.${feature.key}`) })}
            >
              <span
                className="ct-sinuses-feature-color"
                style={{ backgroundColor: feature.color }}
              />
              <span>{t(`ctFeature.${feature.key}`)}</span>
            </button>
          ))}
        </div>
        <p className="ct-sinuses-feature-hint">
          {t('ct.hint')}
        </p>
      </div>
    </section>
  );
};

export default CtSinusesFeaturePanel;
