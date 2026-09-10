import { ViewerConfig, DEFAULT_CONFIG } from '../types/config';

const CONFIG_KEY = 'dicom-viewer-config';

export function getConfig(): ViewerConfig {
  const runtimeDownloadEnabled = window.__NEXTVIEWER_CONFIG__?.downloadEnabled;
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        downloadEnabled: typeof runtimeDownloadEnabled === 'boolean'
          ? runtimeDownloadEnabled
          : DEFAULT_CONFIG.downloadEnabled,
      };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return {
    ...DEFAULT_CONFIG,
    downloadEnabled: typeof runtimeDownloadEnabled === 'boolean'
      ? runtimeDownloadEnabled
      : DEFAULT_CONFIG.downloadEnabled,
  };
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

export function isFeatureEnabled(feature: keyof ViewerConfig): boolean {
  const config = getConfig();
  return config[feature];
}
