import { Enums, registerImageLoader, utilities } from '@cornerstonejs/core';
import {
  convertRGBColorByPixel,
  convertRGBColorByPlane,
  convertYBRFullByPixel,
  convertYBRFullByPlane,
} from '@cornerstonejs/dicom-image-loader';
import * as dicomParser from 'dicom-parser';
import { Decoder } from 'jpeg-lossless-decoder-js';
import {
  DICOM_PASSWORD,
  DICOM_USERNAME,
  getAccessToken,
  getCacheUserKey,
} from './auth';

const IMAGE_SCHEME = 'usjpeg';

function findMarker(bytes: Uint8Array, first: number, second: number, fromEnd = false): number {
  if (fromEnd) {
    for (let index = bytes.length - 2; index >= 0; index -= 1) {
      if (bytes[index] === first && bytes[index + 1] === second) return index;
    }
    return -1;
  }

  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === first && bytes[index + 1] === second) return index;
  }
  return -1;
}

function extractPixelData(dataSet: dicomParser.DataSet): Uint8Array {
  const element = dataSet.elements.x7fe00010;
  if (!element) throw new Error('US DICOM instance has no PixelData');

  const bytes = dataSet.byteArray;
  const start = findMarker(bytes, 0xff, 0xd8);
  const end = findMarker(bytes, 0xff, 0xd9, true);
  if (start >= 0 && end > start) return bytes.slice(start, end + 2);

  return bytes.slice(element.dataOffset, element.dataOffset + element.length);
}

function getPixelSpacing(dataSet: dicomParser.DataSet): [number, number] {
  const raw = dataSet.string('x00280030');
  const values = raw?.split('\\').map(Number).filter(Number.isFinite) || [];
  return [values[0] || 1, values[1] || 1];
}

function getNumberValues(dataSet: dicomParser.DataSet, tag: string): number[] {
  return (dataSet.string(tag)?.split('\\') || [])
    .map(Number)
    .filter(Number.isFinite);
}

function registerImageMetadata(
  imageId: string,
  dataSet: dicomParser.DataSet,
  rows: number,
  columns: number,
  rowPixelSpacing: number,
  columnPixelSpacing: number
): void {
  const { MetadataModules } = Enums;
  const orientation = getNumberValues(dataSet, 'x00200037');
  const position = getNumberValues(dataSet, 'x00200032');

  utilities.genericMetadataProvider.add(imageId, {
    type: MetadataModules.IMAGE_PIXEL,
    metadata: {
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      pixelRepresentation: 0,
      samplesPerPixel: 3,
      photometricInterpretation: 'RGB',
      planarConfiguration: 0,
      rows,
      columns,
    },
  });
  utilities.genericMetadataProvider.add(imageId, {
    type: MetadataModules.GENERAL_SERIES,
    metadata: {
      modality: dataSet.string('x00080060') || 'US',
      studyInstanceUID: dataSet.string('x0020000d'),
      seriesInstanceUID: dataSet.string('x0020000e'),
    },
  });
  utilities.genericMetadataProvider.add(imageId, {
    type: MetadataModules.GENERAL_IMAGE,
    metadata: {
      sopInstanceUID: dataSet.string('x00080018'),
      instanceNumber: dataSet.intString('x00200013'),
    },
  });
  utilities.genericMetadataProvider.add(imageId, {
    type: MetadataModules.IMAGE_PLANE,
    metadata: {
      frameOfReferenceUID: dataSet.string('x00200052'),
      rows,
      columns,
      rowPixelSpacing,
      columnPixelSpacing,
      rowCosines: orientation.length === 6 ? orientation.slice(0, 3) : [1, 0, 0],
      columnCosines: orientation.length === 6 ? orientation.slice(3, 6) : [0, 1, 0],
      imageOrientationPatient: orientation.length === 6 ? orientation : [1, 0, 0, 0, 1, 0],
      imagePositionPatient: position.length === 3 ? position : [0, 0, 0],
    },
  });
}

function createColorImage(
  imageId: string,
  pixelData: Uint8Array,
  rows: number,
  columns: number,
  rowPixelSpacing: number,
  columnPixelSpacing: number
): Record<string, unknown> {
  const imageFrame = {
    rows,
    columns,
    samplesPerPixel: 3,
    bitsAllocated: 8,
    bitsStored: 8,
    highBit: 7,
    pixelRepresentation: 0,
    photometricInterpretation: 'RGB',
    planarConfiguration: 0,
    pixelData,
    pixelDataLength: pixelData.length,
  };
  let canvas: HTMLCanvasElement | undefined;

  return {
    imageId,
    minPixelValue: 0,
    maxPixelValue: 255,
    slope: 1,
    intercept: 0,
    windowCenter: 128,
    windowWidth: 256,
    voiLUTFunction: 'LINEAR',
    getPixelData: () => pixelData,
    getCanvas: () => {
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = columns;
        canvas.height = rows;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create US canvas context');
        const imageData = context.createImageData(columns, rows);
        let targetIndex = 0;
        for (let sourceIndex = 0; sourceIndex < pixelData.length; sourceIndex += 3) {
          imageData.data[targetIndex++] = pixelData[sourceIndex];
          imageData.data[targetIndex++] = pixelData[sourceIndex + 1];
          imageData.data[targetIndex++] = pixelData[sourceIndex + 2];
          imageData.data[targetIndex++] = 255;
        }
        context.putImageData(imageData, 0, 0);
      }
      return canvas;
    },
    rows,
    columns,
    height: rows,
    width: columns,
    color: true,
    rgba: false,
    numberOfComponents: 3,
    rowPixelSpacing,
    columnPixelSpacing,
    invert: false,
    photometricInterpretation: 'RGB',
    sizeInBytes: pixelData.byteLength,
    dataType: 'Uint8Array',
    imageFrame,
  };
}

async function loadUsLosslessImage(imageId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = imageId.slice(`${IMAGE_SCHEME}:`.length);
  const token = await getAccessToken(DICOM_USERNAME, DICOM_PASSWORD);
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/dicom',
      Authorization: `Bearer ${token}`,
      'X-Dicom-Cache-User': getCacheUserKey(),
    },
  });
  if (!response.ok) throw new Error(`US DICOM error: ${response.status} ${response.statusText}`);

  const dataSet = dicomParser.parseDicom(new Uint8Array(await response.arrayBuffer()));
  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  const samplesPerPixel = dataSet.uint16('x00280002') || 1;
  const photometricInterpretation = dataSet.string('x00280004') || '';
  const planarConfiguration = dataSet.uint16('x00280006') || 0;
  if (!rows || !columns || samplesPerPixel !== 3 || !['RGB', 'YBR_FULL'].includes(photometricInterpretation)) {
    throw new Error(`Unsupported US pixel format: ${photometricInterpretation || 'unknown'}`);
  }

  const encodedOrRawPixelData = extractPixelData(dataSet);
  const jpegStart = findMarker(encodedOrRawPixelData, 0xff, 0xd8);
  const jpegEnd = findMarker(encodedOrRawPixelData, 0xff, 0xd9, true);
  const isJpeg = jpegStart >= 0 && jpegEnd > jpegStart;
  const pixelData = isJpeg
    ? new Uint8Array(new Decoder().decode(
      encodedOrRawPixelData.buffer,
      encodedOrRawPixelData.byteOffset + jpegStart,
      jpegEnd - jpegStart + 2,
      1
    ))
    : encodedOrRawPixelData;

  const expectedLength = rows * columns * samplesPerPixel;
  if (pixelData.length !== expectedLength) {
    throw new Error(`US decoded pixel length ${pixelData.length} does not match ${expectedLength}`);
  }

  // Keep the cached voxel data as RGB, matching Cornerstone's native color
  // images. RGBA causes a different first-frame GPU path and can be mutated
  // to RGB only after the viewport has already rendered once.
  const rgb = new Uint8Array(rows * columns * 3);
  if (photometricInterpretation === 'YBR_FULL') {
    // JPEG decoders always return interleaved components. PlanarConfiguration
    // only describes native, uncompressed PixelData and must not be applied to
    // the decoded JPEG buffer.
    if (!isJpeg && planarConfiguration === 1) convertYBRFullByPlane(pixelData, rgb, false);
    else convertYBRFullByPixel(pixelData, rgb, false);
  } else if (!isJpeg && planarConfiguration === 1) {
    convertRGBColorByPlane(pixelData, rgb, false);
  } else {
    convertRGBColorByPixel(pixelData, rgb, false);
  }

  const [rowPixelSpacing, columnPixelSpacing] = getPixelSpacing(dataSet);
  registerImageMetadata(
    imageId,
    dataSet,
    rows,
    columns,
    rowPixelSpacing,
    columnPixelSpacing
  );
  return createColorImage(imageId, rgb, rows, columns, rowPixelSpacing, columnPixelSpacing);
}

export function registerUsLosslessImageLoader(): void {
  registerImageLoader(IMAGE_SCHEME, (imageId: string) => {
    const controller = new AbortController();
    return {
      promise: loadUsLosslessImage(imageId, controller.signal),
      cancelFn: () => controller.abort(),
    };
  });
}

export function getUsLosslessImageId(url: string): string {
  return `${IMAGE_SCHEME}:${url}`;
}
