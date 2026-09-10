const STORAGE_KEY = 'nextviewer5.token-handoff';
const DICOM_UID = /^[0-9]+(?:\.[0-9]+)+$/;
const SHARE_TOKEN = /^[A-Za-z0-9._~-]+$/;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{32,256}$/;

interface JwtClaims {
  exp?: number;
  iss?: string;
  azp?: string;
}

export interface TokenHandoffSession {
  accessToken: string;
  expiresAt: number;
  studyInstanceUID: string;
  authorizedParty: string;
  personalizationAccessToken?: string;
  personalizationExpiresAt?: number;
  personalizationEnabled?: boolean;
}

export interface TokenHandoffResult {
  session?: TokenHandoffSession;
  shareToken?: string;
  error?: string;
}

export function parseHandoffCode(search: string): { code: string; studyInstanceUID: string } | null {
  const params = new URLSearchParams(search);
  const codes = params.getAll('handoff_code');
  const studies = params.getAll('study_uid');
  if (codes.length !== 1 || studies.length !== 1) return null;
  const code = codes[0].trim();
  const studyInstanceUID = studies[0].trim();
  if (!HANDOFF_CODE.test(code) || studyInstanceUID.length > 64 || !DICOM_UID.test(studyInstanceUID)) return null;
  return { code, studyInstanceUID };
}

export async function exchangeHandoffCode(
  code: string,
  studyInstanceUID: string
): Promise<TokenHandoffSession> {
  const response = await fetch('/nextris-api/viewer/session/exchange', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, studyInstanceUID }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.data?.dicomAccessToken || !payload?.data?.viewerAccessToken) {
    throw new Error(payload?.message || 'No se pudo intercambiar la sesión de NextRIS.');
  }
  return {
    accessToken: payload.data.dicomAccessToken,
    personalizationAccessToken: payload.data.viewerAccessToken,
    personalizationExpiresAt: Math.floor(Date.now() / 1000) + Number(payload.data.viewerExpiresIn || 28800),
    personalizationEnabled: Boolean(payload.data.personalizationEnabled),
    expiresAt: Math.floor(Date.now() / 1000) + Number(payload.data.expiresIn || 300),
    studyInstanceUID,
    authorizedParty: 'nextris-handoff',
  };
}

function decodeJwtPart<T>(part: string): T {
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, '');
}

export function parseTokenHandoff(
  search: string,
  expectedIssuer: string,
  allowedClients: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): TokenHandoffResult {
  const params = new URLSearchParams(search);
  const tokens = params.getAll('access_token');
  const studyUIDs = params.getAll('study_uid');
  const shareTokens = params.getAll('share_token');
  if (tokens.length !== 1 || studyUIDs.length !== 1 || shareTokens.length > 1) {
    return { error: 'El enlace de NextRIS no contiene parámetros válidos.' };
  }

  const accessToken = tokens[0].trim();
  const studyInstanceUID = studyUIDs[0].trim();
  const shareToken = shareTokens[0]?.trim();
  if (!accessToken || accessToken.length > 16384 ||
      studyInstanceUID.length > 64 || !DICOM_UID.test(studyInstanceUID) ||
      (shareToken && (shareToken.length > 2048 || !SHARE_TOKEN.test(shareToken)))) {
    return { error: 'El enlace de NextRIS no contiene parámetros válidos.' };
  }

  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) throw new Error('JWT inválido');
    const header = decodeJwtPart<{ alg?: string }>(parts[0]);
    const claims = decodeJwtPart<JwtClaims>(parts[1]);
    const clients = allowedClients.split(',').map(value => value.trim()).filter(Boolean);
    if (header.alg !== 'RS256' ||
        !claims.iss || normalizeIssuer(claims.iss) !== normalizeIssuer(expectedIssuer) ||
        !claims.azp || !clients.includes(claims.azp) ||
        !Number.isFinite(claims.exp) || claims.exp! <= nowSeconds + 5) {
      throw new Error('Claims no autorizados');
    }
    return {
      session: {
        accessToken,
        expiresAt: claims.exp!,
        studyInstanceUID,
        authorizedParty: claims.azp,
      },
      shareToken: shareToken || undefined,
    };
  } catch {
    return { error: 'La sesión recibida desde NextRIS no es válida o ya venció.' };
  }
}

export function storeTokenHandoff(session: TokenHandoffSession): void {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function readTokenHandoff(studyInstanceUID?: string): TokenHandoffSession | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as TokenHandoffSession;
    if (!session.accessToken || !Number.isFinite(session.expiresAt) ||
        (studyInstanceUID && session.studyInstanceUID !== studyInstanceUID)) return null;
    return session;
  } catch {
    return null;
  }
}

export function getTokenHandoff(studyInstanceUID?: string): TokenHandoffSession | null {
  const session = readTokenHandoff(studyInstanceUID);
  return session && session.expiresAt > Math.floor(Date.now() / 1000) + 5 ? session : null;
}

export async function getOrRefreshTokenHandoff(studyInstanceUID?: string): Promise<TokenHandoffSession | null> {
  const session = readTokenHandoff(studyInstanceUID);
  if (!session) return null;
  if (session.expiresAt > Math.floor(Date.now() / 1000) + 30) return session;
  if (!session.personalizationAccessToken ||
      (session.personalizationExpiresAt || 0) <= Math.floor(Date.now() / 1000) + 30) return null;
  const response = await fetch('/nextris-api/viewer/session/refresh', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.personalizationAccessToken}` },
    body: JSON.stringify({ studyInstanceUID: session.studyInstanceUID }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.data?.dicomAccessToken) {
    clearTokenHandoff();
    throw new Error(payload?.message || 'La sesión clínica venció. Abra nuevamente el estudio desde NextRIS.');
  }
  const refreshed = {
    ...session,
    accessToken: payload.data.dicomAccessToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(payload.data.expiresIn || 300),
  };
  storeTokenHandoff(refreshed);
  return refreshed;
}

export function clearTokenHandoff(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function getPersonalizationAccessToken(): string | null {
  const session = readTokenHandoff();
  if (!session?.personalizationEnabled || !session.personalizationAccessToken ||
      (session.personalizationExpiresAt || 0) <= Math.floor(Date.now() / 1000) + 5) return null;
  return session.personalizationAccessToken;
}

export function hasPersonalizationAccess(): boolean {
  return Boolean(getPersonalizationAccessToken());
}
