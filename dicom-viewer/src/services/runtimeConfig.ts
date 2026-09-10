import type { RuntimeConfig } from '../types/runtimeConfig';

export function getRuntimeConfig(): RuntimeConfig {
  const config = window.__NEXTVIEWER_CONFIG__ || {};
  const required: Array<keyof RuntimeConfig> = [
    'dicomWebRoot',
    'wadoUriRoot',
    'keycloakAuthority',
    'keycloakClientId',
    'tokenHandoffClientIds',
    'oidcRedirectUri',
    'oidcPostLogoutRedirectUri',
    'shareGatewayRoot',
  ];

  for (const key of required) {
    if (!config[key]) throw new Error(`Falta la configuración runtime: ${key}`);
  }
  return config as RuntimeConfig;
}
