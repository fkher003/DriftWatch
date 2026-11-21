import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  Activity,
  AudioWaveform,
  Box,
  Check,
  CircleAlert,
  FlaskConical,
  History as HistoryIcon,
  Inbox as InboxIcon,
  Layers3,
  LayoutDashboard,
  Link2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Timer,
  WifiOff,
} from "lucide-react";
import {
  scenarios,
  type CheckRun,
  type DemoMonitor,
  type WindowMetrics,
} from "@driftwatch/shared";
import { api } from "./client.js";
import { labels, ms, statusOf } from "./display.js";
import { useWorkspace } from "./useWorkspace.js";
import {
  Chart,
  History,
  Inspector,
  Incidents,
  Alerts,
  Badge,
} from "./Panels.js";
import { MonitorForm } from "./MonitorForm.js";
import "./style.css";
const pages = [
  ["Overview", LayoutDashboard],
  ["Check history", HistoryIcon],
  ["Incidents", CircleAlert],
  ["Alert inbox", InboxIcon],
] as const;
type Page = (typeof pages)[number][0];
function Dashboard() {
  const ws = useWorkspace(),
    data = ws.data;
  const [selected, select] = useState(""),
    [page, go] = useState<Page>("Overview"),
    [editor, edit] = useState<"new" | DemoMonitor | null>(null);
  const [pin, inspect] = useState<CheckRun>(),
    [pending, busy] = useState(""),
    [error, fail] = useState(""),
    [seconds, windowSize] = useState(300);
  const [metrics, M] = useState<{ key: string; values: WindowMetrics } | null>(
      null,
    ),
    [metricError, ME] = useState("");
  const monitor =
    data?.monitors.find((m) => m.id === selected) ?? data?.monitors[0];
  const id = monitor?.id,
    runs = data?.runs.filter((r) => r.monitorId === id) ?? [],
    latest = runs[0];
  const activeRun = pin?.monitorId === id && pin ? pin : latest;
  const incidents = data?.incidents.filter((i) => i.monitorId === id) ?? [],
    alerts = data?.alerts.filter((a) => a.monitorId === id) ?? [];
  const metricKey = id + "/" + seconds;
  useEffect(() => {
    let live = true;
    if (id) {
      ME("");
      void api
        .latency(id, seconds)
        .then((values) => {
          if (live) M({ key: metricKey, values });
        })
        .catch((e) => {
          if (live) {
            ME(e.message);
            M(null);
          }
        });
    }
    return () => {
      live = false;
    };
  }, [id, seconds, latest?.id, metricKey]);
  const values = metrics?.key === metricKey ? metrics.values : null;
  function choose(id: string) {
    select(id);
    inspect(undefined);
    fail("");
  }
  function showRun(run:CheckRun) {
    inspect(run);
    requestAnimationFrame(()=>document.querySelector(".inspector")?.scrollIntoView({block:"nearest"}));
  }
  async function action(label: string, work: () => Promise<unknown>) {
    busy(label);
    fail("");
    try {
      await work();
      await ws.refresh();
    } catch (e) {
      fail(e instanceof Error ? e.message : "Request failed");
    } finally {
      busy("");
    }
  }
  const transport = ws.connection === "Live";
  const pass = values?.passRate;
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brandmark">
            <AudioWaveform />
          </div>
          DriftWatch
        </div>
        <div className="railcaption">Workspace</div>
        <nav>
          {pages.map(([p, Icon]) => (
            <button
              key={p}
              aria-current={p === page ? "page" : undefined}
              className={p === page ? "nav active" : "nav"}
              onClick={() => go(p)}
            >
              <Icon size={17} />
              {p}
              {p === "Incidents" &&
                incidents.some((i) => i.status === "OPEN") && (
                  <em>{incidents.filter((i) => i.status === "OPEN").length}</em>
                )}
            </button>
          ))}
        </nav>
        <div className="railcaption split">
          Monitors
          <button
            aria-label="Create monitor"
            disabled={!data}
            onClick={() => edit("new")}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="monitorlist">
          {data?.monitors.map((m) => {
            const r = data.runs.find((r) => r.monitorId === m.id),
              s = statusOf(r, m.active);
            return (
              <button
                className={"monitor " + (m.id === id ? "selected" : "")}
                key={m.id}
                onClick={() => choose(m.id)}
              >
                <span className={"dot " + s.toLowerCase()} />
                <span>
                  <b>{m.name}</b>
                  <small>
                    {s} · {ms(r?.latencyMs)} ms
                  </small>
                  <small>
                    SLA {m.latencySlaMs} ms · {m.intervalMs / 1000}s
                  </small>
                </span>
              </button>
            );
          })}
        </div>
        <div className="railfoot">
          <ShieldCheck />
          <div>
            Private demo workspace<small>Isolated for 30 minutes</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="top">
          <div>
            <Layers3 size={16} /> Demo workspace <span>/</span> <b>{page}</b>
          </div>
          <span role="status" className={"live " + (transport ? "online" : "")}>
            <i />
            {transport ? "LIVE" : ws.connection.toUpperCase()}{" "}
            <span>· SSE</span>
          </span>
        </header>
        <div className="content">
          {(error || ws.error) && (
            <div className="notice" role="alert">
              <WifiOff size={16} />
              {error || ws.error}
              {ws.error && <button onClick={ws.retry}>Reconnect</button>}
            </div>
          )}
          {!monitor ? (
            <div className="card welcome">
              <Radio />
              <h1>
                {data
                  ? "Your monitors"
                  : ws.connection === "Offline"
                    ? "Workspace unavailable"
                    : "Connecting to DriftWatch"}
              </h1>
              <p>
                {data
                  ? "Create a monitor to start collecting probes."
                  : ws.connection === "Offline"
                    ? "Start the API and PostgreSQL, then reconnect."
                    : "Preparing your sandbox monitors and event stream…"}
              </p>
              {data && (
                <button className="primary" onClick={() => edit("new")}>
                  <Plus />
                  Create monitor
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="heading">
                <div>
                  <div className="headingline">
                    <h1>{page === "Overview" ? monitor.name : page}</h1>
                    <Badge value={statusOf(latest, monitor.active)} />
                  </div>
                  <div className="subtitle">
                    {monitor.target.kind === "sandbox" &&
                    monitor.target.flow !== "checkout" ? (
                      <>
                        <Link2 /> POST login <span>→</span> GET{" "}
                        {monitor.target.flow}
                      </>
                    ) : (
                      <>
                        <Box /> GET checkout
                      </>
                    )}
                    <i />
                    Every {monitor.intervalMs / 1000}s<i />
                    {monitor.active ? "Scheduled" : "Paused"}
                  </div>
                </div>
                <button onClick={() => edit(monitor)}>
                  <Settings2 size={15} />
                  Edit monitor
                </button>
              </div>
              <section className="chaos">
                <div className="chaosheader">
                  <div className="flask">
                    <FlaskConical />
                  </div>
                  <div>
                    <h2>Chaos sandbox</h2>
                    <p>Choose a fault, then run a check to see its impact.</p>
                  </div>
                  <button
                    className="primary run"
                    disabled={!!pending || !monitor.active}
                    onClick={() => {
                      inspect(undefined);
                      void action("run", () => api.run(monitor.id));
                    }}
                  >
                    {pending === "run" ? (
                      <RefreshCw className="spin" />
                    ) : (
                      <Play fill="currentColor" />
                    )}
                    {pending === "run" ? "Checking…" : "Run Check Now"}
                  </button>
                </div>
                <div
                  className="faults"
                  role="group"
                  aria-label="Fault scenario"
                >
                  {scenarios.map((s) => (
                    <button
                      aria-pressed={monitor.scenario === s}
                      key={s}
                      disabled={!!pending}
                      onClick={() =>
                        void action("scenario", () => api.fault(monitor.id, s))
                      }
                    >
                      {s === monitor.scenario ? (
                        <Check size={14} />
                      ) : (
                        <span className="ring" />
                      )}
                      {labels[s]}
                    </button>
                  ))}
                </div>
              </section>
              {page === "Overview" ? (
                <>
                  <div className="metrics">
                    {[
                      ["p50 latency", ms(values?.p50), "ms"],
                      ["p95 latency", ms(values?.p95), "ms"],
                      ["p99 latency", ms(values?.p99), "ms"],
                      ["SLA target", ms(monitor.latencySlaMs), "ms"],
                      ["Pass rate", ms(pass), "%"],
                    ].map(([name, v, unit], i) => (
                      <div key={name}>
                        <span>
                          {i < 3 ? (
                            <Activity />
                          ) : i === 3 ? (
                            <Timer />
                          ) : (
                            <ShieldCheck />
                          )}
                          {name}
                        </span>
                        <b>
                          {v} <small>{unit}</small>
                        </b>
                      </div>
                    ))}
                  </div>
                  {metricError && (
                    <p role="alert" className="error">
                      {metricError}
                    </p>
                  )}
                  <div className="analysisgrid">
                    <Chart
                      runs={runs}
                      monitor={monitor}
                      seconds={seconds}
                      onWindow={windowSize}
                      onPick={showRun}
                    />
                    <Inspector key={activeRun?.id ?? "empty"} run={activeRun} />
                  </div>
                  <div className="lowergrid">
                    <History
                      selected={activeRun?.id}
                      runs={runs.slice(0, 6)}
                      onPick={showRun}
                    />
                    <div className="stack">
                      <Incidents rows={incidents.slice(0, 2)} />
                      <Alerts rows={alerts.slice(0, 2)} />
                    </div>
                  </div>
                </>
              ) : page === "Check history" ? (
                <div className="analysisgrid">
                  <History
                    selected={activeRun?.id}
                    runs={runs}
                    onPick={showRun}
                  />
                  <Inspector key={activeRun?.id} run={activeRun} />
                </div>
              ) : page === "Incidents" ? (
                <Incidents rows={incidents} />
              ) : (
                <Alerts rows={alerts} />
              )}
            </>
          )}
        </div>
      </main>
      {editor && (
        <MonitorForm
          monitor={editor === "new" ? undefined : editor}
          close={() => edit(null)}
          saved={(next) => {
            edit(null);
            if (next) choose(next);
            void ws.refresh();
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Dashboard />);
