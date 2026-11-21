export * from "@driftwatch/contracts";
import {
  scenario,
  type Monitor,
  type Observation,
  type Target,
  type Scenario,
} from "@driftwatch/contracts";
export const scenarios = scenario.options;
export interface DemoMonitor extends Monitor {
  active: boolean;
}
export interface Capture {
  target: Target;
  scenario: Scenario;
  expectedSchema: Record<string, unknown>;
  latencySlaMs: number;
  responseSnippet: string | null;
}
export interface CheckRun extends Observation {
  id: string;
  capture: Capture | null;
}
export interface IncidentRecord {
  id: string;
  monitorId: string;
  kind: string;
  fingerprint: string;
  status: "OPEN" | "RESOLVED";
  failureCount: number;
  openedAt: string;
  resolvedAt: string | null;
}
export interface AlertRecord {
  incidentId: string;
  monitorId: string;
  transition: "OPENED" | "RESOLVED";
  at: string;
  payload: Record<string, unknown>;
}
export interface Workspace {
  monitors: DemoMonitor[];
  runs: CheckRun[];
  incidents: IncidentRecord[];
  alerts: AlertRecord[];
}
export type DemoForm = {
  name: string;
  target: Target;
  intervalMs: number;
  latencySlaMs: number;
  active: boolean;
};
export type DisplayStatus =
  "HEALTHY" | "DRIFT" | "DEGRADED" | "DOWN" | "PENDING" | "PAUSED";
export type WindowMetrics = import("@driftwatch/contracts").Latency & {
  passRate: number | null;
};
