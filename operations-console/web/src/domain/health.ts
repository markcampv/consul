import type { CheckCounts, HealthStatus } from './types';

/**
 * Worst-of aggregation. A service with zero checks is `none`, not passing:
 * Consul treats it as healthy for routing, but the console must not claim
 * a health signal that does not exist.
 */
export function healthFromChecks(c: CheckCounts): HealthStatus {
  if (c.critical > 0) return 'critical';
  if (c.warning > 0) return 'warning';
  if (c.passing > 0) return 'passing';
  return 'none';
}

const RANK: Record<HealthStatus, number> = { critical: 0, warning: 1, none: 2, passing: 3 };

/** Sort comparator: most severe first. */
export function compareHealth(a: HealthStatus, b: HealthStatus): number {
  return RANK[a] - RANK[b];
}

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  passing: 'Passing',
  warning: 'Warning',
  critical: 'Critical',
  none: 'No checks',
};

/** Normalise a single check status string from any provider. */
export function normaliseCheckStatus(status: string): HealthStatus {
  switch (status) {
    case 'passing':
      return 'passing';
    case 'warning':
      return 'warning';
    case 'critical':
    case 'maintenance':
      return 'critical';
    default:
      return 'none';
  }
}
