import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { getRuntimeConfig } from './runtimeConfig';
import { clearTokenHandoff, getOrRefreshTokenHandoff, getTokenHandoff } from './tokenHandoff';

let manager: UserManager | null = null;
let shareAccess = false;

function getUserManager(): UserManager {
  if (manager) return manager;
  const config = getRuntimeConfig();
  manager = new UserManager({
    authority: config.keycloakAuthority,
    client_id: config.keycloakClientId,
    redirect_uri: config.oidcRedirectUri,
    post_logout_redirect_uri: config.oidcPostLogoutRedirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: false,
    monitorSession: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
  return manager;
}

export function setShareAccess(enabled: boolean): void {
  shareAccess = enabled;
}

export function isShareAccess(): boolean {
  return shareAccess;
}

export async function getCurrentUser(): Promise<User | null> {
  if (shareAccess) return null;
  const user = await getUserManager().getUser();
  return user && !user.expired ? user : null;
}

export async function ensureAuthenticated(
  returnUrl: string,
  studyInstanceUID: string
): Promise<boolean> {
  if (shareAccess) return true;
  if (await getOrRefreshTokenHandoff(studyInstanceUID)) return true;
  clearTokenHandoff();
  const user = await getCurrentUser();
  if (user) return true;

  await getUserManager().signinRedirect({ state: { returnUrl } });
  return false;
}

export async function handleSigninCallback(): Promise<string> {
  const user = await getUserManager().signinRedirectCallback();
  const state = user.state as { returnUrl?: string } | undefined;
  const returnUrl = state?.returnUrl;
  return returnUrl?.startsWith('/viewer') ? returnUrl : '/';
}

export async function getAccessToken(): Promise<string | null> {
  if (shareAccess) return null;
  const handoff = await getOrRefreshTokenHandoff();
  if (handoff) return handoff.accessToken;
  const user = await getCurrentUser();
  if (!user?.access_token) throw new Error('La sesión clínica venció. Inicie sesión nuevamente.');
  return user.access_token;
}

export async function getDicomRequestHeaders(
  accept = 'application/dicom'
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: accept };
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function clearClinicalSession(): Promise<void> {
  const { clearClinicalMeasurements, purgeMemoryCache } = await import('./cornerstone');
  clearClinicalMeasurements();
  purgeMemoryCache();
}

export async function logout(): Promise<void> {
  await clearClinicalSession();
  if (shareAccess) {
    window.sessionStorage.clear();
    window.location.assign('/');
    return;
  }
  if (getTokenHandoff()) {
    clearTokenHandoff();
    window.location.assign('/');
    return;
  }
  const user = await getCurrentUser();
  const userManager = getUserManager();
  await userManager.removeUser();
  await userManager.signoutRedirect({ id_token_hint: user?.id_token });
}
