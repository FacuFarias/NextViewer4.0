import { describe, expect, it } from 'vitest';
import type { DicomSeries, DicomStudy } from '../types/dicom';
import type { HangingProtocol } from '../types/hangingProtocol';
import {
  assignSeries, layoutSlotCount, resolvePrimaryModality, selectHangingProtocol, SYSTEM_HANGING_PROTOCOLS,
} from './hangingProtocols';

function series(number: number, modality: string, description: string, metadata: Partial<DicomSeries> = {}): DicomSeries {
  return {
    seriesInstanceUID: `1.2.840.${number}`, seriesNumber: number, seriesDescription: description,
    modality, instances: [], ...metadata,
  };
}

function study(items: DicomSeries[]): DicomStudy {
  return {
    studyInstanceUID: '1.2.3', patientName: 'Anon', patientID: 'A', studyDate: '20260816',
    studyDescription: 'Test', modality: items.map(item => item.modality).join(','), series: items,
  };
}

describe('hanging protocol matching', () => {
  it('orders MG as RCC-LCC / RMLO-LMLO without reusing series', () => {
    const protocol = SYSTEM_HANGING_PROTOCOLS.find(item => item.modality === 'MG')!;
    const assigned = assignSeries(protocol, [
      series(4, 'MG', 'LMLO'), series(2, 'MG', 'LCC'), series(3, 'MG', 'RMLO'), series(1, 'MG', 'RCC'),
    ]);
    expect(assigned.map(item => item.series?.seriesDescription)).toEqual(['RCC', 'LCC', 'RMLO', 'LMLO']);
    expect(new Set(assigned.map(item => item.series?.seriesInstanceUID)).size).toBe(4);
  });

  it('matches frontal and lateral projection and fills unmatched slots deterministically', () => {
    const protocol = SYSTEM_HANGING_PROTOCOLS.find(item => item.modality === 'DX')!;
    expect(assignSeries(protocol, [
      series(7, 'DX', 'Rodilla LAT'), series(3, 'DX', 'Rodilla AP'), series(5, 'DX', 'Oblicua'),
    ]).map(item => item.series?.seriesNumber)).toEqual([3, 7]);
    expect(assignSeries(protocol, [series(8, 'DX', 'B'), series(2, 'DX', 'A')])
      .map(item => item.series?.seriesNumber)).toEqual([2, 8]);
  });

  it('uses personal active protocol before global and falls back by modality', () => {
    const personal: HangingProtocol = {
      id: 'user-1', name: 'Mi CT', modality: 'CT', layout: '2x1', isActive: true,
      source: 'user', viewportRules: [
        { slot: 0, match: { modality: 'CT' } }, { slot: 1, match: { modality: 'CT' } },
      ],
    };
    expect(selectHangingProtocol(study([series(1, 'CT', 'Axial')]), [personal]).id).toBe('user-1');
    expect(selectHangingProtocol(study([series(1, 'MR', 'T1')]), [personal]).id).toBe('system-mr');
  });

  it('keeps CT and MR in the primary native view until MPR is activated', () => {
    expect(selectHangingProtocol(study([series(1, 'CT', 'Axial')]), []).layout).toBe('1x1');
    expect(selectHangingProtocol(study([series(1, 'MR', 'T1')]), []).layout).toBe('1x1');
  });

  it('uses first visual modality except PT/CT and NM/CT combinations', () => {
    expect(resolvePrimaryModality(study([series(1, 'MR', 'MR'), series(2, 'PT', 'PET')]))).toBe('MR');
    expect(resolvePrimaryModality(study([series(1, 'CT', 'CT'), series(2, 'PT', 'PET')]))).toBe('PT');
    expect(resolvePrimaryModality(study([series(1, 'CT', 'CT'), series(2, 'NM', 'NM')]))).toBe('NM');
  });

  it('leaves a viewport empty when the study has fewer series than slots', () => {
    const protocol = SYSTEM_HANGING_PROTOCOLS.find(item => item.modality === 'MG')!;
    const assigned = assignSeries(protocol, [series(1, 'MG', 'RCC')]);
    expect(assigned).toHaveLength(4);
    expect(assigned.filter(item => item.series)).toHaveLength(1);
  });

  it('calculates every manual grid size through 3x3', () => {
    expect(layoutSlotCount('1x3')).toBe(3);
    expect(layoutSlotCount('2x3')).toBe(6);
    expect(layoutSlotCount('3x2')).toBe(6);
    expect(layoutSlotCount('3x3')).toBe(9);
  });
});
