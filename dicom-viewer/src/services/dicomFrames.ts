import type { DicomInstance } from '../types/dicom';

export function expandMultiframeInstances(instances: DicomInstance[]): DicomInstance[] {
  return instances.flatMap(instance => {
    const frameCount = Math.max(1, Number(instance.numberOfFrames) || 1);
    if (frameCount === 1) return [{ ...instance, frameNumber: 1 }];
    return Array.from({ length: frameCount }, (_, index) => ({
      ...instance,
      frameNumber: index + 1,
    }));
  });
}

export function getDicomFrameImageId(wadoUriUrl: string, instance: DicomInstance): string {
  const frameNumber = Math.max(1, instance.frameNumber || 1);
  const separator = wadoUriUrl.includes('?') ? '&' : '?';
  return `wadouri:${wadoUriUrl}${separator}frame=${frameNumber}`;
}
