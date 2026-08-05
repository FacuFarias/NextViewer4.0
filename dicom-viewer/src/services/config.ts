import { ViewerConfig, DEFAULT_CONFIG, FeatureKey, Language } from '../types/config';

const CONFIG_KEY = 'dicom-viewer-config';

function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'es';
}

export function getConfig(): ViewerConfig {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        language: isLanguage(parsed?.language) ? parsed.language : DEFAULT_CONFIG.language,
      };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return { ...DEFAULT_CONFIG };
}

export function updateConfig(config: Partial<ViewerConfig>): ViewerConfig {
  const current = getConfig();
  const updated = { ...current, ...config };
  
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save config:', error);
  }
  
  return updated;
}

export function resetConfig(): ViewerConfig {
  try {
    localStorage.removeItem(CONFIG_KEY);
  } catch (error) {
    console.error('Failed to reset config:', error);
  }
  return { ...DEFAULT_CONFIG };
}

export function isFeatureEnabled(feature: FeatureKey): boolean {
  const config = getConfig();
  return config[feature];
}
