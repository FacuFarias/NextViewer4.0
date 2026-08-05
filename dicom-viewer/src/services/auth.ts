const KEYCLOAK_URL = '/auth/realms/dcm4che/protocol/openid-connect/token';
const CLIENT_ID = 'dcm4chee-arc-ui';

// Keep the service credentials in one place. These are the credentials used
// by the current local dcm4chee/Keycloak deployment.
export const DICOM_USERNAME = 'admin';
export const DICOM_PASSWORD = 'changeit';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

let currentToken: string | null = null;
let tokenExpiry: number = 0;
let refreshToken: string | null = null;

export async function getAccessToken(username: string, password: string): Promise<string> {
  console.log('Getting access token...');
  
  if (currentToken && Date.now() < tokenExpiry) {
    console.log('Using cached token');
    return currentToken;
  }

  if (refreshToken) {
    try {
      console.log('Trying to refresh token');
      return await refreshAccessToken();
    } catch {
      console.log('Refresh failed, getting new token');
    }
  }

  console.log('Requesting new token from Keycloak');
  const response = await fetch(KEYCLOAK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      username,
      password,
      scope: 'openid',
    }),
  });

  if (!response.ok) {
    console.error('Authentication failed:', response.status, response.statusText);
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  const data: TokenResponse = await response.json();
  
  currentToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 10000;

  console.log('Token obtained successfully, expires in:', data.expires_in, 'seconds');
  return currentToken;
}

async function refreshAccessToken(): Promise<string> {
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await fetch(KEYCLOAK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data: TokenResponse = await response.json();
  
  currentToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 10000;

  return currentToken;
}

export function clearToken(): void {
  const previousCacheUserKey = getCacheUserKey();
  currentToken = null;
  refreshToken = null;
  tokenExpiry = 0;

  // Logout is currently owned by the host application. Keep the cleanup here
  // so any caller that clears the session also removes the local DICOM data
  // belonging to the previous user.
  void import('./dicomCache')
    .then(({ clearPersistentDicomCacheForUser }) => clearPersistentDicomCacheForUser(previousCacheUserKey))
    .catch(error => console.warn('[DICOM cache] Failed to clear user cache', error));
  void import('./preloadQueue')
    .then(({ clearPreloadQueue }) => clearPreloadQueue(previousCacheUserKey))
    .catch(error => console.warn('[Preload] Failed to clear user queue', error));
}

export function decodeToken(token: string): any {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (error) {
    console.error('Failed to decode token:', error);
    return null;
  }
}

export function getCurrentToken(): string | null {
  return currentToken;
}

/**
 * Returns a stable, non-sensitive identifier that can be used to namespace
 * browser-side DICOM caches. The token itself is never persisted in the cache
 * key or in IndexedDB.
 */
export function getCacheUserKey(): string {
  const decoded = currentToken ? decodeToken(currentToken) : null;
  const identity = String(decoded?.sub || decoded?.preferred_username || 'anonymous');

  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

export function isAdmin(): boolean {
  if (!currentToken) return false;
  
  const decoded = decodeToken(currentToken);
  if (!decoded) return false;
  
  const roles = decoded.realm_access?.roles || [];
  return roles.includes('admin');
}

export function getCurrentUser(): string | null {
  if (!currentToken) return null;
  
  const decoded = decodeToken(currentToken);
  if (!decoded) return null;
  
  return decoded.preferred_username || null;
}
