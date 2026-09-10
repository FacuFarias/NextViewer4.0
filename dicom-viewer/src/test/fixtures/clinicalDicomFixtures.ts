import type { DicomInstance } from '../../types/dicom';

type ClinicalFixture = Pick<
  DicomInstance,
  'sopInstanceUID' | 'sopClassUID' | 'instanceNumber' | 'numberOfFrames' |
  'rows' | 'columns' | 'bitsAllocated' | 'photometricInterpretation' |
  'modality' | 'transferSyntaxUID'
>;

function fixture(
  index: number,
  modality: string,
  sopClassUID: string,
  transferSyntaxUID: string,
  numberOfFrames = 1
): ClinicalFixture {
  return {
    sopInstanceUID: `1.2.826.0.1.3680043.10.543.5.${index}`,
    sopClassUID,
    instanceNumber: index,
    numberOfFrames,
    rows: 64,
    columns: 64,
    bitsAllocated: 16,
    photometricInterpretation: 'MONOCHROME2',
    modality,
    transferSyntaxUID,
  };
}

// Metadata-only, synthetic and anonymous fixtures. Pixel decoding is exercised by
// Cornerstone's bundled codecs and must additionally be smoke-tested with approved
// anonymized clinical files before diagnostic validation.
export const clinicalDicomFixtures: ClinicalFixture[] = [
  fixture(1, 'CR', '1.2.840.10008.5.1.4.1.1.1', '1.2.840.10008.1.2.4.70'),
  fixture(2, 'RF', '1.2.840.10008.5.1.4.1.1.12.2', '1.2.840.10008.1.2.4.80'),
  fixture(3, 'NM', '1.2.840.10008.5.1.4.1.1.20', '1.2.840.10008.1.2.4.90'),
  fixture(4, 'PT', '1.2.840.10008.5.1.4.1.1.128', '1.2.840.10008.1.2.5'),
  fixture(5, 'SC', '1.2.840.10008.5.1.4.1.1.7', '1.2.840.10008.1.2.4.50'),
  fixture(6, 'XA', '1.2.840.10008.5.1.4.1.1.12.1', '1.2.840.10008.1.2.1', 32),
];
