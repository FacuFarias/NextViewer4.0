export type Language = 'en' | 'es';

export type FeatureKey =
  | 'mprEnabled'
  | 'downloadEnabled'
  | 'annotationsEnabled'
  | 'windowLevelPresetsEnabled'
  | 'filmstripEnabled'
  | 'reportServiceEnabled'
  | 'ctSinusesMinicatMeasurementsEnabled'
  | 'nasalSeptumDeviationEnabled';

export interface ViewerConfig {
  language: Language;
  mprEnabled: boolean;
  downloadEnabled: boolean;
  annotationsEnabled: boolean;
  windowLevelPresetsEnabled: boolean;
  filmstripEnabled: boolean;
  reportServiceEnabled: boolean;
  ctSinusesMinicatMeasurementsEnabled: boolean;
  nasalSeptumDeviationEnabled: boolean;
}

export const DEFAULT_CONFIG: ViewerConfig = {
  language: 'en',
  mprEnabled: true,
  downloadEnabled: true,
  annotationsEnabled: true,
  windowLevelPresetsEnabled: true,
  filmstripEnabled: true,
  reportServiceEnabled: true,
  ctSinusesMinicatMeasurementsEnabled: false,
  nasalSeptumDeviationEnabled: true,
};
