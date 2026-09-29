declare module 'dcmjs' {
  export const data: {
    datasetToBlob(dataset: Record<string, any>): Blob;
    datasetToBuffer(dataset: Record<string, any>): ArrayBuffer | Uint8Array;
    DicomMessage: { readFile(input: ArrayBuffer): { dict: Record<string, any> } };
    DicomMetaDictionary: {
      naturalizeDataset(dataset: Record<string, any>): Record<string, any>;
    };
  };
}
