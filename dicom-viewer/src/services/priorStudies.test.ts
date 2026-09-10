import { describe, expect, it } from 'vitest';
import type { DicomStudy } from '../types/dicom';
import { selectPriorStudies } from './priorStudies';

const study = (overrides: Partial<DicomStudy>): DicomStudy => ({
  studyInstanceUID: '1.2.3', patientName: 'Paciente', patientID: '87066', studyDate: '20260903',
  studyDescription: '', modality: 'MR', series: [], ...overrides,
});

describe('selectPriorStudies', () => {
  it('returns earlier studies for the same patient in descending chronology', () => {
    const current = study({});
    const result = selectPriorStudies(current, [
      study({ studyInstanceUID: '1.2.2', studyDate: '20260902', studyTime: '120000' }),
      study({ studyInstanceUID: '1.2.4', studyDate: '20260904' }),
      study({ studyInstanceUID: '1.2.1', studyDate: '20200101' }),
      study({ studyInstanceUID: '9.9.9', patientID: 'other', studyDate: '20260901' }),
      current,
    ]);

    expect(result.map(entry => entry.studyInstanceUID)).toEqual(['1.2.2', '1.2.1']);
  });

  it('matches PatientID without whitespace or case differences', () => {
    const current = study({ patientID: ' ab-12 ' });
    expect(selectPriorStudies(current, [
      study({ studyInstanceUID: '1.2.2', patientID: 'AB-12', studyDate: '20260901' }),
    ])).toHaveLength(1);
  });
});
