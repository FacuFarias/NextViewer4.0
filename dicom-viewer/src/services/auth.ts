const TOKEN_URL = '/auth/realms/dcm4che/protocol/openid-connect/token';
const CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'dcm4chee-arc-ui';
const SESSION_KEY = 'nextviewer-keycloak-session-v1';
const AUTH_REQUIRED_EVENT = 'nextviewer:auth-required';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_expires_in?: number;
  token_type: string;
}

interface PersistedSession {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: number;
  refreshExpiry: number;
}

let currentToken: string | null = null;
let tokenExpiry = 0;
let refreshToken: string | null = null;
let refreshExpiry = 0;
let refreshPromise: Promise<string> | null = null;

function persistSession(): void {
  if (!currentToken) {
    sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  const session: PersistedSession = { accessToken: currentToken, refreshToken, tokenExpiry, refreshExpiry };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function applyTokens(data: TokenResponse): string {
  currentToken = data.access_token;
  refreshToken = data.refresh_token || refreshToken;
  tokenExpiry = Date.now() + Math.max(1, data.expires_in) * 1000 - 10_000;
  refreshExpiry = data.refresh_expires_in
    ? Date.now() + data.refresh_expires_in * 1000 - 10_000
    : Date.now() + 30 * 60 * 1000;
  persistSession();
  return currentToken;
}

function restoreSession(): void {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (!stored) return;
    const session = JSON.parse(stored) as PersistedSession;
    currentToken = session.accessToken || null;
    refreshToken = session.refreshToken || null;
    tokenExpiry = Number(session.tokenExpiry || 0);
    refreshExpiry = Number(session.refreshExpiry || 0);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error_description || 'Keycloak authentication failed');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response.json();
}

export async function login(username: string, password: string): Promise<string> {
  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) throw new Error('Username and password are required');
  const data = await tokenRequest(new URLSearchParams({
    grant_type: 'password',
    client_id: CLIENT_ID,
    username: normalizedUsername,
    password,
    scope: 'openid',
  }));
  return applyTokens(data);
}

async function refreshAccessToken(): Promise<string> {
  if (!refreshToken || Date.now() >= refreshExpiry) throw new Error('Keycloak session expired');
  if (refreshPromise) return refreshPromise;
  refreshPromise = tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })).then(applyTokens).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function initializeAuthentication(): Promise<boolean> {
  restoreSession();
  if (getCurrentToken()) return true;
  if (!refreshToken) return false;
  try {
    await refreshAccessToken();
    return true;
  } catch {
    await clearToken();
    return false;
  }
}

export async function getAccessToken(): Promise<string> {
  const token = getCurrentToken();
  if (token) return token;
  try {
    return await refreshAccessToken();
  } catch (error) {
    await clearToken();
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw error;
  }
}

export async function clearToken(): Promise<void> {
  const previousCacheUserKey = getCacheUserKey();
  currentToken = null;
  refreshToken = null;
  tokenExpiry = 0;
  refreshExpiry = 0;
  persistSession();
  await Promise.allSettled([
    import('./dicomCache').then(({ clearPersistentDicomCacheForUser }) =>
      clearPersistentDicomCacheForUser(previousCacheUserKey)),
    import('./preloadQueue').then(({ clearPreloadQueue }) => clearPreloadQueue(previousCacheUserKey)),
  ]);
}

export async function logout(): Promise<void> {
  await clearToken();
  window.location.assign('/');
}

export function decodeToken(token: string): any {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64).split('').map(c => `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`).join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

export function getCurrentToken(): string | null {
  return currentToken && Date.now() < tokenExpiry ? currentToken : null;
}

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

export function getCurrentRoles(): string[] {
  const decoded = currentToken ? decodeToken(currentToken) : null;
  const realmRoles = Array.isArray(decoded?.realm_access?.roles) ? decoded.realm_access.roles : [];
  const resourceRoles = Object.values(decoded?.resource_access || {})
    .flatMap((resource: any) => Array.isArray(resource?.roles) ? resource.roles : []);
  return [...new Set([...realmRoles, ...resourceRoles].filter(role => typeof role === 'string'))] as string[];
}

export function isAdmin(): boolean { return getCurrentRoles().includes('admin'); }

export function getCurrentUser(): string | null {
  const decoded = currentToken ? decodeToken(currentToken) : null;
  return decoded?.preferred_username || decoded?.name || null;
}

export function subscribeToAuthRequired(listener: () => void): () => void {
  window.addEventListener(AUTH_REQUIRED_EVENT, listener);
  return () => window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
}
