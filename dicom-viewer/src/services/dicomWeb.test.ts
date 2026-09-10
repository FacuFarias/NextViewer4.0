import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../types/runtimeConfig';
import { resolveDicomWebConfig } from './dicomSource';

const runtime: RuntimeConfig = {
  dicomWebRoot: '/staff/rs',
  wadoUriRoot: '/staff/wado',
  keycloakAuthority: 'https://identity.invalid/realms/clinical',
  keycloakClientId: 'viewer',
  tokenHandoffClientIds: 'dcm4chee-arc-ui,viewer',
  oidcRedirectUri: 'https://viewer.invalid/callback',
  oidcPostLogoutRedirectUri: 'https://viewer.invalid/',
  shareGatewayRoot: 'https://share.invalid/restricted/',
};

describe('DICOMweb source selection', () => {
  it('uses the protected staff endpoints without a share token', () => {
    expect(resolveDicomWebConfig(runtime, {})).toEqual({
      baseUrl: '/staff/rs',
      wadoUrl: '/staff/wado',
    });
  });

  it('uses the restricted NextRIS gateway for patient links', () => {
    expect(resolveDicomWebConfig(runtime, { shareToken: 'patient.token-1' })).toEqual({
      baseUrl: 'https://share.invalid/restricted/patient.token-1/dcm4chee-arc/aets/DCM4CHEE/rs',
      wadoUrl: 'https://share.invalid/restricted/patient.token-1/dcm4chee-arc/aets/DCM4CHEE/wado',
    });
  });
});
