import React, { useState } from 'react';
import { WindowLevel } from '../types/dicom';
import { getConfig } from '../services/config';
import { useTranslation } from '../i18n';
import {
  IconWindowLevel,
  IconLength,
  IconArrow,
  IconCircle,
  IconAngle,
  IconBidirectional,
  IconRectangle,
  IconReset,
  IconInvert,
} from './Icons';

interface ToolbarProps {
  windowLevel: WindowLevel;
  onWindowLevelChange: (windowWidth: number, windowCenter: number) => void;
  modality?: string;
}

interface WindowPreset {
  name: string;
  width: number;
  center: number;
  modalities: string[];
}

const WINDOW_PRESETS: WindowPreset[] = [
  { name: 'Abdomen', width: 400, center: 40, modalities: ['CT'] },
  { name: 'Hueso', width: 2000, center: 300, modalities: ['CT'] },
  { name: 'Pulmón', width: 1500, center: -600, modalities: ['CT'] },
  { name: 'Cerebro', width: 80, center: 40, modalities: ['CT', 'MR'] },
  { name: 'Subdural', width: 200, center: 75, modalities: ['CT'] },
  { name: 'Hematoma', width: 200, center: 50, modalities: ['CT'] },
  { name: 'Tejido blando', width: 400, center: 40, modalities: ['CT', 'MR'] },
  { name: 'Rodilla MR', width: 2000, center: 1000, modalities: ['MR'] },
  { name: 'Cerebro MR', width: 800, center: 400, modalities: ['MR'] },
  { name: 'Tórax RX', width: 2500, center: 500, modalities: ['DX', 'CR'] },
  { name: 'Mamografía', width: 4000, center: 2000, modalities: ['MG'] },
  { name: 'Genérico', width: 4096, center: 2048, modalities: [] },
];

const WINDOW_PRESET_TRANSLATION_KEYS: Record<string, string> = {
  Abdomen: 'toolbar.preset.abdomen',
  Hueso: 'toolbar.preset.bone',
  Pulmón: 'toolbar.preset.lung',
  Cerebro: 'toolbar.preset.brain',
  Subdural: 'toolbar.preset.subdural',
  Hematoma: 'toolbar.preset.hematoma',
  'Tejido blando': 'toolbar.preset.softTissue',
  'Rodilla MR': 'toolbar.preset.kneeMr',
  'Cerebro MR': 'toolbar.preset.brainMr',
  'Tórax RX': 'toolbar.preset.chestXray',
  Mamografía: 'toolbar.preset.mammography',
  Genérico: 'toolbar.preset.generic',
};

export const ANNOTATION_TOOLS = [
  { name: 'WindowLevel', Icon: IconWindowLevel, titleKey: 'toolbar.windowLevel' },
  { name: 'Length', Icon: IconLength, titleKey: 'toolbar.measureDistance' },
  { name: 'ArrowAnnotate', Icon: IconArrow, titleKey: 'toolbar.arrow' },
  { name: 'CircleROI', Icon: IconCircle, titleKey: 'toolbar.circularRoi' },
  { name: 'Angle', Icon: IconAngle, titleKey: 'toolbar.angle' },
  { name: 'Bidirectional', Icon: IconBidirectional, titleKey: 'toolbar.bidirectional' },
  { name: 'Rectangle', Icon: IconRectangle, titleKey: 'toolbar.rectangle' },
];

export const AnnotationToolbar: React.FC<{
  activeTool?: string;
  onToolChange?: (toolName: string) => void;
  onResetView?: () => void;
  onInvertColors?: () => void;
}> = ({ activeTool = 'WindowLevel', onToolChange, onResetView, onInvertColors }) => {
  const { t } = useTranslation();
  const config = getConfig();

  return (
    <div className="annotation-toolbar">
      {config.annotationsEnabled && ANNOTATION_TOOLS.map(({ name, Icon, titleKey }) => (
        <button
          key={name}
          className={`annotation-icon-btn ${activeTool === name ? 'active' : ''}`}
          onClick={() => onToolChange?.(name)}
          title={t(titleKey)}
        >
          <Icon className="annotation-icon" />
        </button>
      ))}
      
      <div className="toolbar-divider" />
      
      <button
        className="annotation-icon-btn"
        onClick={onResetView}
        title={t('toolbar.resetView')}
      >
        <IconReset className="annotation-icon" />
      </button>
      
      <button
        className="annotation-icon-btn"
        onClick={onInvertColors}
        title={t('toolbar.invertColors')}
      >
        <IconInvert className="annotation-icon" />
      </button>

      <div
        id="mpr-annotation-toolbar-slot"
        className="annotation-toolbar-mpr-slot"
        aria-label="Controles MPR"
      />
    </div>
  );
};

const Toolbar: React.FC<ToolbarProps> = ({
  windowLevel,
  onWindowLevelChange,
  modality,
}) => {
  const { t } = useTranslation();
  const [showPresets, setShowPresets] = useState(false);
  const config = getConfig();

  const filteredPresets = WINDOW_PRESETS.filter(preset => 
    preset.modalities.length === 0 || 
    !modality || 
    preset.modalities.includes(modality)
  );

  const handleWindowWidthChange = (value: number) => {
    onWindowLevelChange(Math.max(1, value), windowLevel.windowCenter);
  };

  const handleWindowCenterChange = (value: number) => {
    onWindowLevelChange(windowLevel.windowWidth, value);
  };

  return (
    <div className="toolbar">
      <div className="toolbar-section">
        <h4>{t('toolbar.windowLevel')}</h4>
        <div className="wl-controls">
          <div className="wl-control">
            <label>
              <span className="control-label">W:</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={Math.round(windowLevel.windowWidth)}
                onChange={(e) => handleWindowWidthChange(parseInt(e.target.value) || 1)}
                className="wl-input"
              />
            </label>
            <input
              type="range"
              min="1"
              max="4096"
              value={Math.min(windowLevel.windowWidth, 4096)}
              onChange={(e) => handleWindowWidthChange(parseInt(e.target.value))}
              className="wl-slider"
            />
          </div>
          <div className="wl-control">
            <label>
              <span className="control-label">L:</span>
              <input
                type="number"
                min="-1024"
                max="65535"
                value={Math.round(windowLevel.windowCenter)}
                onChange={(e) => handleWindowCenterChange(parseInt(e.target.value) || 0)}
                className="wl-input"
              />
            </label>
            <input
              type="range"
              min="-1024"
              max="3000"
              value={windowLevel.windowCenter}
              onChange={(e) => handleWindowCenterChange(parseInt(e.target.value))}
              className="wl-slider"
            />
          </div>
        </div>
      </div>

      {config.windowLevelPresetsEnabled && (
        <div className="toolbar-section">
          <div className="presets-header">
            <h4>{t('toolbar.presets')}</h4>
            <button 
              className="toggle-presets"
              onClick={() => setShowPresets(!showPresets)}
            >
              {showPresets ? '▲' : '▼'}
            </button>
          </div>
          {showPresets && (
            <div className="presets-grid">
              {filteredPresets.map((preset) => (
                <button
                  key={preset.name}
                  className={`preset-btn ${windowLevel.windowWidth === preset.width && windowLevel.windowCenter === preset.center ? 'active' : ''}`}
                  onClick={() => onWindowLevelChange(preset.width, preset.center)}
                  title={t('toolbar.windowTitle', { width: preset.width, center: preset.center })}
                >
                  {t(WINDOW_PRESET_TRANSLATION_KEYS[preset.name] || 'toolbar.preset.generic')}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Toolbar;
