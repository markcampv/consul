import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useSettings } from '../../app/settings';
import { useDatacenter, useDcLink } from '../../app/useDatacenter';
import { EVIDENCE_HELP, EVIDENCE_LABEL, EvidenceBadge, HealthBadge, Tag, kindLabel } from '../../components/Badges';
import { EmptyState, ErrorState, FetchedAt, Loading, Notice, PageHeader } from '../../components/States';
import { DEFAULT_FILTER, filterGraph, relationshipsOf, type GraphFilter } from '../../domain/graph';
import type { EvidenceClass, TopologyGraph } from '../../domain/types';
import { useMeshTopology, useServices } from '../../providers/consul/queries';
import { EvidenceList } from './EvidenceList';
import { RelationshipTable } from './RelationshipTable';
import { RoutedEdge } from './RoutedEdge';
import { toFlow, type FlowEdge, type FlowNode, type LabelFlowNode, type ServiceFlowNode } from './flow';

const EXTERNAL_LABEL = { remote: 'other DC', peer: 'peer', virtual: 'virtual' } as const;

function ServiceNode({ data, selected }: NodeProps<ServiceFlowNode>) {
  const s = data.node.service;
  return (
    <div className={`topo-node health-${s.health}${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="topo-node-title">
        <HealthBadge status={s.health} compact />
        <span className="name">{s.ref.name}</span>
      </div>
      <div className="topo-node-meta">
        {s.kind !== 'service' ? <span>{kindLabel(s.kind, s.rawKind)}</span> : null}
        {data.node.external ? <span className="tag-inline">{EXTERNAL_LABEL[data.node.external]}</span> : null}
        {data.node.external !== 'virtual' ? (
          <span>
            {s.instanceCount} inst
          </span>
        ) : (
          <span>routing only</span>
        )}
        {s.transparentProxy ? <span>tproxy</span> : null}
        {!s.meshEnabled && !data.node.external && s.kind === 'service' ? (
          <span>{s.behindGateway ? 'via gateway' : 'not in mesh'}</span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function LabelNode({ data }: NodeProps<LabelFlowNode>) {
  return <div className="topo-label">{data.label}</div>;
}

const nodeTypes = { service: ServiceNode, label: LabelNode };
const edgeTypes = { routed: RoutedEdge };

const MINIMAP_COLOR: Record<string, string> = { passing: '#059669', warning: '#d97706', critical: '#dc2626', none: '#94a3b8' };

type Selection = { kind: 'edge'; id: string } | null;

const TOGGLEABLE: EvidenceClass[] = ['declared', 'discovered', 'inferred', 'unknown'];

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      {(['declared', 'discovered', 'inferred'] as const).map((c) => (
        <EvidenceBadge key={c} cls={c} />
      ))}
      <span className="badge evidence evidence-denied" title="An intention denies this connection">
        <svg width="18" height="6" aria-hidden="true">
          <line x1="0" y1="3" x2="18" y2="3" className="edge-sample edge-denied" />
        </svg>
        Denied
      </span>
      <span className="muted small">
        No line represents observed traffic: Consul’s configuration APIs do not report live traffic.
      </span>
    </div>
  );
}

function FitOnFocus({ ids, version }: { ids: string[] | null; version: number }) {
  const rf = useReactFlow();
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (ids && ids.length) void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.35, duration: 300, maxZoom: 1.2 });
      else void rf.fitView({ padding: 0.15, duration: 200 });
    }, 30);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return null;
}

function NodePanel({ graph, id, filter, onClose }: { graph: TopologyGraph; id: string; filter: GraphFilter; onClose: () => void }) {
  const dcLink = useDcLink();
  const node = graph.nodes.get(id);
  if (!node) return null;
  const s = node.service;
  const all = relationshipsOf(graph, id);
  const visible = filterGraph(graph, filter).edges;
  const visibleIds = new Set(visible.map((e) => e.id));
  const ups = all.upstreams.filter((r) => visibleIds.has(r.id));
  const downs = all.downstreams.filter((r) => visibleIds.has(r.id));
  const hidden = all.upstreams.length + all.downstreams.length - ups.length - downs.length;
  const issue = graph.issues.find((i) => i.serviceId === id);
  return (
    <aside className="side-panel" aria-label={`Details for ${s.ref.name}`}>
      <div className="side-head">
        <h2>{s.ref.name}</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <p>
        <HealthBadge status={s.health} /> {kindLabel(s.kind, s.rawKind)}
        {node.external ? <Tag>{EXTERNAL_LABEL[node.external]}</Tag> : null}
      </p>
      <dl className="kv">
        <dt>Instances</dt>
        <dd>{s.instanceCount}</dd>
        <dt>Checks</dt>
        <dd>
          {s.checks.passing} passing · {s.checks.warning} warning · {s.checks.critical} critical
        </dd>
        <dt>Datacenter</dt>
        <dd>{s.ref.peer ? `peer ${s.ref.peer}` : s.ref.datacenter}</dd>
      </dl>
      {node.external === 'virtual' ? (
        <Notice>Virtual service: it has no instances and exists only as discovery-chain configuration.</Notice>
      ) : null}
      {issue ? <Notice tone="warn">Relationships may be incomplete: {issue.message}</Notice> : null}
      <p>
        <Link className="btn btn-sm" to={dcLink(`/services/${encodeURIComponent(s.ref.name)}`)}>
          Open service details
        </Link>
      </p>
      <h3>
        Upstreams <span className="count">{ups.length}</span>
      </h3>
      {ups.length ? <RelationshipTable graph={graph} relationships={ups} side="to" /> : <p className="muted small">None visible.</p>}
      <h3>
        Downstreams <span className="count">{downs.length}</span>
      </h3>
      {downs.length ? <RelationshipTable graph={graph} relationships={downs} side="from" /> : <p className="muted small">None visible.</p>}
      {hidden > 0 ? <p className="muted small">{hidden} more hidden by the current filters.</p> : null}
    </aside>
  );
}

function EdgePanel({ graph, id, filter, onClose }: { graph: TopologyGraph; id: string; filter: GraphFilter; onClose: () => void }) {
  const rel = filterGraph(graph, filter).edges.find((e) => e.id === id) ?? graph.edges.get(id);
  if (!rel) return null;
  const name = (nid: string) => graph.nodes.get(nid)?.service.ref.name ?? nid;
  return (
    <aside className="side-panel" aria-label="Relationship details">
      <div className="side-head">
        <h2>
          {name(rel.from)} <span aria-hidden="true">→</span>
          <span className="sr-only">to</span> {name(rel.to)}
        </h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <p className="muted small">
        {name(rel.from)} is the downstream (caller); {name(rel.to)} is the upstream.
      </p>
      <EvidenceList graph={graph} rel={rel} />
    </aside>
  );
}

function TopologyCanvas({ graph }: { graph: TopologyGraph }) {
  const { resolvedTheme } = useSettings();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<GraphFilter>(DEFAULT_FILTER);
  const [showIsolated, setShowIsolated] = useState(true);
  const [edgeSel, setEdgeSel] = useState<Selection>(null);
  const [search, setSearch] = useState('');
  const [fitVersion, setFitVersion] = useState(0);

  const byName = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of graph.nodes.values()) if (!m.has(n.service.ref.name)) m.set(n.service.ref.name, n.id);
    return m;
  }, [graph]);
  const focusName = params.get('focus');
  const selectedNode = focusName ? byName.get(focusName) : undefined;

  const filtered = useMemo(() => filterGraph(graph, filter), [graph, filter]);
  const { nodes, edges } = useMemo(
    () =>
      toFlow(filtered, {
        showIsolated: showIsolated || Boolean(selectedNode && filtered.isolated.some((n) => n.id === selectedNode)),
        selectedNode,
        selectedEdge: edgeSel?.id,
        theme: resolvedTheme,
      }),
    [filtered, showIsolated, selectedNode, edgeSel, resolvedTheme]
  );

  const selectNode = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      const name = id ? graph.nodes.get(id)?.service.ref.name : undefined;
      if (name) next.set('focus', name);
      else next.delete('focus');
      setParams(next, { replace: true });
      setEdgeSel(null);
      setFitVersion((v) => v + 1);
    },
    [graph, params, setParams]
  );
  const selectEdge = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.delete('focus');
      setParams(next, { replace: true });
      setEdgeSel({ kind: 'edge', id });
    },
    [params, setParams]
  );
  const clear = useCallback(() => {
    if (selectedNode) selectNode(null);
    setEdgeSel(null);
  }, [selectedNode, selectNode]);

  // Keyboard selection (Enter on a focused node/edge) arrives as "select" changes.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const sel = changes.find((c) => c.type === 'select' && c.selected);
      if (sel && 'id' in sel && sel.id !== selectedNode && graph.nodes.has(sel.id)) selectNode(sel.id);
    },
    [graph, selectNode, selectedNode]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      const sel = changes.find((c) => c.type === 'select' && c.selected);
      if (sel && 'id' in sel && sel.id !== edgeSel?.id) selectEdge(sel.id);
    },
    [edgeSel, selectEdge]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  const focusIds = useMemo(() => {
    if (selectedNode) {
      const ids = new Set([selectedNode]);
      for (const e of filtered.edges) {
        if (e.from === selectedNode) ids.add(e.to);
        if (e.to === selectedNode) ids.add(e.from);
      }
      return [...ids];
    }
    return null;
  }, [selectedNode, filtered]);

  const names = useMemo(() => [...byName.keys()].sort(), [byName]);
  const submitSearch = () => {
    const q = search.trim().toLowerCase();
    if (!q) return;
    const exact = names.find((n) => n.toLowerCase() === q);
    const hit = exact ?? names.find((n) => n.toLowerCase().startsWith(q)) ?? names.find((n) => n.toLowerCase().includes(q));
    if (hit) selectNode(byName.get(hit)!);
  };

  const toggleClass = (c: EvidenceClass) => {
    const classes = new Set(filter.classes);
    if (classes.has(c)) classes.delete(c);
    else classes.add(c);
    setFilter({ ...filter, classes });
  };

  return (
    <>
      <div className="toolbar topo-toolbar">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <input
            type="search"
            data-primary-search
            list="topology-services"
            placeholder="Focus a service  ( / )"
            aria-label="Focus a service by name"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              const id = byName.get(e.target.value);
              if (id) selectNode(id);
            }}
          />
          <datalist id="topology-services">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </form>
        <fieldset className="chip-group">
          <legend className="sr-only">Evidence to show</legend>
          {TOGGLEABLE.map((c) => (
            <label key={c} className="chip" title={EVIDENCE_HELP[c]}>
              <input type="checkbox" checked={filter.classes.has(c)} onChange={() => toggleClass(c)} />
              {EVIDENCE_LABEL[c]}
            </label>
          ))}
          <label className="chip" title="Relationships that exist only because of the ACL default policy (allow) or wildcard intentions on transparent proxies">
            <input
              type="checkbox"
              checked={filter.includeBroad}
              onChange={() => setFilter({ ...filter, includeBroad: !filter.includeBroad })}
            />
            Broad-policy inferences
            {!filter.includeBroad && filtered.hiddenBroadEdges ? (
              <span className="count">{filtered.hiddenBroadEdges} hidden</span>
            ) : null}
          </label>
          <label className="chip">
            <input type="checkbox" checked={showIsolated} onChange={() => setShowIsolated(!showIsolated)} />
            Unconnected <span className="count">{filtered.isolated.length}</span>
          </label>
        </fieldset>
      </div>

      <p className="muted small topo-summary" aria-live="polite">
        {filtered.connected.length} services with {filtered.edges.length} visible relationships
        {filtered.hiddenEdges ? ` · ${filtered.hiddenEdges} hidden by filters` : ''} · {graph.inspected} services inspected
      </p>

      <div className={`topology-layout${selectedNode || edgeSel ? ' with-panel' : ''}`}>
        <div className="topology-canvas">
          {nodes.length === 0 ? (
            <EmptyState title="Nothing to draw">
              No services or relationships match the current filters.
            </EmptyState>
          ) : (
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              colorMode={resolvedTheme}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, n) => graph.nodes.has(n.id) && selectNode(n.id)}
              onEdgeClick={(_, e) => selectEdge(e.id)}
              onPaneClick={clear}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable
              nodesFocusable
              fitView
              minZoom={0.15}
              maxZoom={2}
              proOptions={{ hideAttribution: false }}
            >
              <Background gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                ariaLabel="Topology minimap"
                nodeColor={(n) => (n.type === 'service' ? MINIMAP_COLOR[(n as ServiceFlowNode).data.node.service.health]! : 'transparent')}
              />
              <FitOnFocus ids={focusIds} version={fitVersion} />
            </ReactFlow>
          )}
        </div>
        {selectedNode ? <NodePanel graph={graph} id={selectedNode} filter={filter} onClose={() => selectNode(null)} /> : null}
        {!selectedNode && edgeSel ? <EdgePanel graph={graph} id={edgeSel.id} filter={filter} onClose={() => setEdgeSel(null)} /> : null}
      </div>
      <Legend />
    </>
  );
}

export function TopologyPage() {
  const { dc } = useDatacenter();
  const services = useServices(dc);
  const topology = useMeshTopology(dc);
  const [params] = useSearchParams();
  const focus = params.get('focus');

  return (
    <div className="page page-wide">
      <PageHeader
        title="Topology"
        subtitle={
          <>
            Service relationships in <strong>{dc ?? '…'}</strong> from Consul’s service topology: what is{' '}
            <em>configured or permitted</em>, not observed traffic. Select a service or a line for evidence.
          </>
        }
        actions={
          <FetchedAt
            iso={topology.data?.fetchedAt}
            source="GET /v1/internal/ui/services + /v1/internal/ui/service-topology/:name per mesh service"
            onRefresh={() => {
              void services.refetch();
              void topology.refetch();
            }}
            busy={topology.isFetching}
          />
        }
      />
      {services.data?.meta.filteredByACLs ? (
        <Notice tone="warn">
          <strong>Partial view.</strong> Consul hid some services from your token, so the graph may be missing nodes and
          relationships.
        </Notice>
      ) : null}
      {topology.data && topology.data.issues.length > 0 ? (
        <Notice tone="warn">
          <strong>
            {topology.data.issues.length} service{topology.data.issues.length === 1 ? '' : 's'} could not be fully
            inspected.
          </strong>{' '}
          Relationships involving them may be missing.
          <details>
            <summary>Details</summary>
            <ul>
              {topology.data.issues.map((i) => (
                <li key={i.serviceId + i.kind}>
                  <code>{topology.data.nodes.get(i.serviceId)?.service.ref.name ?? i.serviceId}</code>: {i.kind} — {i.message}
                </li>
              ))}
            </ul>
          </details>
        </Notice>
      ) : null}
      {focus && topology.data && ![...topology.data.nodes.values()].some((n) => n.service.ref.name === focus) ? (
        <Notice tone="warn">
          “{focus}” is not part of the topology in {dc}.
        </Notice>
      ) : null}
      {topology.isPending ? <Loading label="Building topology (one request per mesh service)…" /> : null}
      {topology.isError ? <ErrorState error={topology.error} what="topology" /> : null}
      {topology.isSuccess && topology.data.nodes.size === 0 ? (
        <EmptyState title="No services">Nothing is registered in {dc}, or your token cannot read any services.</EmptyState>
      ) : null}
      {topology.isSuccess && topology.data.nodes.size > 0 ? (
        <ReactFlowProvider>
          <TopologyCanvas graph={topology.data} />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}
