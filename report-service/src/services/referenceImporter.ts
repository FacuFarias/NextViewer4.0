import { listBucketObjects, getObject } from './s3';
import { storeDicomInstances, verifyStudyExists } from './pacs';
import {
  claimReferenceImport,
  markReferenceStudyPacsVerified,
  updateReferenceImport,
} from '../repositories/referenceStorageRepository';

let running = false;

async function importClaimed(): Promise<boolean> {
  const claimed = await claimReferenceImport();
  if (!claimed) return false;
  const { job, study } = claimed;
  try {
    const objects = (await listBucketObjects(study.sourceBucket, study.sourcePrefix))
      .filter(object => /\.dcm$/i.test(object.key));
    if (!objects.length) throw new Error('Reference prefix contains no DICOM objects');
    await updateReferenceImport(job.id, { totalInstances: objects.length, progress: 0 });
    const batchSize = Math.max(1, Math.min(50, Number(process.env.REFERENCE_STOW_BATCH_SIZE || 20)));
    let imported = 0;
    for (let index = 0; index < objects.length; index += batchSize) {
      const batch = objects.slice(index, index + batchSize);
      const buffers = await Promise.all(batch.map(object => getObject(study.sourceBucket, object.key)));
      await storeDicomInstances(buffers);
      imported += batch.length;
      await updateReferenceImport(job.id, {
        importedInstances: imported,
        progress: Number(((imported / objects.length) * 100).toFixed(2)),
      });
    }
    await verifyStudyExists(study.studyInstanceUID!);
    await markReferenceStudyPacsVerified(study.id);
    await updateReferenceImport(job.id, {
      status: 'completed', importedInstances: imported, failedInstances: 0, progress: 100,
    });
  } catch (error) {
    await updateReferenceImport(job.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
    });
  }
  return true;
}

export async function processReferenceImportQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (await importClaimed()) { /* drain persistent queue sequentially */ }
  } finally { running = false; }
}
