import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthenticatedUser } from './types/annotations';

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

const authRequired = process.env.AUTH_REQUIRED === 'true';
const jwksUrl = process.env.KEYCLOAK_JWKS_URL ||
  'http://keycloak:8080/realms/dcm4che/protocol/openid-connect/certs';
const issuer = process.env.KEYCLOAK_ISSUER;
const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));

function bearerToken(request: Request): string | null {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export async function authenticate(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    if (authRequired) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
    return;
  }

  try {
    const verification = await jwtVerify(token, remoteJwks, issuer ? { issuer } : undefined);
    const claims = verification.payload;
    const realmRoles = Array.isArray((claims.realm_access as { roles?: unknown[] } | undefined)?.roles)
      ? ((claims.realm_access as { roles: unknown[] }).roles.filter(role => typeof role === 'string') as string[])
      : [];
    const resourceRoles = Object.values((claims.resource_access as Record<string, { roles?: unknown[] }> | undefined) || {})
      .flatMap(resource => Array.isArray(resource.roles) ? resource.roles : [])
      .filter(role => typeof role === 'string') as string[];

    request.user = {
      username: typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : typeof claims.sub === 'string' ? claims.sub : null,
      roles: [...new Set([...realmRoles, ...resourceRoles])],
    };
    next();
  } catch (error) {
    console.error('Annotation API token validation failed:', error);
    response.status(401).json({ error: 'Invalid authentication token' });
  }
}

export function hasPermission(user: AuthenticatedUser | undefined, permission: string): boolean {
  if (!authRequired && !user) return true;
  if (!user) return false;
  if (user.roles.includes('admin')) return true;

  const roleAliases: Record<string, string[]> = {
    'annotation:read': ['annotator', 'reviewer', 'annotation-reader'],
    'annotation:write': ['annotator', 'annotation-writer'],
    'annotation:delete': ['annotator', 'annotation-writer'],
    'annotation:review': ['reviewer'],
  };

  return user.roles.some(role => role === permission || roleAliases[permission]?.includes(role));
}

export function requirePermission(permission: string) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    if (!hasPermission(request.user, permission)) {
      response.status(request.user ? 403 : 401).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
