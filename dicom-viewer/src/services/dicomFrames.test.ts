import { describe, expect, it } from 'vitest';
import type { DicomInstance } from '../types/dicom';
import { expandMultiframeInstances, getDicomFrameImageId } from './dicomFrames';

const instance: DicomInstance = {
  sopInstanceUID: '1.2.3',
  instanceNumber: 1,
  numberOfFrames: 3,
  rows: 64,
  columns: 64,
  bitsAllocated: 8,
  photometricInterpretation: 'MONOCHROME2',
};

describe('multiframe expansion', () => {
  it('creates one stack entry per frame', () => {
    expect(expandMultiframeInstances([instance]).map(item => item.frameNumber)).toEqual([1, 2, 3]);
  });

  it('uses Cornerstone one-based WADO frame selection', () => {
    expect(getDicomFrameImageId('/wado?x=1', { ...instance, frameNumber: 3 }))
      .toBe('wadouri:/wado?x=1&frame=3');
  });
});
