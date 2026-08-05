import { cache, metaData, volumeLoader } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { Cornerstone3DSEG } from '@cornerstonejs/adapters/cornerstone3D';
import { data as dcmjsData } from 'dcmjs';
import {
  CT_SINUSES_FEATURES,
  CtSinusesFeature,
} from './ctSinusesMeasurements';

export const MINICAT_VOXEL_SEGMENTATION_LABEL = 'CT Sinuses Minicat Voxel Segmentation';
export const MINICAT_VOXEL_SEGMENTATION_ONTOLOGY_VERSION = 'v1';

export interface MinicatVoxelSegmentationContext {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  volumeId: string;
  viewportIds: string[];
}

export interface MinicatSegmentationObjectMetadata {
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  segmentationSeriesInstanceUID?: string;
  segmentationSOPInstanceUID?: string;
  label: string;
  ontologyVersion: string;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  frameOfReferenceUID?: string;
  version?: number;
  supersedesObjectId?: string | null;
}

export interface MinicatDicomSegIdentifiers {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  frameOfReferenceUID?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map(char => `${char}${char}`).join('')
    : normalized;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToDicomCielab(hex: string): [number, number, number] {
  const [red, green, blue] = hexToRgb(hex).map(value => value / 255);
  const linearize = (value: number) => value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
  const r = linearize(red);
  const g = linearize(green);
  const b = linearize(blue);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (value: number) => value > 0.008856
    ? Math.cbrt(value)
    : (7.787 * value) + (16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  const lightness = (116 * fy) - 16;
  const a = 500 * (fx - fy);
  const bValue = 200 * (fy - fz);
  return [
    Math.round(Math.max(0, Math.min(100, lightness)) * 65535 / 100),
    Math.round(Math.max(-128, Math.min(127, a)) * 65535 / 255 + 32768),
    Math.round(Math.max(-128, Math.min(127, bValue)) * 65535 / 255 + 32768),
  ];
}

function hexToRgba(hex: string): [number, number, number, number] {
  const [red, green, blue] = hexToRgb(hex);
  return [red, green, blue, 255];
}

function getSegmentationVolume(segmentationId: string): any {
  const volume = cache.getVolume(segmentationId);
  if (!volume) {
    throw new Error(`Segmentation volume is not available: ${segmentationId}`);
  }
  return volume;
}

function createSegmentMetadata(): Array<Record<string, unknown> | undefined> {
  const metadata: Array<Record<string, unknown> | undefined> = [];
  CT_SINUSES_FEATURES.forEach(feature => {
    metadata[feature.segmentIndex] = {
      SegmentLabel: feature.label,
      SegmentDescription: `${feature.label} · MINICAT SINUS`,
      SegmentAlgorithmType: 'MANUAL',
      SegmentedPropertyCategoryCodeSequence: [{
        CodeValue: '91723000',
        CodingSchemeDesignator: 'SCT',
        CodeMeaning: 'Anatomical structure',
      }],
      SegmentedPropertyTypeCodeSequence: [{
        CodeValue: `MINICAT-${feature.segmentIndex}`,
        CodingSchemeDesignator: '99MINICAT',
        CodeMeaning: feature.label,
      }],
      RecommendedDisplayCIELabValue: rgbToDicomCielab(feature.color),
    };
  });
  return metadata;
}

export function createMinicatSegmentationId(
  studyInstanceUID: string,
  seriesInstanceUID: string
): string {
  return `ct-sinuses-voxel:${studyInstanceUID}:${seriesInstanceUID}`;
}

export async function ensureMinicatLabelmap(
  context: MinicatVoxelSegmentationContext,
  segmentationId = createMinicatSegmentationId(context.studyInstanceUID, context.seriesInstanceUID)
): Promise<string> {
  const segmentationType = cornerstoneTools.Enums.SegmentationRepresentations.Labelmap;
  const existing = cornerstoneTools.segmentation.state.getSegmentation(segmentationId);

  if (!existing) {
    await volumeLoader.createAndCacheDerivedLabelmapVolume(context.volumeId, {
      volumeId: segmentationId,
    });
    cornerstoneTools.segmentation.addSegmentations([{
      segmentationId,
      representation: {
        type: segmentationType,
        data: { volumeId: segmentationId },
      },
      config: {
        label: MINICAT_VOXEL_SEGMENTATION_LABEL,
        segments: Object.fromEntries(CT_SINUSES_FEATURES.map(feature => [
          feature.segmentIndex,
          {
            segmentIndex: feature.segmentIndex,
            label: feature.label,
            active: feature.segmentIndex === CT_SINUSES_FEATURES[0].segmentIndex,
            locked: false,
          },
        ])),
      },
    }]);
  }

  const viewportRepresentationMap = Object.fromEntries(
    context.viewportIds.map(viewportId => [viewportId, [{
      segmentationId,
      type: segmentationType,
    }]])
  );
  cornerstoneTools.segmentation.addLabelmapRepresentationToViewportMap(viewportRepresentationMap);

  context.viewportIds.forEach(viewportId => {
    cornerstoneTools.segmentation.activeSegmentation.setActiveSegmentation(
      viewportId,
      segmentationId
    );
    CT_SINUSES_FEATURES.forEach(feature => {
      cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
        viewportId,
        segmentationId,
        feature.segmentIndex,
        hexToRgba(feature.color)
      );
      cornerstoneTools.segmentation.config.style.setStyle({
        viewportId,
        segmentationId,
        type: segmentationType,
        segmentIndex: feature.segmentIndex,
      }, {
        renderFill: true,
        renderFillInactive: true,
        renderOutline: true,
        renderOutlineInactive: true,
        fillAlpha: 0.42,
        fillAlphaInactive: 0.24,
        outlineOpacity: 1,
        outlineOpacityInactive: 0.8,
        outlineWidth: 2,
        outlineWidthInactive: 1,
      });
    });
  });

  return segmentationId;
}

export function setActiveMinicatSegment(
  segmentationId: string,
  feature: CtSinusesFeature
): void {
  cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex(
    segmentationId,
    feature.segmentIndex
  );
}

export function setMinicatSegmentLocked(
  segmentationId: string,
  feature: CtSinusesFeature,
  locked: boolean
): void {
  cornerstoneTools.segmentation.segmentLocking.setSegmentIndexLocked(
    segmentationId,
    feature.segmentIndex,
    locked
  );
}

export function isMinicatSegmentLocked(
  segmentationId: string,
  feature: CtSinusesFeature
): boolean {
  return cornerstoneTools.segmentation.segmentLocking.isSegmentIndexLocked(
    segmentationId,
    feature.segmentIndex
  );
}

export function setMinicatSegmentVisibility(
  viewportIds: string[],
  segmentationId: string,
  feature: CtSinusesFeature,
  visible: boolean
): void {
  viewportIds.forEach(viewportId => {
    cornerstoneTools.segmentation.config.visibility.setSegmentIndexVisibility(
      viewportId,
      { segmentationId },
      feature.segmentIndex,
      visible
    );
  });
}

export function getMinicatLabelmapData(segmentationId: string): {
  scalarData: Uint8Array;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
  volume: any;
} {
  const volume = getSegmentationVolume(segmentationId);
  const scalarData = volume.voxelManager.getCompleteScalarDataArray() as Uint8Array;
  return {
    scalarData,
    dimensions: [...volume.dimensions] as [number, number, number],
    spacing: [...volume.spacing] as [number, number, number],
    origin: [...volume.origin] as [number, number, number],
    direction: [...volume.direction],
    volume,
  };
}

export function validateMinicatSourceGeometry(
  sourceVolume: any,
  segmentationVolume: any
): void {
  const sourceDimensions = sourceVolume?.dimensions || [];
  const segmentationDimensions = segmentationVolume?.dimensions || [];
  if (sourceDimensions.some((value: number, index: number) => value !== segmentationDimensions[index])) {
    throw new Error('La segmentación no coincide con las dimensiones del volumen CT');
  }

  const sourceSpacing = sourceVolume?.spacing || [];
  const segmentationSpacing = segmentationVolume?.spacing || [];
  if (sourceSpacing.some((value: number, index: number) => Math.abs(value - segmentationSpacing[index]) > 1e-3)) {
    throw new Error('La segmentación no coincide con el spacing del volumen CT');
  }

  const sourceOrigin = sourceVolume?.origin || [];
  const segmentationOrigin = segmentationVolume?.origin || [];
  if (sourceOrigin.some((value: number, index: number) => Math.abs(value - segmentationOrigin[index]) > 1e-3)) {
    throw new Error('La segmentación no coincide con el origen espacial del volumen CT');
  }
}

export function serializeMinicatSegmentation(
  segmentationId: string,
  sourceVolumeId: string,
  label = MINICAT_VOXEL_SEGMENTATION_LABEL
): ArrayBuffer {
  const sourceVolume = cache.getVolume(sourceVolumeId);
  if (!sourceVolume) throw new Error('El volumen CT fuente no está disponible');
  const labelmap = getMinicatLabelmapData(segmentationId);
  validateMinicatSourceGeometry(sourceVolume, labelmap.volume);

  const labelmap3D = Cornerstone3DSEG.Segmentation.generateLabelMaps2DFrom3D({
    scalarData: labelmap.scalarData,
    dimensions: labelmap.dimensions,
    metadata: createSegmentMetadata(),
  });
  const images = sourceVolume.getCornerstoneImages().filter(Boolean);
  if (images.length !== sourceVolume.imageIds.length) {
    throw new Error('No se pudieron cargar todas las imágenes CT para generar el DICOM SEG');
  }

  const segmentation = Cornerstone3DSEG.Segmentation.generateSegmentation(
    images,
    labelmap3D,
    metaData,
    { includeSliceSpacing: true, rleEncode: false }
  );
  segmentation.dataset.SeriesDescription = label;
  segmentation.dataset.SegmentationType = 'BINARY';

  const { DicomMetaDictionary, DicomDict } = dcmjsData as any;
  // dcmjs 0.43.1 does not expose createMetaHeader. Build the file-meta
  // information using the same datasetToDict convention used internally by
  // dcmjs so the generated object is a valid Part 10 DICOM file.
  const metaHeader = DicomMetaDictionary.denaturalizeDataset({
    MediaStorageSOPClassUID: segmentation.dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: segmentation.dataset.SOPInstanceUID,
    ImplementationVersionName: 'dcmjs-0.0',
    TransferSyntaxUID: '1.2.840.10008.1.2.1',
    ImplementationClassUID: '2.25.80302813137786398554742050926734630921603366648225212145404',
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
  });
  const dicomDict = new DicomDict(metaHeader);
  dicomDict.dict = DicomMetaDictionary.denaturalizeDataset(segmentation.dataset);
  return dicomDict.write();
}

export function readMinicatDicomSegIdentifiers(arrayBuffer: ArrayBuffer): MinicatDicomSegIdentifiers {
  const { DicomMessage, DicomMetaDictionary } = dcmjsData as any;
  const message = DicomMessage.readFile(arrayBuffer);
  const dataset = DicomMetaDictionary.naturalizeDataset(message.dict);
  const frameOfReferenceUID = dataset.FrameOfReferenceUID ||
    dataset.ReferencedSeriesSequence?.[0]?.ReferencedInstanceSequence?.[0]?.FrameOfReferenceUID;
  if (!dataset.StudyInstanceUID || !dataset.SeriesInstanceUID || !dataset.SOPInstanceUID) {
    throw new Error('El DICOM SEG generado no contiene sus identificadores DICOM requeridos');
  }
  return {
    studyInstanceUID: dataset.StudyInstanceUID,
    seriesInstanceUID: dataset.SeriesInstanceUID,
    sopInstanceUID: dataset.SOPInstanceUID,
    frameOfReferenceUID,
  };
}

export async function importMinicatDICOMSEG(
  segmentationId: string,
  sourceVolumeId: string,
  sourceImageIds: string[],
  arrayBuffer: ArrayBuffer
): Promise<void> {
  const sourceVolume = cache.getVolume(sourceVolumeId);
  const segmentationVolume = getSegmentationVolume(segmentationId);
  if (!sourceVolume) throw new Error('El volumen CT fuente no está disponible');
  validateMinicatSourceGeometry(sourceVolume, segmentationVolume);

  const result = await Cornerstone3DSEG.Segmentation.createFromDICOMSegBuffer(
    sourceImageIds,
    arrayBuffer,
    { metadataProvider: metaData }
  );
  const labelMapImages = result?.labelMapImages?.[0] || result?.labelMapImages || [];
  const scalarData = segmentationVolume.voxelManager.getCompleteScalarDataArray();
  const sliceLength = segmentationVolume.dimensions[0] * segmentationVolume.dimensions[1];

  if (!Array.isArray(labelMapImages) || labelMapImages.length !== segmentationVolume.dimensions[2]) {
    throw new Error('El DICOM SEG no coincide con el número de cortes del volumen CT');
  }
  scalarData.fill(0);

  for (let sliceIndex = 0; sliceIndex < labelMapImages.length; sliceIndex += 1) {
    const image = labelMapImages[sliceIndex];
    const pixelData = image?.getPixelData?.() || image?.pixelData;
    if (!pixelData) continue;
    if (pixelData.length < sliceLength) {
      throw new Error('El DICOM SEG no coincide con las dimensiones del volumen CT');
    }
    const destinationOffset = sliceIndex * sliceLength;
    for (let pixelIndex = 0; pixelIndex < sliceLength; pixelIndex += 1) {
      scalarData[destinationOffset + pixelIndex] = pixelData[pixelIndex] || 0;
    }
  }
  segmentationVolume.modified();
  cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    segmentationId,
    [...Array(segmentationVolume.dimensions[2]).keys()],
    0
  );
}

export function destroyMinicatSegmentation(segmentationId: string | null): void {
  if (!segmentationId) return;
  if (cornerstoneTools.segmentation.state.getSegmentation(segmentationId)) {
    cornerstoneTools.segmentation.removeSegmentation(segmentationId);
  }
  try {
    cache.removeVolumeLoadObject(segmentationId);
  } catch {
    // The derived volume may already have been released by the rendering engine.
  }
}
