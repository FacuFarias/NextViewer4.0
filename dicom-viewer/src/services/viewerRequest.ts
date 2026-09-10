const DICOM_UID = /^[0-9]+(?:\.[0-9]+)+$/;
const SHARE_TOKEN = /^[A-Za-z0-9._~-]+$/;

export interface ViewerRequest {
  studyInstanceUID: string;
  shareToken?: string;
  source: 'staff' | 'share';
}

export interface ViewerRequestResult {
  request?: ViewerRequest;
  error?: string;
}

export function parseViewerRequest(
  search: string,
  pathStudyInstanceUID?: string
): ViewerRequestResult {
  const params = new URLSearchParams(search);
  const queryValues = params.getAll('StudyInstanceUIDs').map(value => value.trim());
  if (queryValues.length > 1) {
    return { error: 'NextViewer 5.0 admite exactamente un estudio por enlace.' };
  }
  const queryValue = queryValues[0];
  const pathValue = pathStudyInstanceUID?.trim();

  if (queryValue && pathValue && queryValue !== pathValue) {
    return { error: 'La URL contiene identificadores de estudio diferentes.' };
  }

  const rawStudyUID = queryValue || pathValue;
  if (!rawStudyUID) return { error: 'Falta StudyInstanceUIDs en el enlace.' };

  const studyUIDs = rawStudyUID.split(',').map(value => value.trim()).filter(Boolean);
  if (studyUIDs.length !== 1) {
    return { error: 'NextViewer 5.0 admite exactamente un estudio por enlace.' };
  }

  const studyInstanceUID = studyUIDs[0];
  if (studyInstanceUID.length > 64 || !DICOM_UID.test(studyInstanceUID)) {
    return { error: 'El Study Instance UID no tiene un formato DICOM válido.' };
  }

  const shareTokens = params.getAll('share_token').map(value => value.trim());
  if (shareTokens.length > 1) return { error: 'El enlace compartido no es válido.' };
  const shareToken = shareTokens[0];
  if (shareToken && (shareToken.length > 2048 || !SHARE_TOKEN.test(shareToken))) {
    return { error: 'El enlace compartido no es válido.' };
  }

  return {
    request: {
      studyInstanceUID,
      shareToken: shareToken || undefined,
      source: shareToken ? 'share' : 'staff',
    },
  };
}
