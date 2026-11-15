import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { Point } from '../../domain/layout';
import type { FlowEdge } from './flow';

/** Smooth path with horizontal tangents through each point. */
export function routedPath(points: readonly Point[]): string {
  let d = `M ${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.y === b.y) {
      d += ` L ${b.x},${b.y}`;
      continue;
    }
    const dx = Math.max(24, (b.x - a.x) / 2);
    d += ` C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

/**
 * Edge that follows layout waypoints so relationships spanning several ranks
 * never run behind unrelated services. Falls back to a bezier when there are
 * no waypoints.
 */
export function RoutedEdge(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label, data, interactionWidth } = props;
  const waypoints = data?.waypoints ?? [];
  let path: string;
  let labelX: number;
  let labelY: number;
  if (waypoints.length) {
    const pts = [{ x: sourceX, y: sourceY }, ...waypoints, { x: targetX, y: targetY }];
    path = routedPath(pts);
    const mid = waypoints[Math.floor(waypoints.length / 2)]!;
    labelX = mid.x;
    labelY = mid.y;
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  }
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelShowBg
      labelBgPadding={[4, 2]}
      labelBgBorderRadius={3}
      interactionWidth={interactionWidth ?? 16}
    />
  );
}
