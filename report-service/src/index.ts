import express from 'express';
import cors from 'cors';
import { initDatabase } from './db';
import reportRoutes from './routes/reports';
import annotationRoutes from './routes/annotations';
import segmentationObjectRoutes from './routes/segmentationObjects';
import segmentationJobRoutes from './routes/segmentationJobs';
import referenceStorageRoutes from './routes/referenceStorage';
import { requeueExpiredSegmentationLeases } from './repositories/segmentationJobRepository';
import { processReferenceImportQueue } from './services/referenceImporter';

const app = express();
const PORT = parseInt(process.env.PORT || '3701');

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Routes
app.use('/api', reportRoutes);
app.use('/api', annotationRoutes);
app.use('/api', segmentationObjectRoutes);
app.use('/api', segmentationJobRoutes);
app.use('/api', referenceStorageRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'report-service' });
});

// Start server
async function start() {
  try {
    // Initialize database schema
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Report service running on port ${PORT}`);
    });
    const leaseSweep = setInterval(() => {
      void requeueExpiredSegmentationLeases().catch(error =>
        console.error('Failed to sweep expired segmentation leases:', error)
      );
    }, 60_000);
    leaseSweep.unref();
    const referenceImportSweep = setInterval(() => {
      void processReferenceImportQueue().catch(error =>
        console.error('Failed to process reference import queue:', error)
      );
    }, 10_000);
    referenceImportSweep.unref();
    void processReferenceImportQueue();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
