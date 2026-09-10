import { describe, expect, it } from 'vitest';
import { parseViewerRequest } from './viewerRequest';

describe('parseViewerRequest', () => {
  it('accepts the existing NextRIS query contract', () => {
    expect(parseViewerRequest('?StudyInstanceUIDs=1.2.840.10008.1').request).toEqual({
      studyInstanceUID: '1.2.840.10008.1',
      source: 'staff',
      shareToken: undefined,
    });
  });

  it('accepts a patient share token', () => {
    const result = parseViewerRequest('?StudyInstanceUIDs=1.2.3&share_token=abc.def-123');
    expect(result.request?.source).toBe('share');
    expect(result.request?.shareToken).toBe('abc.def-123');
  });

  it('rejects multiple studies and malformed UIDs', () => {
    expect(parseViewerRequest('?StudyInstanceUIDs=1.2.3,2.3.4').error).toMatch(/exactamente un estudio/);
    expect(parseViewerRequest('?StudyInstanceUIDs=1.2.3&StudyInstanceUIDs=2.3.4').error)
      .toMatch(/exactamente un estudio/);
    expect(parseViewerRequest('?StudyInstanceUIDs=not-a-uid').error).toMatch(/formato DICOM/);
  });

  it('rejects duplicate share tokens', () => {
    expect(parseViewerRequest('?StudyInstanceUIDs=1.2.3&share_token=a&share_token=b').error)
      .toMatch(/enlace compartido/);
  });

  it('accepts the internal path route', () => {
    expect(parseViewerRequest('', '1.2.3').request?.studyInstanceUID).toBe('1.2.3');
  });
});
