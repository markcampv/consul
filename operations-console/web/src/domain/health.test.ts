import { compareHealth, healthFromChecks, normaliseCheckStatus } from './health';

describe('healthFromChecks', () => {
  it('uses worst-of aggregation', () => {
    expect(healthFromChecks({ passing: 5, warning: 1, critical: 1 })).toBe('critical');
    expect(healthFromChecks({ passing: 5, warning: 1, critical: 0 })).toBe('warning');
    expect(healthFromChecks({ passing: 5, warning: 0, critical: 0 })).toBe('passing');
  });

  it('does not claim health when there are no checks', () => {
    expect(healthFromChecks({ passing: 0, warning: 0, critical: 0 })).toBe('none');
  });
});

describe('compareHealth', () => {
  it('sorts most severe first', () => {
    const list = (['passing', 'none', 'critical', 'warning'] as const).slice().sort(compareHealth);
    expect(list).toEqual(['critical', 'warning', 'none', 'passing']);
  });
});

describe('normaliseCheckStatus', () => {
  it('treats maintenance as critical and unknown values as none', () => {
    expect(normaliseCheckStatus('maintenance')).toBe('critical');
    expect(normaliseCheckStatus('bogus')).toBe('none');
  });
});
