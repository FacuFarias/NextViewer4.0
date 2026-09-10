export interface RuntimeConfig {
  dicomWebRoot: string;
  wadoUriRoot: string;
  keycloakAuthority: string;
  keycloakClientId: string;
  tokenHandoffClientIds: string;
  oidcRedirectUri: string;
  oidcPostLogoutRedirectUri: string;
  shareGatewayRoot: string;
  downloadEnabled?: boolean;
}

declare global {
  interface Window {
    __NEXTVIEWER_CONFIG__?: Partial<RuntimeConfig>;
  }
}

export {};
