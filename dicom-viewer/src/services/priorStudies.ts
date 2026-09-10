import type { DicomStudy } from '../types/dicom';

const normalizePatientID = (value?: string): string => (value || '').trim().toUpperCase();
const chronologyKey = (study: DicomStudy): string => {
  const date = (study.studyDate || '').replace(/\D/g, '').padEnd(8, '0').slice(0, 8);
  const time = (study.studyTime || '').replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
  return `${date}${time}`;
};

/** Keeps only studies that precede the opened study and belong to the same PatientID. */
export function selectPriorStudies(currentStudy: DicomStudy, candidates: DicomStudy[]): DicomStudy[] {
  const patientID = normalizePatientID(currentStudy.patientID);
  const currentDate = (currentStudy.studyDate || '').replace(/\D/g, '').slice(0, 8);

  return candidates
    .filter(candidate => candidate.studyInstanceUID && candidate.studyInstanceUID !== currentStudy.studyInstanceUID)
    .filter(candidate => !patientID || normalizePatientID(candidate.patientID) === patientID)
    // A missing date is kept because legacy studies do not always carry StudyDate.
    .filter(candidate => !currentDate || !candidate.studyDate || candidate.studyDate <= currentDate)
    .sort((left, right) => chronologyKey(right).localeCompare(chronologyKey(left)) ||
      right.studyInstanceUID.localeCompare(left.studyInstanceUID));
}
