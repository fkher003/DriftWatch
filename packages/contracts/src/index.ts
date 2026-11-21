export const faults = ["healthy", "schema", "latency", "http500"] as const;
export type Fault = (typeof faults)[number];
export const samplePath = (fault: Fault) => "/sandbox/sample/" + fault;
export interface SandboxSample {
  service: "checkout";
  items: number | string;
}
export const modes = ["all", "api", "worker", "sandbox"] as const;
export type RunMode = (typeof modes)[number];
export * from "./monitors.js";
