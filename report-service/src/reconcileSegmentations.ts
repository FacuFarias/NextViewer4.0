import pool, { initDatabase } from './db';
import { importHistoricalSegmentationObject } from './repositories/segmentationObjectRepository';
import { getInstanceMetadata, listHistoricalSegSeries, qido } from './services/pacs';

const first = (item: any, tag: string): any => item?.[tag]?.Value?.[0];
const sequenceFirst = (item: any, sequenceTag: string, valueTag: string): any =>
  item?.[sequenceTag]?.Value?.[0]?.[valueTag]?.Value?.[0];
const dicomText = (value: unknown): string => String(value || '').replace(/Â·/g, '·').trim();

async function reconcile(): Promise<void> {
  await initDatabase();
  const series = await listHistoricalSegSeries();
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const seriesItem of series) {
    const studyUID = String(first(seriesItem, '0020000D') || '');
    const seriesUID = String(first(seriesItem, '0020000E') || '');
    if (!studyUID || !seriesUID) { failed += 1; continue; }
    try {
      const instances = await qido(
        `/studies/${encodeURIComponent(studyUID)}/series/${encodeURIComponent(seriesUID)}/instances`
      );
      for (const instance of instances) {
        const sopUID = String(first(instance, '00080018') || '');
        if (!sopUID) continue;
        const metadata = await getInstanceMetadata(studyUID, seriesUID, sopUID);
        const sourceSeriesUID = String(sequenceFirst(metadata, '00081115', '0020000E') || '');
        if (!sourceSeriesUID) throw new Error(`SEG ${sopUID} has no Referenced Series Sequence`);
        const rows = Number(first(metadata, '00280010') || 1);
        const columns = Number(first(metadata, '00280011') || 1);
        const frames = Number(first(metadata, '00280008') || 1);
        const pixelMeasures = metadata?.['52009229']?.Value?.[0]?.['00289110']?.Value?.[0] || {};
        const pixelSpacing = pixelMeasures?.['00280030']?.Value?.map(Number) || [1, 1];
        const sliceSpacing = Number(first(pixelMeasures, '00180088') || first(pixelMeasures, '00180050') || 1);
        const segmentSummary = (metadata?.['00620002']?.Value || []).map((segment: any) => ({
          number: Number(first(segment, '00620004') || 0) || undefined,
          label: dicomText(first(segment, '00620005') || 'Unnamed segment'),
          ...(first(segment, '00620006') ? { description: dicomText(first(segment, '00620006')) } : {}),
        }));
        const result = await importHistoricalSegmentationObject({
          studyInstanceUID: studyUID,
          sourceSeriesInstanceUID: sourceSeriesUID,
          segmentationSeriesInstanceUID: seriesUID,
          segmentationSOPInstanceUID: sopUID,
          dimensions: [columns, rows, frames],
          spacing: [Number(pixelSpacing[1] || 1), Number(pixelSpacing[0] || 1), sliceSpacing],
          frameOfReferenceUID: first(metadata, '00200052') || null,
          segmentSummary,
        });
        result.created ? created += 1 : skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.error('[SEG reconciliation] failed', { studyUID, seriesUID, error });
    }
  }
  console.log('[SEG reconciliation] completed', { created, skipped, failed });
}

reconcile()
  .catch(error => { console.error('[SEG reconciliation] fatal error', error); process.exitCode = 1; })
  .finally(() => pool.end());
