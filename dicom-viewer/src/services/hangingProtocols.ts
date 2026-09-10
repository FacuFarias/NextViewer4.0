import type { DicomSeries, DicomStudy } from '../types/dicom';
import {
  HANGING_MODALITIES,
  type HangingAssignment,
  type HangingLayout,
  type HangingModality,
  type HangingProtocol,
  type HangingViewportRule,
} from '../types/hangingProtocol';
import { getPersonalizationAccessToken } from './tokenHandoff';

const API_ROOT = '/nextris-api/viewer';

const rule = (slot: number, label: string, match: HangingViewportRule['match']): HangingViewportRule => ({
  slot, label, match,
});

export const SYSTEM_HANGING_PROTOCOLS: HangingProtocol[] = [
  ...(['CT', 'MR'] as const).map(modality => ({
    id: `system-${modality.toLowerCase()}`,
    name: `${modality} clínico`, modality, layout: '1x1' as const,
    isActive: true, source: 'system' as const,
    viewportRules: [rule(0, 'Serie principal', { modality })],
  })),
  ...(['CR', 'DX'] as const).map(modality => ({
    id: `system-${modality.toLowerCase()}`,
    name: `${modality} frontal y lateral`, modality, layout: '1x2' as const,
    isActive: true, source: 'system' as const,
    viewportRules: [
      rule(0, 'Frontal', { modality, viewPosition: ['AP', 'PA'] }),
      rule(1, 'Lateral', { modality, viewPosition: ['LAT', 'LL'] }),
    ],
  })),
  {
    id: 'system-mg', name: 'Mamografía 4 vistas', modality: 'MG', layout: '2x2',
    isActive: true, source: 'system',
    viewportRules: [
      rule(0, 'RCC', { modality: 'MG', laterality: ['R'], viewPosition: ['CC'] }),
      rule(1, 'LCC', { modality: 'MG', laterality: ['L'], viewPosition: ['CC'] }),
      rule(2, 'RMLO', { modality: 'MG', laterality: ['R'], viewPosition: ['MLO'] }),
      rule(3, 'LMLO', { modality: 'MG', laterality: ['L'], viewPosition: ['MLO'] }),
    ],
  },
  ...(['US', 'XA', 'RF', 'NM', 'PT', 'SC', 'OT'] as const).map(modality => ({
    id: `system-${modality.toLowerCase()}`,
    name: `${modality} clínico`, modality, layout: '1x1' as const,
    isActive: true, source: 'system' as const,
    viewportRules: [rule(0, 'Serie principal', { modality })],
  })),
];

const normalize = (value?: string): string => (value || '').trim().toUpperCase();
const includesAny = (value: string, candidates?: string[]): boolean =>
  !candidates?.length || candidates.some(candidate => value.includes(normalize(candidate)));

export function matchesSeries(series: DicomSeries, viewportRule: HangingViewportRule): boolean {
  const match = viewportRule.match;
  const description = normalize(series.seriesDescription);
  const laterality = normalize([
    series.imageLaterality, series.laterality, series.seriesDescription,
  ].filter(Boolean).join(' '));
  const viewPosition = normalize([series.viewPosition, series.seriesDescription].filter(Boolean).join(' '));
  const bodyPart = normalize(series.bodyPartExamined);
  if (match.modality && normalize(series.modality) !== match.modality) return false;
  if (!includesAny(description, match.descriptionIncludes)) return false;
  if (match.descriptionExcludes?.some(entry => description.includes(normalize(entry)))) return false;
  if (!includesAny(laterality, match.laterality)) return false;
  if (!includesAny(viewPosition, match.viewPosition)) return false;
  if (!includesAny(bodyPart, match.bodyPart)) return false;
  if (match.seriesNumberMin !== undefined && series.seriesNumber < match.seriesNumberMin) return false;
  if (match.seriesNumberMax !== undefined && series.seriesNumber > match.seriesNumberMax) return false;
  return true;
}

function sortedSeries(series: DicomSeries[]): DicomSeries[] {
  return [...series].sort((left, right) =>
    (left.seriesNumber || 0) - (right.seriesNumber || 0) ||
    left.seriesInstanceUID.localeCompare(right.seriesInstanceUID));
}

export function assignSeries(protocol: HangingProtocol, series: DicomSeries[]): HangingAssignment[] {
  const remaining = protocol.layout === 'mpr'
    ? [...series].sort((left, right) =>
        (right.numberOfInstances || 0) - (left.numberOfInstances || 0) ||
        (left.seriesNumber || 0) - (right.seriesNumber || 0) ||
        left.seriesInstanceUID.localeCompare(right.seriesInstanceUID))
    : sortedSeries(series);
  const assignments = protocol.viewportRules.map(viewportRule => {
    const index = remaining.findIndex(candidate => matchesSeries(candidate, viewportRule));
    const selected = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    return { slot: viewportRule.slot, label: viewportRule.label, series: selected };
  });
  for (const assignment of assignments) {
    if (!assignment.series) assignment.series = remaining.shift();
  }
  return assignments.sort((left, right) => left.slot - right.slot);
}

export function resolvePrimaryModality(study: DicomStudy): HangingModality {
  const ordered = sortedSeries(study.series).map(series => normalize(series.modality));
  if (ordered.includes('PT') && ordered.includes('CT')) return 'PT';
  if (ordered.includes('NM') && ordered.includes('CT')) return 'NM';
  return (ordered.find(value => HANGING_MODALITIES.includes(value as HangingModality)) || 'OT') as HangingModality;
}

export function selectHangingProtocol(
  study: DicomStudy,
  personalProtocols: HangingProtocol[]
): HangingProtocol {
  const modality = resolvePrimaryModality(study);
  return personalProtocols.find(protocol => protocol.modality === modality && protocol.isActive) ||
    SYSTEM_HANGING_PROTOCOLS.find(protocol => protocol.modality === modality) || {
      id: `fallback-${modality.toLowerCase()}`, name: `${modality} 1×1`, modality,
      layout: '1x1', isActive: true, source: 'system',
      viewportRules: [rule(0, 'Serie principal', { modality })],
    };
}

function normalizeProtocol(raw: any): HangingProtocol {
  return {
    id: String(raw.id), name: String(raw.name), modality: raw.modality,
    layout: raw.layout, isActive: Boolean(raw.isActive), source: 'user',
    viewportRules: Array.isArray(raw.viewportRules) ? raw.viewportRules : [],
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getPersonalizationAccessToken();
  if (!token) throw new Error('Abra el visor desde NextRIS para administrar protocolos personales.');
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `NextRIS respondió ${response.status}.`);
  return payload.data as T;
}

export async function listPersonalProtocols(): Promise<HangingProtocol[]> {
  return (await request<any[]>('/hanging-protocols')).map(normalizeProtocol);
}

export async function savePersonalProtocol(protocol: HangingProtocol): Promise<HangingProtocol> {
  const creating = protocol.source === 'system' || protocol.id.startsWith('new-');
  const path = creating ? '/hanging-protocols' : `/hanging-protocols/${encodeURIComponent(protocol.id)}`;
  return normalizeProtocol(await request<any>(path, {
    method: creating ? 'POST' : 'PUT',
    body: JSON.stringify({
      name: protocol.name, modality: protocol.modality, layout: protocol.layout,
      isActive: protocol.isActive, viewportRules: protocol.viewportRules,
    }),
  }));
}

export async function deletePersonalProtocol(id: string): Promise<void> {
  await request(`/hanging-protocols/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function restoreGlobalProtocol(modality: HangingModality): Promise<void> {
  await request('/hanging-protocols/deactivate', {
    method: 'POST', body: JSON.stringify({ modality }),
  });
}

export function layoutSlotCount(layout: HangingLayout): number {
  if (layout === 'mpr') return 1;
  const [rows, columns] = layout.split('x').map(Number);
  return rows * columns;
}
