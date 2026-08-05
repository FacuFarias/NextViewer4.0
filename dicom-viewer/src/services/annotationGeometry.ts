import { AnnotationGeometry, AnnotationImageMetadata, PersistedAnnotation } from '../types/annotations';
import {
  NASAL_SEPTUM_DEVIATION_CODE,
  NASAL_SEPTUM_DEVIATION_TOOL_NAME,
} from './nasalSeptumDeviation';

const MAX_PERSISTED_CONTOUR_POINTS = 2048;

function asPoints(value: unknown): number[][] {
  if (ArrayBuffer.isView(value)) {
    value = Array.from(value as unknown as ArrayLike<number>);
  }
  if (!Array.isArray(value)) return [];

  const values = value as unknown[];
  if (values.length > 0 && values.every(item => typeof item === 'number')) {
    const dimension = values.length % 3 === 0 ? 3 : 2;
    const points: number[][] = [];
    for (let index = 0; index + dimension <= values.length; index += dimension) {
      points.push(values.slice(index, index + dimension).map(Number));
    }
    return points.filter(point => point.every(Number.isFinite));
  }

  return values
    .map(point => {
      if (ArrayBuffer.isView(point)) return Array.from(point as unknown as ArrayLike<number>).map(Number);
      if (Array.isArray(point)) return point.map(Number);
      if (point && typeof point === 'object' && 'x' in point && 'y' in point) {
        const candidate = point as { x: number; y: number; z?: number };
        return [Number(candidate.x), Number(candidate.y), Number(candidate.z || 0)];
      }
      return [];
    })
    .filter(point => point.length >= 2 && point.every(Number.isFinite));
}

function worldToPixel(viewport: any, worldPoint: number[]): { pixel: { x: number; y: number }; world: { x: number; y: number; z: number } } | null {
  const imageData = viewport.getImageData?.()?.imageData || viewport.getImageData?.();
  const index = imageData?.worldToIndex?.(worldPoint);
  if (!index || !Number.isFinite(index[0]) || !Number.isFinite(index[1])) return null;
  return {
    pixel: { x: Number(index[0]), y: Number(index[1]) },
    world: { x: Number(worldPoint[0]), y: Number(worldPoint[1]), z: Number(worldPoint[2] || 0) },
  };
}

function pixelToWorld(viewport: any, point: { x: number; y: number }): number[] | null {
  const imageData = viewport.getImageData?.()?.imageData || viewport.getImageData?.();
  const world = imageData?.indexToWorld?.([point.x, point.y, 0]);
  return world && world.length >= 3 ? Array.from(world).map(Number) : null;
}

function annotationWorldPoints(annotation: any): number[][] {
  const handles = asPoints(annotation.data?.handles?.points);
  const contour = asPoints(annotation.data?.contour?.polyline);
  // Freehand contours keep the complete geometry in polyline; handles may
  // contain only the active/start point.
  if (contour.length >= 3) return contour;
  return handles.length ? handles : contour;
}

function compactPoints(points: number[][]): number[][] {
  if (points.length <= MAX_PERSISTED_CONTOUR_POINTS) return points;

  const compacted: number[][] = [];
  const step = (points.length - 1) / (MAX_PERSISTED_CONTOUR_POINTS - 1);
  for (let index = 0; index < MAX_PERSISTED_CONTOUR_POINTS; index += 1) {
    compacted.push(points[Math.round(index * step)]);
  }
  return compacted;
}

export function geometryTypeForTool(toolName: string): string {
  const types: Record<string, string> = {
    Length: 'polyline',
    CircleROI: 'circle',
    Angle: 'angle',
    Bidirectional: 'bidirectional',
    RectangleROI: 'rectangle',
    ArrowAnnotate: 'arrow',
    PlanarFreehandContourSegmentationTool: 'polygon',
    [NASAL_SEPTUM_DEVIATION_TOOL_NAME]: NASAL_SEPTUM_DEVIATION_CODE,
  };
  return types[toolName] || 'polygon';
}

export function annotationToGeometry(annotation: any, viewport: any, metadata: AnnotationImageMetadata): AnnotationGeometry {
  const worldPoints = compactPoints(annotationWorldPoints(annotation));
  const converted = worldPoints
    .map(point => worldToPixel(viewport, point))
    .filter((point): point is NonNullable<typeof point> => point !== null);
  const imageWidth = metadata.columns || viewport.getImageData?.()?.dimensions?.[0] || 0;
  const imageHeight = metadata.rows || viewport.getImageData?.()?.dimensions?.[1] || 0;

  const geometry: AnnotationGeometry = {
    coordinateSystem: 'IMAGE_PIXEL',
    imageWidth,
    imageHeight,
    points: converted.map(item => item.pixel),
    patientPoints: converted.length
      ? converted.map(item => item.world)
      : undefined,
    shape: {
      closed: annotation.data?.contour?.closed === true,
      segmentIndex: annotation.data?.segmentation?.segmentIndex,
      cachedStats: annotation.data?.cachedStats || {},
    },
  };

  if (annotation.toolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME || annotation.metadata?.toolName === NASAL_SEPTUM_DEVIATION_TOOL_NAME) {
    const customData = annotation.data?.nasalSeptumDeviation || {};
    const points = geometry.points.slice(0, 4);
    if (points.length >= 4) {
      const pixelSpacing = customData.pixelSpacing || metadata.pixelSpacing;
      geometry.shape = {
        measurement: NASAL_SEPTUM_DEVIATION_CODE,
        axis_start: points[0],
        axis_end: points[1],
        deviation_point: points[2],
        projection_point: points[3],
        axis_length_mm: customData.axisLengthMm,
        deviation_length_mm: customData.deviationLengthMm,
        pixel_spacing: pixelSpacing,
        closed: false,
        cachedStats: {
          axisLengthMm: customData.axisLengthMm,
          deviationLengthMm: customData.deviationLengthMm,
        },
      };
    }
  }

  return geometry;
}

export function geometryToWorldPoints(annotation: PersistedAnnotation, viewport: any): number[][] {
  // The persisted pixel coordinates are the source of truth for a Stack
  // annotation: the viewport has already been moved to the annotation's
  // SOPInstanceUID, so converting them with that image's imageData preserves
  // the exact DICOM slice and its current Cornerstone camera. This is also
  // robust for legacy rows whose patientPoints were generated while another
  // viewport/layout was active.
  const pixelWorldPoints = annotation.geometry.points
    .map(point => pixelToWorld(viewport, point))
    .filter((point): point is number[] => point !== null);

  if (pixelWorldPoints.length > 0) {
    return pixelWorldPoints;
  }

  // patientPoints remain a useful fallback for annotations created by an AI
  // pipeline or older payloads that did not persist IMAGE_PIXEL points.
  const patientPoints = asPoints(annotation.geometry.patientPoints);
  if (patientPoints.length > 0 && patientPoints.every(point => point.length >= 3)) {
    return patientPoints.map(point => point.slice(0, 3));
  }

  return [];
}

export function getReferencedImageId(annotation: any): string | null {
  const referencedImageId = annotation.metadata?.referencedImageId || annotation.data?.referencedImageId;
  return typeof referencedImageId === 'string' ? referencedImageId : null;
}
