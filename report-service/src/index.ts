import express from 'express';
import cors from 'cors';
import { initDatabase } from './db';
import reportRoutes from './routes/reports';

const app = express();
const PORT = parseInt(process.env.PORT || '3701');

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', reportRoutes);

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
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
