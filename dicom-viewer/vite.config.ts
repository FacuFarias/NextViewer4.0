import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';

function patchPolySegSurfaceUpdater(): Plugin {
  const modulePath = '/node_modules/@cornerstonejs/polymorphic-segmentation/dist/esm/Surface/updateSurfaceData.js';
  const original = 'const viewportIds = getViewportIdsWithSegmentation(segmentationId);';
  const replacement = `const viewportIds = getViewportIdsWithSegmentation(segmentationId).filter((viewportId) => Boolean(getSegmentationRepresentation(viewportId, {
        segmentationId,
        type: SegmentationRepresentations.Surface,
    })));
    if (!viewportIds.length) {
        return;
    }`;
  let applied = false;

  return {
    name: 'patch-cornerstone-polyseg-surface-updater',
    enforce: 'pre',
    buildStart() {
      applied = false;
    },
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes(modulePath)) return null;
      if (!code.includes(original)) {
        this.error('The Cornerstone PolySeg surface updater changed; the compatibility patch must be reviewed.');
      }
      applied = true;
      return {
        code: code.replace(original, replacement),
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && !applied) {
        this.error('The Cornerstone PolySeg surface updater compatibility patch was not applied.');
      }
    },
  };
}

export default defineConfig({
  plugins: [
    patchPolySegSurfaceUpdater(),
    wasm(),
    topLevelAwait(),
    react(),
  ],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  resolve: {
    alias: [
      {
        find: /^@icr\/polyseg-wasm$/,
        replacement: fileURLToPath(
          new URL('./src/services/polySegWasm.ts', import.meta.url)
        ),
      },
    ],
  },
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
      topLevelAwait(),
    ],
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/dcm4chee-arc': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
