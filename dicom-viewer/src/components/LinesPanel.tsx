import React, { useState } from 'react';
import {
  NASAL_SEPTUM_DEVIATION_COLOR,
} from '../services/nasalSeptumDeviation';
import { useTranslation } from '../i18n';

interface LinesPanelProps {
  active: boolean;
  enabled: boolean;
  onFeatureSelect: () => void;
}

const LinesPanel: React.FC<LinesPanelProps> = ({ active, enabled, onFeatureSelect }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(true);

  if (!enabled) return null;

  return (
    <section className="lines-panel">
      <button
        type="button"
        className="lines-panel-header"
        onClick={() => setIsOpen(open => !open)}
        aria-expanded={isOpen}
      >
        <span>{t('lines.title')}</span>
        <span className="lines-panel-toggle">{isOpen ? '▾' : '▸'}</span>
      </button>
      <div className={`lines-panel-content ${isOpen ? 'open' : ''}`}>
        <button
          type="button"
          className={`lines-feature-btn ${active ? 'active' : ''}`}
          onClick={onFeatureSelect}
          title={t('lines.measure', { feature: t('measurement.nasalSeptum') })}
        >
          <span
            className="lines-feature-color"
            style={{ backgroundColor: NASAL_SEPTUM_DEVIATION_COLOR }}
          />
          <span>{t('measurement.nasalSeptum')}</span>
        </button>
        <p className="lines-feature-hint">
          {t('lines.hint')}
        </p>
      </div>
    </section>
  );
};

export default LinesPanel;
