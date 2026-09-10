export interface ViewerConfig {
  mprEnabled: boolean;
  downloadEnabled: boolean;
  annotationsEnabled: boolean;
  windowLevelPresetsEnabled: boolean;
  filmstripEnabled: boolean;
}

export const DEFAULT_CONFIG: ViewerConfig = {
  mprEnabled: true,
  downloadEnabled: false,
  annotationsEnabled: true,
  windowLevelPresetsEnabled: true,
  filmstripEnabled: true,
};
