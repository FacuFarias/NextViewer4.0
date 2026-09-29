import { describe, expect, it } from 'vitest';
import type { DicomInstance, DicomStudy } from '../types/dicom';
import { buildPresentationStateDataset, parsePresentationState, serializePresentationState } from './presentationState';

const study: DicomStudy = {
  studyInstanceUID: '1.2.3.4', patientName: 'TEST^PATIENT', patientID: 'P1',
  studyDate: '20260101', studyDescription: 'Test', modality: 'MR', series: [],
};
const instance: DicomInstance = {
  sopInstanceUID: '1.2.3.4.5', sopClassUID: '1.2.840.10008.5.1.4.1.1.4', instanceNumber: 1,
  rows: 128, columns: 256, bitsAllocated: 16, photometricInterpretation: 'MONOCHROME2',
  frameNumber: 1,
};

describe('GSPS serialization', () => {
  it('writes a Part 10 object without pixel data and preserves the image reference', async () => {
    const viewport = { worldToCanvas: (point: number[]) => point, getImageData: () => ({ imageData: {
      worldToIndex: (point: number[]) => point,
    }}) };
    const { dataset, state } = buildPresentationStateDataset(study, instance,
      { windowWidth: 400, windowCenter: 40 }, false, [], viewport, '1.2.3.4.6');
    const parsed = parsePresentationState(await serializePresentationState(dataset).arrayBuffer());
    expect(parsed.sopInstanceUID).toBe(state.sopInstanceUID);
    expect(parsed.referencedSopInstanceUID).toBe(instance.sopInstanceUID);
    expect(parsed.windowWidth).toBe(400);
    expect(parsed.windowCenter).toBe(40);
  });
});
