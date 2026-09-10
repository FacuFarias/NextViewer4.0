import { describe, expect, it } from 'vitest';
import { parseTokenHandoff } from './tokenHandoff';

function encode(value: object): string {
  return btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function token(claims: object, algorithm = 'RS256'): string {
  return `${encode({ alg: algorithm, typ: 'JWT' })}.${encode(claims)}.signature`;
}

const issuer = 'https://identity.invalid/realms/dcm4che';

describe('NextRIS token handoff', () => {
  it('accepts a current token from an allowed Keycloak client', () => {
    const accessToken = token({ exp: 2000, iss: issuer, azp: 'dcm4chee-arc-ui' });
    const result = parseTokenHandoff(
      `?access_token=${accessToken}&study_uid=1.2.840.10008.1`,
      issuer,
      'dcm4chee-arc-ui,ohif-viewer',
      1000
    );
    expect(result.session?.studyInstanceUID).toBe('1.2.840.10008.1');
    expect(result.session?.accessToken).toBe(accessToken);
  });

  it('rejects expired, foreign-client and unsigned tokens', () => {
    const base = { iss: issuer, azp: 'dcm4chee-arc-ui' };
    expect(parseTokenHandoff(`?access_token=${token({ ...base, exp: 900 })}&study_uid=1.2.3`, issuer, 'dcm4chee-arc-ui', 1000).error).toBeTruthy();
    expect(parseTokenHandoff(`?access_token=${token({ ...base, exp: 2000, azp: 'other' })}&study_uid=1.2.3`, issuer, 'dcm4chee-arc-ui', 1000).error).toBeTruthy();
    expect(parseTokenHandoff(`?access_token=${token({ ...base, exp: 2000 }, 'none')}&study_uid=1.2.3`, issuer, 'dcm4chee-arc-ui', 1000).error).toBeTruthy();
  });

  it('rejects malformed study identifiers and duplicate parameters', () => {
    const accessToken = token({ exp: 2000, iss: issuer, azp: 'dcm4chee-arc-ui' });
    expect(parseTokenHandoff(`?access_token=${accessToken}&study_uid=bad`, issuer, 'dcm4chee-arc-ui', 1000).error).toBeTruthy();
    expect(parseTokenHandoff(`?access_token=${accessToken}&access_token=${accessToken}&study_uid=1.2.3`, issuer, 'dcm4chee-arc-ui', 1000).error).toBeTruthy();
  });
});
