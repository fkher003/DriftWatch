import type {
  Workspace,
  WindowMetrics,
  Observation,
  Scenario,
  DemoForm,
} from "@driftwatch/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/demo/" + path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "x-driftwatch-demo": "1",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const issues = error.issues
      ?.map(
        (v: { path: (string | number)[]; message: string }) =>
          v.path.join(".") + " · " + v.message,
      )
      .join("; ");
    throw new ApiError(
      response.status,
      issues || error.error || "API returned HTTP " + response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const api = {
  session: () => request<Workspace>("session", "POST"),
  workspace: () => request<Workspace>("workspace"),
  latency: (id: string, seconds: number) =>
    request<WindowMetrics>(
      "monitors/" + id + "/latency?windowSeconds=" + seconds,
    ),
  fault: (id: string, scenario: Scenario) =>
    request("monitors/" + id + "/fault", "PUT", { scenario }),
  run: (id: string) => request<Observation>("monitors/" + id + "/run", "POST"),
  save: (input: DemoForm, id?: string) =>
    request<{ id: string }>(
      "monitors" + (id ? "/" + id : ""),
      id ? "PUT" : "POST",
      input,
    ),
  remove: (id: string) => request("monitors/" + id, "DELETE"),
};
