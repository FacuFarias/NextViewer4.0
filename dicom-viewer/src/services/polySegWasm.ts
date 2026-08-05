import launcher from '@icr/polyseg-wasm/js';
import wasmUrl from '@icr/polyseg-wasm/wasm?url';

/**
 * Browser-safe adapter for the PolySeg WASM package.  The package entrypoint
 * imports the binary as an ESM module, which Rollup attempts to parse inside
 * Cornerstone's worker bundle.  Loading it as a Vite asset keeps the worker
 * bundle valid while preserving the package's locateFile contract.
 */
export default class PolySegWasm {
  private _instance: any = null;

  get instance(): any {
    if (!this._instance) {
      throw new Error('PolySeg WASM is not initialized');
    }
    return this._instance;
  }

  async initialize(params: Record<string, unknown> = {}): Promise<void> {
    this._instance = await launcher({
      locateFile: (file: string) => file.endsWith('.wasm') ? wasmUrl : file,
      ...params,
    });
  }
}
