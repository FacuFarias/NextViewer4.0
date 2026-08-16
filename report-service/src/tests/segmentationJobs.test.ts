import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStudySegmentationState } from '../repositories/segmentationJobRepository';
import { outputObjectKey } from '../services/s3';
import { hasPermission } from '../auth';

test('a current SEG remains visible while a replacement is processing', () => {
  assert.equal(deriveStudySegmentationState(true, 'processing'), 'with_seg');
  assert.equal(deriveStudySegmentationState(true, 'failed'), 'with_seg');
});

test('operational job states map to the public study state', () => {
  assert.equal(deriveStudySegmentationState(false, null), 'without_seg');
  assert.equal(deriveStudySegmentationState(false, 'queued'), 'queued');
  assert.equal(deriveStudySegmentationState(false, 'leased'), 'processing');
  assert.equal(deriveStudySegmentationState(false, 'uploading'), 'processing');
  assert.equal(deriveStudySegmentationState(false, 'publishing'), 'processing');
  assert.equal(deriveStudySegmentationState(false, 'failed'), 'failed');
});

test('output keys are deterministic and contain DICOM identifiers only', () => {
  assert.equal(
    outputObjectKey('1.2.3', '4.5.6', '11111111-2222-3333-4444-555555555555'),
    'dicom-seg/1.2.3/4.5.6/11111111-2222-3333-4444-555555555555.dcm'
  );
});

test('segmentation worker role cannot inherit user or admin permissions', () => {
  const worker = { username: 'worker-client', roles: ['segmentation-worker'] };
  assert.equal(hasPermission(worker, 'segmentation:worker'), true);
  assert.equal(hasPermission(worker, 'segmentation:write'), false);
  assert.equal(hasPermission(worker, 'annotation:read'), false);
});

test('admin retains all report and segmentation permissions', () => {
  const admin = { username: 'admin', roles: ['admin', 'segmentation-worker'] };
  assert.equal(hasPermission(admin, 'annotation:read'), true);
  assert.equal(hasPermission(admin, 'segmentation:write'), true);
  assert.equal(hasPermission(admin, 'segmentation:worker'), true);
});
