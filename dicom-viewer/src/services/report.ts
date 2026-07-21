const REPORT_API_URL = '/report-api';

export interface Report {
  id: string;
  study_uid: string;
  patient_id: string | null;
  accession_number: string | null;
  report: string | null;
  createdon: string;
  updatedon: string;
}

export async function getReport(studyUID: string): Promise<Report | null> {
  try {
    const response = await fetch(`${REPORT_API_URL}/reports/${studyUID}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get report: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to get report:', error);
    return null;
  }
}

export async function saveReport(
  studyUID: string,
  report: string,
  patientID?: string,
  accessionNumber?: string
): Promise<Report | null> {
  try {
    const response = await fetch(`${REPORT_API_URL}/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        study_uid: studyUID,
        report,
        patient_id: patientID,
        accession_number: accessionNumber,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to save report: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to save report:', error);
    return null;
  }
}

export async function deleteReport(reportId: string): Promise<boolean> {
  try {
    const response = await fetch(`${REPORT_API_URL}/reports/${reportId}`, {
      method: 'DELETE',
    });

    return response.ok;
  } catch (error) {
    console.error('Failed to delete report:', error);
    return false;
  }
}
