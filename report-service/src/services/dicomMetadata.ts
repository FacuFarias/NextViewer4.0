import * as dicomParser from 'dicom-parser';

export interface ReferenceDicomMetadata {
  studyInstanceUID: string;
  seriesInstanceUID: string | null;
  sopInstanceUID: string | null;
  modality: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  patientId: string | null;
  patientName: string | null;
  dicomAccessionNumber: string | null;
  seriesDescription: string | null;
  frameOfReferenceUID: string | null;
}

const clean = (value: string | undefined): string | null => {
  const normalized = value?.replace(/\0/g, '').trim();
  return normalized || null;
};

export function parseReferenceDicom(bytes: Uint8Array): ReferenceDicomMetadata {
  const dataSet = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' });
  const studyInstanceUID = clean(dataSet.string('x0020000d'));
  if (!studyInstanceUID) throw new Error('DICOM object has no Study Instance UID (0020,000D)');
  return {
    studyInstanceUID,
    seriesInstanceUID: clean(dataSet.string('x0020000e')),
    sopInstanceUID: clean(dataSet.string('x00080018')),
    modality: clean(dataSet.string('x00080060')),
    studyDate: clean(dataSet.string('x00080020')),
    studyDescription: clean(dataSet.string('x00081030')),
    patientId: clean(dataSet.string('x00100020')),
    patientName: clean(dataSet.string('x00100010')),
    dicomAccessionNumber: clean(dataSet.string('x00080050')),
    seriesDescription: clean(dataSet.string('x0008103e')),
    frameOfReferenceUID: clean(dataSet.string('x00200052')),
  };
}
