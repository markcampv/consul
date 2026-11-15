/**
 * Raw Consul HTTP API response shapes, as returned by Consul 1.x/3.0-dev.
 * Verified against a live `consul agent -dev` (see scripts/record-fixtures.mjs)
 * and `agent/ui_endpoint.go` / `agent/structs`. Fields are optional where
 * Consul omits them (`json:",omitempty"`) or where editions differ.
 *
 * `/v1/internal/ui/*` endpoints are internal to Consul and carry no
 * compatibility guarantee. Only `mappers.ts` should read these types.
 */

export interface ConsulEnterpriseMeta {
  Namespace?: string;
  Partition?: string;
}

/** Element of GET /v1/internal/ui/services (ServiceListingSummary). */
export interface ConsulServiceListing extends ConsulEnterpriseMeta {
  Kind?: string;
  Name: string;
  Datacenter: string;
  Tags: string[] | null;
  Nodes: string[] | null;
  ExternalSources: string[] | null;
  InstanceCount: number;
  ChecksPassing: number;
  ChecksWarning: number;
  ChecksCritical: number;
  GatewayConfig?: { AssociatedServiceCount?: number; Addresses?: string[] };
  TransparentProxy: boolean;
  ConnectNative: boolean;
  ConnectedWithProxy?: boolean;
  ConnectedWithGateway?: boolean;
  PeerName?: string;
}

export interface ConsulIntentionDecision {
  Allowed: boolean;
  HasPermissions: boolean;
  ExternalSource: string;
  HasExact: boolean;
  DefaultAllow: boolean;
}

/** Element of Upstreams/Downstreams in GET /v1/internal/ui/service-topology/:name. */
export interface ConsulTopologySummary extends Omit<ConsulServiceListing, 'ConnectedWithProxy' | 'ConnectedWithGateway'> {
  /** Why Consul considers this a relationship. See TopologySource* in agent/structs. */
  Source: string;
  Intention: ConsulIntentionDecision;
}

export interface ConsulServiceTopology {
  Protocol: string;
  TransparentProxy: boolean;
  Upstreams: ConsulTopologySummary[] | null;
  Downstreams: ConsulTopologySummary[] | null;
  FilteredByACLs: boolean;
}

export interface ConsulHealthCheck {
  Node: string;
  CheckID: string;
  Name: string;
  Status: string;
  Notes?: string;
  Output: string;
  ServiceID: string;
  ServiceName: string;
  Type?: string;
}

/** Element of GET /v1/health/service/:name. */
export interface ConsulServiceHealthEntry {
  Node: {
    ID?: string;
    Node: string;
    Address: string;
    Datacenter: string;
  };
  Service: {
    ID: string;
    Service: string;
    Kind?: string;
    Tags: string[] | null;
    Address: string;
    Port: number;
    Meta: Record<string, string> | null;
    PeerName?: string;
    Proxy?: {
      DestinationServiceName?: string;
      Mode?: string;
      Upstreams?: Array<{ DestinationName: string; DestinationType?: string; Datacenter?: string; DestinationPeer?: string }>;
    };
    Connect?: { Native?: boolean };
  } & ConsulEnterpriseMeta;
  Checks: ConsulHealthCheck[];
}
