import {
  finalizeSegmentationJob,
  getSegmentationJobPublication,
  SegmentationJobRepositoryError,
} from '../repositories/segmentationJobRepository';
import { getObject, headObject, segmentationBucket } from './s3';
import { storeDicomSeg, verifyDicomSeg } from './pacs';

export async function publishSegmentationJob(jobId: string) {
  const { job, output, versionId } = await getSegmentationJobPublication(jobId);
  if (output.bucket !== segmentationBucket) {
    throw new SegmentationJobRepositoryError(400, 'Output bucket does not match the configured segmentation bucket');
  }
  const head = await headObject(output.bucket, output.key, output.versionId || versionId || undefined);
  if (head.size !== output.sizeBytes ||
      (head.etag && output.etag && head.etag !== output.etag.replace(/^"|"$/g, '')) ||
      (head.checksumSha256 && head.checksumSha256 !== output.checksumSha256)) {
    throw new SegmentationJobRepositoryError(409, 'Uploaded SEG size, ETag or checksum does not match completion metadata');
  }
  const dicom = await getObject(output.bucket, output.key, output.versionId || head.versionId || undefined);
  await storeDicomSeg(dicom);
  await verifyDicomSeg(job.studyInstanceUID, output.segmentationSeriesInstanceUID, output.segmentationSOPInstanceUID);
  return finalizeSegmentationJob(jobId);
}
