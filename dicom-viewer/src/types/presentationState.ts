export interface PresentationGraphic {
  type: 'POINT' | 'POLYLINE' | 'CIRCLE' | 'ELLIPSE';
  points: number[];
  filled?: 'Y' | 'N';
}

export interface PresentationState {
  sopInstanceUID: string;
  sopClassUID: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  referencedSopInstanceUID: string;
  referencedSopClassUID: string;
  referencedFrameNumber?: number;
  creationDate: string;
  creationTime: string;
  contentLabel: string;
  windowCenter?: number;
  windowWidth?: number;
  presentationLUTShape?: 'IDENTITY' | 'INVERSE';
  rows: number;
  columns: number;
  graphics: PresentationGraphic[];
  blob?: Blob;
}
