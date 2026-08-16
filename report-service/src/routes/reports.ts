import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import pool from '../db';
import { CreateReportRequest } from '../types';
import { authenticate, requirePermission } from '../auth';

const router = Router();
router.use(authenticate);

// Get report by study UID
router.get('/reports/:studyUID', requirePermission('annotation:read'), async (req: Request, res: Response) => {
  const { studyUID } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM measurements.reports WHERE study_uid = $1 ORDER BY updatedon DESC LIMIT 1',
      [studyUID]
    );

    if (result.rows.length === 0) {
      return res.json(null);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to get report:', error);
    res.status(500).json({ error: 'Failed to get report' });
  }
});

// Get all reports for a study
router.get('/reports/:studyUID/all', requirePermission('annotation:read'), async (req: Request, res: Response) => {
  const { studyUID } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM measurements.reports WHERE study_uid = $1 ORDER BY updatedon DESC',
      [studyUID]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Failed to get reports:', error);
    res.status(500).json({ error: 'Failed to get reports' });
  }
});

// Create or update report
router.post('/reports', requirePermission('annotation:write'), async (req: Request, res: Response) => {
  const { study_uid, patient_id, accession_number, report }: CreateReportRequest = req.body;

  if (!study_uid) {
    return res.status(400).json({ error: 'study_uid is required' });
  }

  try {
    // Check if report exists for this study
    const existing = await pool.query(
      'SELECT id FROM measurements.reports WHERE study_uid = $1 LIMIT 1',
      [study_uid]
    );

    let result;

    if (existing.rows.length > 0) {
      // Update existing report
      result = await pool.query(
        `UPDATE measurements.reports 
         SET report = $1, patient_id = $2, accession_number = $3, updatedon = NOW()
         WHERE study_uid = $4
         RETURNING *`,
        [report, patient_id || null, accession_number || null, study_uid]
      );
    } else {
      // Create new report
      const id = randomUUID();
      result = await pool.query(
        `INSERT INTO measurements.reports (id, study_uid, patient_id, accession_number, report)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, study_uid, patient_id || null, accession_number || null, report]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to save report:', error);
    res.status(500).json({ error: 'Failed to save report' });
  }
});

// Delete report
router.delete('/reports/:reportId', requirePermission('annotation:delete'), async (req: Request, res: Response) => {
  const { reportId } = req.params;

  try {
    await pool.query(
      'DELETE FROM measurements.reports WHERE id = $1',
      [reportId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete report:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// Delete all reports for a study
router.delete('/reports/study/:studyUID', requirePermission('annotation:delete'), async (req: Request, res: Response) => {
  const { studyUID } = req.params;

  try {
    await pool.query(
      'DELETE FROM measurements.reports WHERE study_uid = $1',
      [studyUID]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete reports:', error);
    res.status(500).json({ error: 'Failed to delete reports' });
  }
});

export default router;
