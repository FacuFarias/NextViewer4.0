import * as cornerstoneTools from '@cornerstonejs/tools';

export interface CtSinusesFeature {
  key: string;
  label: string;
  color: string;
  segmentIndex: number;
}

export const CT_SINUSES_FEATURES: CtSinusesFeature[] = [
  { key: 'nasal-cavity', label: 'Nasal Cavity', color: '#1976d2', segmentIndex: 1 },
  { key: 'septum', label: 'Septum', color: '#ff8a00', segmentIndex: 2 },
  { key: 'bone-spur', label: 'Bone Spur', color: '#2eaa45', segmentIndex: 3 },
  { key: 'inferior-turbinates', label: 'Inferior Turbinates', color: '#d9232e', segmentIndex: 4 },
  { key: 'middle-turbinates', label: 'Middle Turbinates', color: '#8e5ab6', segmentIndex: 5 },
  { key: 'superior-turbinates', label: 'Superior Turbinates', color: '#815247', segmentIndex: 6 },
  { key: 'concha-bullosa', label: 'Concha Bullosa', color: '#dc5aa8', segmentIndex: 7 },
  { key: 'middle-meatus', label: 'Middle Meatus', color: '#777777', segmentIndex: 8 },
  { key: 'orbits', label: 'Orbits', color: '#b4ba16', segmentIndex: 9 },
  { key: 'maxillary-sinus', label: 'Maxillary Sinus', color: '#1f77b4', segmentIndex: 10 },
  { key: 'sphenoid-sinus', label: 'Sphenoid Sinus', color: '#ff7f0e', segmentIndex: 11 },
  { key: 'frontal-sinus', label: 'Frontal Sinus', color: '#2ca02c', segmentIndex: 12 },
  { key: 'ethmoid-cells', label: 'Ethmoid Cells', color: '#d62728', segmentIndex: 13 },
  { key: 'osteomeatal-complex', label: 'Osteomeatal Complex', color: '#9467bd', segmentIndex: 14 },
  { key: 'hard-palate', label: 'Hard Palate', color: '#8c564b', segmentIndex: 15 },
  { key: 'soft-palate', label: 'Soft Palate', color: '#e377c2', segmentIndex: 16 },
  { key: 'nasopharynx', label: 'Nasopharynx', color: '#7f7f7f', segmentIndex: 17 },
  { key: 'oral-cavity', label: 'Oral Cavity', color: '#bcbd22', segmentIndex: 18 },
  { key: 'cranial-cavity', label: 'Cranial Cavity', color: '#17becf', segmentIndex: 19 },
];

export const CT_SINUSES_TOOL_NAME =
  cornerstoneTools.PlanarFreehandContourSegmentationTool.toolName;

const CT_SINUSES_SEGMENTATION_LABEL = 'CT Sinuses Minicat Measurements';

function hexToRgba(hex: string): [number, number, number, number] {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map(char => `${char}${char}`).join('')
    : normalized;

  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
    255,
  ];
}

export function createCtSinusesSegmentationId(
  studyInstanceUID: string,
  seriesInstanceUID: string
): string {
  return `ct-sinuses-minicat:${studyInstanceUID}:${seriesInstanceUID}`;
}

export function initializeCtSinusesSegmentation(
  viewportId: string,
  studyInstanceUID: string,
  seriesInstanceUID: string
): string {
  const segmentationId = createCtSinusesSegmentationId(studyInstanceUID, seriesInstanceUID);
  const segmentationType = cornerstoneTools.Enums.SegmentationRepresentations.Contour;
  const existing = cornerstoneTools.segmentation.state.getSegmentation(segmentationId);

  if (!existing) {
    const segments = Object.fromEntries(
      CT_SINUSES_FEATURES.map(feature => [
        feature.segmentIndex,
        {
          segmentIndex: feature.segmentIndex,
          label: feature.label,
          active: feature.segmentIndex === CT_SINUSES_FEATURES[0].segmentIndex,
          locked: false,
        },
      ])
    );

    cornerstoneTools.segmentation.addSegmentations([
      {
        segmentationId,
        representation: {
          type: segmentationType,
        },
        config: {
          label: CT_SINUSES_SEGMENTATION_LABEL,
          segments,
        },
      },
    ]);
  }

  cornerstoneTools.segmentation.addContourRepresentationToViewport(viewportId, [
    { segmentationId },
  ]);
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
    cornerstoneTools.segmentation.config.style.setStyle(
      {
        viewportId,
        segmentationId,
        type: segmentationType,
        segmentIndex: feature.segmentIndex,
      },
      {
        renderFill: true,
        renderFillInactive: true,
        renderOutline: true,
        renderOutlineInactive: true,
        fillAlpha: 0.35,
        fillAlphaInactive: 0.25,
        outlineOpacity: 1,
        outlineOpacityInactive: 0.85,
        outlineWidth: 2,
        outlineWidthInactive: 1,
      }
    );
  });

  return segmentationId;
}

export function setActiveCtSinusesFeature(
  viewportId: string,
  segmentationId: string,
  feature: CtSinusesFeature
): void {
  cornerstoneTools.segmentation.activeSegmentation.setActiveSegmentation(
    viewportId,
    segmentationId
  );
  cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex(
    segmentationId,
    feature.segmentIndex
  );
}

export function clearCtSinusesSegmentation(segmentationId: string | null): void {
  if (!segmentationId) return;

  const annotations = cornerstoneTools.annotation.state.getAllAnnotations();
  annotations
    .filter((annotation: any) => annotation.data?.segmentation?.segmentationId === segmentationId)
    .forEach((annotation: any) => {
      cornerstoneTools.utilities?.contourSegmentation?.removeContourSegmentationAnnotation?.(
        annotation
      );
      cornerstoneTools.annotation.state.removeAnnotation(annotation.annotationUID);
    });

  if (cornerstoneTools.segmentation.state.getSegmentation(segmentationId)) {
    cornerstoneTools.segmentation.removeSegmentation(segmentationId);
  }
}
