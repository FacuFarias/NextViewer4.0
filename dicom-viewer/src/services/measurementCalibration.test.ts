import { describe, expect, it } from 'vitest';
import { angleDegrees, calibratedLength, getMeasurementUnit } from './measurementCalibration';

describe('clinical measurement calibration', () => {
  it('uses millimetres when PixelSpacing is valid', () => {
    expect(getMeasurementUnit([0.5, 0.5])).toBe('mm');
    expect(calibratedLength([0, 0], [100, 0], [0.5, 0.5])).toBeCloseTo(50, 1);
  });

  it('falls back explicitly to pixels without calibration', () => {
    expect(getMeasurementUnit()).toBe('px');
    expect(calibratedLength([0, 0], [100, 0])).toBe(100);
  });

  it('calculates a right angle within the clinical display tolerance', () => {
    expect(angleDegrees([1, 0], [0, 0], [0, 1])).toBeCloseTo(90, 1);
  });
});
