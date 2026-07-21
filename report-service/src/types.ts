export interface Report {
  id: string;
  study_uid: string;
  patient_id: string | null;
  accession_number: string | null;
  report: string | null;
  createdon: Date;
  updatedon: Date;
}

export interface CreateReportRequest {
  study_uid: string;
  patient_id?: string;
  accession_number?: string;
  report: string;
}

export interface UpdateReportRequest {
  id: string;
  report: string;
}
