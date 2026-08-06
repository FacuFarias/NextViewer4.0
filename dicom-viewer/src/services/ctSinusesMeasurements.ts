import * as cornerstoneTools from '@cornerstonejs/tools';

export interface CtSinusesFeature {
  key: string;
  label: string;
  color: string;
  segmentIndex: number;
  /** Initial seed-relative HU tolerance for the 3D region-growing tool. */
  regionGrowToleranceHU: number;
}

export const CT_SINUSES_FEATURES: CtSinusesFeature[] = [
  // These values are seed-relative tolerances. Air-filled spaces use a
  // narrower interval to avoid leaking into adjacent soft tissue, while
  // bone and dense mucosal structures need a wider interval because their
  // CT values vary more across a single structure.
  { key: 'nasal-cavity', label: 'Nasal Cavity', color: '#1976d2', segmentIndex: 1, regionGrowToleranceHU: 90 },
  { key: 'septum', label: 'Septum', color: '#ff8a00', segmentIndex: 2, regionGrowToleranceHU: 180 },
  { key: 'bone-spur', label: 'Bone Spur', color: '#2eaa45', segmentIndex: 3, regionGrowToleranceHU: 220 },
  { key: 'inferior-turbinates', label: 'Inferior Turbinates', color: '#d9232e', segmentIndex: 4, regionGrowToleranceHU: 110 },
  { key: 'middle-turbinates', label: 'Middle Turbinates', color: '#8e5ab6', segmentIndex: 5, regionGrowToleranceHU: 110 },
  { key: 'superior-turbinates', label: 'Superior Turbinates', color: '#815247', segmentIndex: 6, regionGrowToleranceHU: 110 },
  { key: 'concha-bullosa', label: 'Concha Bullosa', color: '#dc5aa8', segmentIndex: 7, regionGrowToleranceHU: 90 },
  { key: 'middle-meatus', label: 'Middle Meatus', color: '#777777', segmentIndex: 8, regionGrowToleranceHU: 75 },
  { key: 'orbits', label: 'Orbits', color: '#b4ba16', segmentIndex: 9, regionGrowToleranceHU: 60 },
  { key: 'maxillary-sinus', label: 'Maxillary Sinus', color: '#1f77b4', segmentIndex: 10, regionGrowToleranceHU: 90 },
  { key: 'sphenoid-sinus', label: 'Sphenoid Sinus', color: '#ff7f0e', segmentIndex: 11, regionGrowToleranceHU: 90 },
  { key: 'frontal-sinus', label: 'Frontal Sinus', color: '#2ca02c', segmentIndex: 12, regionGrowToleranceHU: 90 },
  { key: 'ethmoid-cells', label: 'Ethmoid Cells', color: '#d62728', segmentIndex: 13, regionGrowToleranceHU: 90 },
  { key: 'osteomeatal-complex', label: 'Osteomeatal Complex', color: '#9467bd', segmentIndex: 14, regionGrowToleranceHU: 100 },
  { key: 'hard-palate', label: 'Hard Palate', color: '#8c564b', segmentIndex: 15, regionGrowToleranceHU: 180 },
  { key: 'soft-palate', label: 'Soft Palate', color: '#e377c2', segmentIndex: 16, regionGrowToleranceHU: 70 },
  { key: 'nasopharynx', label: 'Nasopharynx', color: '#7f7f7f', segmentIndex: 17, regionGrowToleranceHU: 70 },
  { key: 'oral-cavity', label: 'Oral Cavity', color: '#bcbd22', segmentIndex: 18, regionGrowToleranceHU: 70 },
  { key: 'cranial-cavity', label: 'Cranial Cavity', color: '#17becf', segmentIndex: 19, regionGrowToleranceHU: 80 },
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
