import type { DicomWebConfig } from '../types/dicom';
import type { RuntimeConfig } from '../types/runtimeConfig';
import type { ViewerRequest } from './viewerRequest';

export function resolveDicomWebConfig(
  runtime: RuntimeConfig,
  request: Pick<ViewerRequest, 'shareToken'>
): DicomWebConfig {
  if (request.shareToken) {
    const root = `${runtime.shareGatewayRoot.replace(/\/$/, '')}/${encodeURIComponent(request.shareToken)}`;
    return {
      baseUrl: `${root}/dcm4chee-arc/aets/DCM4CHEE/rs`,
      wadoUrl: `${root}/dcm4chee-arc/aets/DCM4CHEE/wado`,
    };
  }
  return { baseUrl: runtime.dicomWebRoot, wadoUrl: runtime.wadoUriRoot };
}
