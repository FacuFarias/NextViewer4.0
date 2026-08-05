/**
 * The viewer only uses the Contour representation for its current polygon
 * workflow. PolySeg's optional WASM converter is not needed for that path,
 * but the package imports it from its worker bundle. Keeping a small runtime
 * stub lets the browser build remain self-contained; if a future workflow
 * requests a labelmap/surface conversion, it will fail explicitly instead of
 * silently producing invalid data.
 */
export default class PolySegWasmStub {
  get instance(): never {
    throw new Error('PolySeg WASM conversion is not enabled in this viewer');
  }

  async initialize(): Promise<void> {
    throw new Error('PolySeg WASM conversion is not enabled in this viewer');
  }
}
