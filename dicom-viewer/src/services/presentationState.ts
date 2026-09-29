import { data as dcmjsData } from 'dcmjs';
import type { DicomInstance, DicomStudy } from '../types/dicom';
import type { PresentationGraphic, PresentationState } from '../types/presentationState';

export const GSPS_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.11.1';
const GRAPHIC_LAYER = 'ANNOTATIONS';

const uid = (): string => `2.25.${BigInt(`0x${crypto.randomUUID().replaceAll('-', '')}`).toString()}`;
const dateTime = () => {
  const now = new Date();
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return {
    date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`,
  };
};

function number(value: any): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asGraphics(annotation: any, viewport: any): PresentationGraphic[] {
  const points = annotation?.data?.handles?.points;
  if (!Array.isArray(points) || points.length === 0) return [];
  const imageData = viewport?.getImageData?.()?.imageData;
  const imagePoints = points.map((point: number[]) => {
    try {
      const index = imageData?.worldToIndex?.(point) || viewport.worldToCanvas(point);
      return [Number(index[0]) + 1, Number(index[1]) + 1];
    } catch {
      const canvas = viewport.worldToCanvas(point);
      return [Number(canvas[0]), Number(canvas[1])];
    }
  }).flat().filter(Number.isFinite);
  if (imagePoints.length < 2) return [];
  const toolName = annotation.toolName || annotation.metadata?.toolName || '';
  if (toolName === 'Probe') return [{ type: 'POINT', points: imagePoints.slice(0, 2) }];
  if (toolName === 'CircleROI' && imagePoints.length >= 4) {
    return [{ type: 'CIRCLE', points: imagePoints.slice(0, 4), filled: 'N' }];
  }
  if (toolName === 'EllipticalROI' && imagePoints.length >= 4) {
    return [{ type: 'ELLIPSE', points: imagePoints.slice(0, 4), filled: 'N' }];
  }
  const closed = ['RectangleROI', 'PlanarFreehandROI'].includes(toolName);
  const polyline = closed && imagePoints.length >= 4
    ? [...imagePoints, imagePoints[0], imagePoints[1]]
    : imagePoints;
  return [{ type: 'POLYLINE', points: polyline }];
}

export function buildPresentationStateDataset(
  study: DicomStudy,
  instance: DicomInstance,
  windowLevel: { windowWidth: number; windowCenter: number },
  invert: boolean,
  annotations: any[],
  viewport: any,
  seriesInstanceUID?: string,
): { dataset: Record<string, any>; state: PresentationState } {
  if (!instance.sopClassUID || !instance.sopInstanceUID || !instance.rows || !instance.columns) {
    throw new Error('La instancia no contiene los identificadores necesarios para crear el PR.');
  }
  if (!['MONOCHROME1', 'MONOCHROME2'].includes(instance.photometricInterpretation?.toUpperCase())) {
    throw new Error('El PR GSPS solo está disponible para imágenes monocromas.');
  }
  const identifiers = dateTime();
  const state: PresentationState = {
    sopInstanceUID: uid(), sopClassUID: GSPS_SOP_CLASS_UID,
    studyInstanceUID: study.studyInstanceUID, seriesInstanceUID: uid(),
    referencedSopInstanceUID: instance.sopInstanceUID, referencedSopClassUID: instance.sopClassUID,
    referencedFrameNumber: instance.frameNumber && instance.numberOfFrames && instance.numberOfFrames > 1 ? instance.frameNumber : undefined,
    creationDate: identifiers.date, creationTime: identifiers.time,
    contentLabel: 'NEXTVIEWER', rows: instance.rows, columns: instance.columns,
    windowCenter: windowLevel.windowCenter, windowWidth: windowLevel.windowWidth,
    presentationLUTShape: invert ? 'INVERSE' : 'IDENTITY',
    graphics: annotations.flatMap(annotation => asGraphics(annotation, viewport)),
  };
  const imageReference = {
    ReferencedSOPClassUID: instance.sopClassUID,
    ReferencedSOPInstanceUID: instance.sopInstanceUID,
    ...(state.referencedFrameNumber ? { ReferencedFrameNumber: state.referencedFrameNumber } : {}),
  };
  const dataset: Record<string, any> = {
    PatientName: study.patientName || 'ANONYMOUS', PatientID: study.patientID || 'UNKNOWN',
    ...(study.patientBirthDate ? { PatientBirthDate: study.patientBirthDate } : {}),
    ...(study.patientSex ? { PatientSex: study.patientSex } : {}),
    StudyInstanceUID: study.studyInstanceUID, SeriesInstanceUID: state.seriesInstanceUID,
    SeriesNumber: 999, InstanceNumber: 1, Modality: 'PR',
    SOPClassUID: state.sopClassUID, SOPInstanceUID: state.sopInstanceUID,
    SeriesDescription: 'NextViewer Presentation States', Manufacturer: 'NextViewer',
    SoftwareVersions: '5.0', ContentLabel: state.contentLabel,
    ContentDescription: 'Clinical presentation state', PresentationCreationDate: state.creationDate,
    PresentationCreationTime: state.creationTime, PresentationLUTShape: state.presentationLUTShape,
    ReferencedSeriesSequence: [{ SeriesInstanceUID: seriesInstanceUID || '', ReferencedImageSequence: [imageReference] }],
    GraphicLayerSequence: [{ GraphicLayer: GRAPHIC_LAYER, GraphicLayerOrder: 1 }],
    DisplayedAreaSelectionSequence: [{
      ReferencedImageSequence: [imageReference], DisplayedAreaTopLeftHandCorner: [1, 1],
      DisplayedAreaBottomRightHandCorner: [instance.columns, instance.rows], PresentationSizeMode: 'SCALE TO FIT',
    }],
    SoftcopyVOILUTSequence: [{ WindowCenter: state.windowCenter, WindowWidth: state.windowWidth, ReferencedImageSequence: [imageReference] }],
  };
  if (state.graphics.length) {
    dataset.GraphicAnnotationSequence = [{ GraphicLayer: GRAPHIC_LAYER, ReferencedImageSequence: [imageReference],
      GraphicObjectSequence: state.graphics.map(graphic => ({
        NumberOfGraphicPoints: graphic.points.length / 2, GraphicData: graphic.points,
        GraphicType: graphic.type, ...(graphic.filled ? { GraphicFilled: graphic.filled } : {}),
      })) }];
  }
  return { dataset, state };
}

export function serializePresentationState(dataset: Record<string, any>): Blob {
  return dcmjsData.datasetToBlob({
    ...dataset,
    _meta: dataset._meta || { TransferSyntaxUID: { Value: ['1.2.840.10008.1.2.1'] } },
  });
}

export function parsePresentationState(buffer: ArrayBuffer): PresentationState {
  const message = dcmjsData.DicomMessage.readFile(buffer);
  const dataset = dcmjsData.DicomMetaDictionary.naturalizeDataset(message.dict);
  const referencedSeries = dataset.ReferencedSeriesSequence?.[0];
  const image = referencedSeries?.ReferencedImageSequence?.[0];
  const displayed = dataset.DisplayedAreaSelectionSequence?.[0];
  const graphics = (dataset.GraphicAnnotationSequence || []).flatMap((annotation: any) =>
    (annotation.GraphicObjectSequence || []).map((graphic: any): PresentationGraphic => ({
      type: graphic.GraphicType, points: (graphic.GraphicData || []).map(Number), filled: graphic.GraphicFilled,
    }))
  );
  return {
    sopInstanceUID: dataset.SOPInstanceUID, sopClassUID: dataset.SOPClassUID,
    studyInstanceUID: dataset.StudyInstanceUID, seriesInstanceUID: dataset.SeriesInstanceUID,
    referencedSopInstanceUID: image?.ReferencedSOPInstanceUID, referencedSopClassUID: image?.ReferencedSOPClassUID,
    referencedFrameNumber: number(image?.ReferencedFrameNumber), creationDate: dataset.PresentationCreationDate || '',
    creationTime: dataset.PresentationCreationTime || '', contentLabel: dataset.ContentLabel || 'PR',
    windowCenter: number(dataset.SoftcopyVOILUTSequence?.[0]?.WindowCenter),
    windowWidth: number(dataset.SoftcopyVOILUTSequence?.[0]?.WindowWidth),
    presentationLUTShape: dataset.PresentationLUTShape, rows: number(displayed?.DisplayedAreaBottomRightHandCorner?.[1]) || 0,
    columns: number(displayed?.DisplayedAreaBottomRightHandCorner?.[0]) || 0, graphics,
  };
}

export function isPresentationStateForInstance(state: PresentationState, instance: DicomInstance): boolean {
  return state.referencedSopInstanceUID === instance.sopInstanceUID &&
    (!state.referencedFrameNumber || state.referencedFrameNumber === instance.frameNumber);
}
