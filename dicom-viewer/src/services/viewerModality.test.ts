import { describe, expect, it } from 'vitest';
import type { DicomInstance, DicomSeries } from '../types/dicom';
import { clinicalDicomFixtures } from '../test/fixtures/clinicalDicomFixtures';
import {
  isClinicalImageModality,
  isSeriesMprCapable,
  isSupportedVisualInstance,
  resolveViewerModality,
} from './viewerModality';

function slice(index: number): DicomInstance {
  return {
    sopInstanceUID: `1.2.3.${index}`,
    instanceNumber: index,
    rows: 512,
    columns: 512,
    bitsAllocated: 16,
    photometricInterpretation: 'MONOCHROME2',
    frameOfReferenceUID: '1.2.3.99',
    imagePositionPatient: [0, 0, index],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [0.5, 0.5],
  };
}

describe('clinical modalities and MPR', () => {
  it('routes CT, MR and US while accepting generic clinical stacks', () => {
    expect(resolveViewerModality('CT')).toBe('ct');
    expect(resolveViewerModality('MR')).toBe('mr');
    expect(resolveViewerModality('US')).toBe('us');
    expect(resolveViewerModality('DX')).toBe('stack');
    expect(isClinicalImageModality('CR, DX, MG')).toBe(true);
    expect(isClinicalImageModality('SR')).toBe(false);
  });

  it('excludes SR, SEG, PDF and video objects', () => {
    expect(isSupportedVisualInstance({ sopClassUID: '1.2.840.10008.5.1.4.1.1.88.22' })).toBe(false);
    expect(isSupportedVisualInstance({ sopClassUID: '1.2.840.10008.5.1.4.1.1.66.4' })).toBe(false);
    expect(isSupportedVisualInstance({ sopClassUID: '1.2.840.10008.5.1.4.1.1.104.1' })).toBe(false);
    expect(isSupportedVisualInstance({ transferSyntaxUID: '1.2.840.10008.1.2.4.102' })).toBe(false);
    expect(isSupportedVisualInstance({ sopClassUID: '1.2.840.10008.5.1.4.1.1.2' })).toBe(true);
  });

  it('accepts the anonymous CR, RF, NM, PT, SC, multiframe and codec fixture matrix', () => {
    expect(clinicalDicomFixtures.every(instance =>
      isClinicalImageModality(instance.modality) && isSupportedVisualInstance(instance)
    )).toBe(true);
    expect(clinicalDicomFixtures.some(instance => (instance.numberOfFrames || 1) > 1)).toBe(true);
    expect(new Set(clinicalDicomFixtures.map(instance => instance.transferSyntaxUID))).toEqual(new Set([
      '1.2.840.10008.1.2.4.70',
      '1.2.840.10008.1.2.4.80',
      '1.2.840.10008.1.2.4.90',
      '1.2.840.10008.1.2.5',
      '1.2.840.10008.1.2.4.50',
      '1.2.840.10008.1.2.1',
    ]));
  });

  it.each(['CT', 'MR'])('enables MPR for valid %s geometry', modality => {
    const series: DicomSeries = {
      seriesInstanceUID: '1.2.3',
      seriesNumber: 1,
      seriesDescription: 'volume',
      modality,
      instances: [slice(1), slice(2), slice(3)],
    };
    expect(isSeriesMprCapable(series)).toBe(true);
  });

  it('falls back to stack when geometry is incomplete', () => {
    const series: DicomSeries = {
      seriesInstanceUID: '1.2.3',
      seriesNumber: 1,
      seriesDescription: 'invalid',
      modality: 'MR',
      instances: [slice(1), slice(2), { ...slice(3), pixelSpacing: undefined }],
    };
    expect(isSeriesMprCapable(series)).toBe(false);
  });

  it('falls back to stack for inconsistent orientation or slice spacing', () => {
    const baseSeries: DicomSeries = {
      seriesInstanceUID: '1.2.3',
      seriesNumber: 1,
      seriesDescription: 'inconsistent',
      modality: 'CT',
      instances: [slice(1), slice(2), slice(3), slice(4)],
    };
    expect(isSeriesMprCapable({
      ...baseSeries,
      instances: [slice(1), slice(2), { ...slice(3), imageOrientationPatient: [0, 1, 0, 1, 0, 0] }],
    })).toBe(false);
    expect(isSeriesMprCapable({
      ...baseSeries,
      instances: [slice(1), slice(2), slice(3), { ...slice(4), imagePositionPatient: [0, 0, 8] }],
    })).toBe(false);
  });
});
