import { getObjectBytes, listCommonPrefixes, summarizeObjects } from './s3';
import { parseReferenceDicom } from './dicomMetadata';
import {
  completeReferenceStudyScan,
  ensureReferenceStudy,
  failReferenceStudyScan,
} from '../repositories/referenceStorageRepository';

export const referenceBucket = process.env.REFERENCE_STORAGE_BUCKET ||
  process.env.SOURCE_DICOM_BUCKET || 'qii-images-for-training';
export const referenceBasePrefix = (process.env.REFERENCE_STORAGE_PREFIX || 'Anonimizied/')
  .replace(/^\/+/, '').replace(/\/?$/, '/');

const accessionFromPrefix = (prefix: string): string =>
  prefix.slice(referenceBasePrefix.length).replace(/\/$/, '');

export async function scanReferencePrefix(prefix: string): Promise<{ accessionNumber: string; ok: boolean }> {
  const accessionNumber = accessionFromPrefix(prefix);
  if (!/^OP-[A-Za-z0-9_-]+$/.test(accessionNumber)) {
    throw new Error(`Unsupported accession prefix: ${prefix}`);
  }
  const id = await ensureReferenceStudy({ accessionNumber, sourceBucket: referenceBucket, sourcePrefix: prefix });
  try {
    const summary = await summarizeObjects(referenceBucket, prefix);
    if (!summary.representativeObjectKey) throw new Error('No .dcm object found in S3 prefix');
    const bytes = await getObjectBytes(referenceBucket, summary.representativeObjectKey, {
      range: 'bytes=0-524287',
    });
    const metadata = parseReferenceDicom(bytes);
    await completeReferenceStudyScan(id, {
      studyInstanceUID: metadata.studyInstanceUID,
      representativeSeriesInstanceUID: metadata.seriesInstanceUID,
      representativeSOPInstanceUID: metadata.sopInstanceUID,
      modality: metadata.modality,
      studyDate: metadata.studyDate,
      studyDescription: metadata.studyDescription,
      patientId: metadata.patientId,
      patientName: metadata.patientName,
      representativeObjectKey: summary.representativeObjectKey,
      objectCount: summary.objectCount,
      totalSizeBytes: summary.totalSizeBytes,
      sourceLastModifiedAt: summary.lastModifiedAt,
      metadata: {
        dicomAccessionNumber: metadata.dicomAccessionNumber,
        seriesDescription: metadata.seriesDescription,
        frameOfReferenceUID: metadata.frameOfReferenceUID,
      },
    });
    return { accessionNumber, ok: true };
  } catch (error) {
    await failReferenceStudyScan(id, error instanceof Error ? error.message : String(error));
    return { accessionNumber, ok: false };
  }
}

export async function synchronizeReferenceCatalog(options: {
  concurrency?: number;
  onProgress?: (progress: { completed: number; total: number; failed: number; accessionNumber: string }) => void;
} = {}): Promise<{ total: number; completed: number; failed: number }> {
  const prefixes = (await listCommonPrefixes(referenceBucket, referenceBasePrefix))
    .filter(prefix => /^OP-[A-Za-z0-9_-]+$/.test(accessionFromPrefix(prefix)));
  let cursor = 0;
  let completed = 0;
  let failed = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= prefixes.length) return;
      const result = await scanReferencePrefix(prefixes[index]);
      completed += 1;
      if (!result.ok) failed += 1;
      options.onProgress?.({ completed, total: prefixes.length, failed, accessionNumber: result.accessionNumber });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency || 12) }, worker));
  return { total: prefixes.length, completed, failed };
}
