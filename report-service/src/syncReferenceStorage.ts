import { initDatabase } from './db';
import pool from './db';
import { referenceBasePrefix, referenceBucket, synchronizeReferenceCatalog } from './services/referenceCatalog';

async function main(): Promise<void> {
  await initDatabase();
  console.log(`Scanning s3://${referenceBucket}/${referenceBasePrefix}`);
  const result = await synchronizeReferenceCatalog({
    concurrency: Math.max(1, Number(process.env.REFERENCE_SCAN_CONCURRENCY || 12)),
    onProgress: progress => {
      if (progress.completed % 25 === 0 || progress.completed === progress.total) {
        console.log(`Reference scan ${progress.completed}/${progress.total}; failures=${progress.failed}`);
      }
    },
  });
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 2;
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
