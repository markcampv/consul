import { HEALTH_LABEL } from '../domain/health';
import type { EvidenceClass, HealthStatus, IntentionDecision, ServiceKind } from '../domain/types';

export function HealthBadge({ status, compact = false }: { status: HealthStatus; compact?: boolean }) {
  return (
    <span className={`badge health health-${status}`} title={compact ? HEALTH_LABEL[status] : undefined}>
      <span className="dot" aria-hidden="true" />
      {compact ? <span className="sr-only">{HEALTH_LABEL[status]}</span> : HEALTH_LABEL[status]}
    </span>
  );
}

export const EVIDENCE_LABEL: Record<EvidenceClass, string> = {
  declared: 'Declared',
  discovered: 'Discovered',
  inferred: 'Inferred',
  observed: 'Observed',
  unknown: 'Unknown',
};

export const EVIDENCE_HELP: Record<EvidenceClass, string> = {
  declared: 'Explicitly configured, e.g. an upstream in a sidecar registration. Not proof of traffic.',
  discovered: 'Derived from routing configuration such as discovery chains. Not proof of traffic.',
  inferred: 'Possible because policy allows it (transparent proxy + intentions). Not configured, not observed.',
  observed: 'Traffic seen in telemetry. Not available from Consul configuration APIs.',
  unknown: 'Reported by the provider with a label the console does not recognise.',
};

export function EvidenceBadge({ cls }: { cls: EvidenceClass }) {
  return (
    <span className={`badge evidence evidence-${cls}`} title={EVIDENCE_HELP[cls]}>
      <svg width="18" height="6" aria-hidden="true">
        <line x1="0" y1="3" x2="18" y2="3" className={`edge-sample edge-${cls}`} />
      </svg>
      {EVIDENCE_LABEL[cls]}
    </span>
  );
}

export function IntentionBadge({ intention }: { intention: IntentionDecision | undefined }) {
  if (!intention) return <span className="muted">—</span>;
  const label = { allowed: 'Allowed', denied: 'Denied', conditional: 'L7 rules' }[intention.verdict];
  const how =
    intention.match === 'exact'
      ? 'by an exact intention'
      : `by a wildcard intention or the default policy (${intention.defaultPolicy})`;
  const title =
    intention.verdict === 'conditional'
      ? 'The matching intention has L7 permissions; the outcome depends on each request.'
      : `${label} ${how}.`;
  return (
    <span className={`badge intention intention-${intention.verdict}`} title={title}>
      {label}
      {intention.match === 'exact' ? '' : '*'}
    </span>
  );
}

const KIND_LABEL: Record<ServiceKind, string> = {
  service: 'Service',
  'connect-proxy': 'Sidecar proxy',
  'mesh-gateway': 'Mesh gateway',
  'terminating-gateway': 'Terminating gateway',
  'ingress-gateway': 'Ingress gateway',
  'api-gateway': 'API gateway',
  unknown: 'Unknown kind',
};

export function kindLabel(kind: ServiceKind, raw?: string): string {
  return kind === 'unknown' && raw ? raw : KIND_LABEL[kind];
}

export function Tag({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'info' | 'warn'; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {children}
    </span>
  );
}
