import { SegmentationInputManifest } from '../types/segmentationJobs';
import { listSourceObjects, sourceDicomBucket, sourcePrefix } from './s3';
import pool from '../db';

const dicomWebUrl = (process.env.PACS_DICOMWEB_URL ||
  'http://arc:8080/dcm4chee-arc/aets/DCM4CHEE/rs').replace(/\/$/, '');
const tokenUrl = process.env.PACS_TOKEN_URL ||
  'http://keycloak:8080/realms/dcm4che/protocol/openid-connect/token';
const clientId = process.env.PACS_CLIENT_ID || '';
const clientSecret = process.env.PACS_CLIENT_SECRET || '';
let tokenCache: { token: string; expiresAt: number } | null = null;

async function serviceToken(): Promise<string | null> {
  if (!clientId || !clientSecret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const response = await fetch(tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new Error(`PACS token request failed: ${response.status}`);
  const result: any = await response.json();
  tokenCache = { token: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 300) * 1000 };
  return tokenCache.token;
}

async function headers(accept: string): Promise<Record<string, string>> {
  const token = await serviceToken();
  return { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export async function qido(path: string): Promise<any[]> {
  const response = await fetch(`${dicomWebUrl}${path}`, { headers: await headers('application/dicom+json') });
  if (!response.ok) throw new Error(`PACS QIDO failed: ${response.status} ${response.statusText}`);
  const value = await response.json();
  return Array.isArray(value) ? value : [];
}

const value = (item: any, tag: string): any => item?.[tag]?.Value?.[0];

export async function buildSourceManifest(
  studyInstanceUID: string, seriesInstanceUID: string
): Promise<SegmentationInputManifest> {
  const series = await qido(
    `/studies/${encodeURIComponent(studyInstanceUID)}/series?SeriesInstanceUID=${encodeURIComponent(seriesInstanceUID)}`
  );
  if (!series[0]) throw new Error('Source series was not found in PACS');
  if (String(value(series[0], '00080060') || '').toUpperCase() !== 'CT') {
    throw new Error('Only CT source series can be queued for 3D segmentation');
  }
  const params = new URLSearchParams();
  ['00200013', '00200032'].forEach(tag => params.append('includefield', tag));
  const instances = await qido(
    `/studies/${encodeURIComponent(studyInstanceUID)}/series/${encodeURIComponent(seriesInstanceUID)}/instances?${params}`
  );
  if (!instances.length) throw new Error('Source series contains no DICOM instances');
  const catalog = await pool.query(
    `SELECT source_prefix FROM ia.reference_study
     WHERE study_instance_uid=$1 AND scan_status='ready' LIMIT 1`, [studyInstanceUID]
  );
  const prefix = catalog.rows[0]?.source_prefix || sourcePrefix(studyInstanceUID, seriesInstanceUID);
  const stored = await listSourceObjects(prefix);
  const bySop = new Map<string, typeof stored[number]>();
  for (const object of stored) {
    const file = object.key.slice(prefix.length).replace(/\.dcm$/i, '');
    bySop.set(file, object);
  }
  const objects = instances.map(item => {
    const sop = String(value(item, '00080018') || '');
    const storedObject = bySop.get(sop) || stored.find(object => object.key.includes(sop));
    if (!sop || !storedObject) throw new Error(`DICOM source object is missing from S3 for SOP ${sop || 'unknown'}`);
    return {
      sopInstanceUID: sop,
      key: storedObject.key,
      etag: storedObject.etag,
      size: storedObject.size,
      instanceNumber: Number(value(item, '00200013') || 0),
      imagePositionPatient: item?.['00200032']?.Value?.map(Number),
    };
  }).sort((a, b) => a.instanceNumber - b.instanceNumber);
  return { bucket: sourceDicomBucket, studyInstanceUID, seriesInstanceUID, createdAt: new Date().toISOString(), objects };
}

export async function storeDicomSeg(arrayBuffer: ArrayBuffer): Promise<void> {
  await storeDicomInstances([arrayBuffer]);
}

/** Download a complete DICOM instance from PACS for durable S3 archival. */
export async function fetchDicomInstance(
  studyUID: string, seriesUID: string, sopUID: string
): Promise<ArrayBuffer> {
  const response = await fetch(
    `${dicomWebUrl}/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}` +
    `/instances/${encodeURIComponent(sopUID)}`,
    { headers: await headers('multipart/related; type="application/dicom"') }
  );
  if (!response.ok) throw new Error(`PACS DICOM download failed: ${response.status} ${response.statusText}`);
  const payload = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) throw new Error('PACS DICOM response did not include a multipart boundary');
  const headerEnd = payload.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd < 0) throw new Error('PACS DICOM multipart part has no headers');
  const dataStart = headerEnd + 4;
  const dataEnd = payload.indexOf(Buffer.from(`\r\n--${boundaryMatch[1]}`), dataStart);
  if (dataEnd <= dataStart) throw new Error('PACS DICOM multipart part is empty');
  return payload.subarray(dataStart, dataEnd).buffer.slice(
    payload.byteOffset + dataStart, payload.byteOffset + dataEnd
  ) as ArrayBuffer;
}

export async function storeDicomInstances(arrayBuffers: ArrayBuffer[]): Promise<{
  accepted: number; failed: number;
}> {
  if (!arrayBuffers.length) return { accepted: 0, failed: 0 };
  const boundary = `nextviewer-${Date.now()}`;
  const parts: Buffer[] = [];
  for (const arrayBuffer of arrayBuffers) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`));
    parts.push(Buffer.from(arrayBuffer));
    parts.push(Buffer.from('\r\n'));
  }
  const suffix = Buffer.from(`--${boundary}--\r\n`);
  const body = Buffer.concat([...parts, suffix]);
  const response = await fetch(`${dicomWebUrl}/studies`, {
    method: 'POST',
    headers: {
      ...(await headers('application/dicom+json')),
      'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
    },
    body,
  });
  const responseText = await response.text();
  let payload: any = null;
  try { payload = responseText ? JSON.parse(responseText) : null; } catch { /* retain text for diagnostics */ }
  if (!response.ok) {
    throw new Error(`PACS STOW-RS failed: ${response.status} ${response.statusText}` +
      (responseText ? ` - ${responseText.slice(0, 1000)}` : ''));
  }
  const dataSet = Array.isArray(payload) ? payload[0] : payload;
  const accepted = Array.isArray(dataSet?.['00081199']?.Value)
    ? dataSet['00081199'].Value.length : arrayBuffers.length;
  const failed = Array.isArray(dataSet?.['00081198']?.Value)
    ? dataSet['00081198'].Value.length : 0;
  if (failed > 0 || accepted < arrayBuffers.length) {
    throw new Error(`PACS STOW-RS accepted ${accepted}/${arrayBuffers.length} instances; failed=${failed}` +
      (responseText ? ` - ${responseText.slice(0, 1000)}` : ''));
  }
  return { accepted, failed };
}

export async function verifyStudyExists(studyUID: string): Promise<void> {
  const result = await qido(`/studies?StudyInstanceUID=${encodeURIComponent(studyUID)}&limit=1`);
  if (!result.some(item => String(value(item, '0020000D') || '') === studyUID)) {
    throw new Error('PACS did not expose the imported study through QIDO');
  }
}

export async function verifyDicomSeg(
  studyUID: string, seriesUID: string, sopUID: string
): Promise<void> {
  const result = await qido(
    `/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}/instances`
  );
  if (!result.some(item => value(item, '00080018') === sopUID)) {
    throw new Error('PACS did not expose the stored DICOM SEG through QIDO');
  }
}

export async function listHistoricalSegSeries(): Promise<any[]> {
  return qido('/series?Modality=SEG&includefield=all');
}

export async function getInstanceMetadata(studyUID: string, seriesUID: string, sopUID: string): Promise<any> {
  const response = await fetch(
    `${dicomWebUrl}/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}` +
    `/instances/${encodeURIComponent(sopUID)}/metadata`,
    { headers: await headers('application/dicom+json') }
  );
  if (!response.ok) throw new Error(`PACS metadata request failed: ${response.status}`);
  const result = await response.json();
  return Array.isArray(result) ? result[0] : result;
}
