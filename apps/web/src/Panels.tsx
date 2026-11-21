import { useState } from "react";
import {
  Activity,
  Braces,
  Check,
  Copy,
  Download,
  Inbox,
  Timer,
  TriangleAlert,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Area,
  ReferenceLine,
  Tooltip,
} from "recharts";
import type {
  CheckRun,
  DemoMonitor,
  IncidentRecord,
  AlertRecord,
} from "@driftwatch/shared";
import {
  actualValue,
  curlFor,
  regressionFor,
  statusOf,
  time,
  ms,
} from "./display.js";
export function Badge({ value }: { value: string }) {
  return (
    <span className={"badge " + value.toLowerCase()}>
      <i />
      {value}
    </span>
  );
}
export function Chart({
  runs,
  monitor,
  onPick,
  seconds,
  onWindow,
}: {
  runs: CheckRun[];
  monitor: DemoMonitor;
  onPick: (r: CheckRun) => void;
  seconds: number;
  onWindow: (s: number) => void;
}) {
  const points = runs
    .filter((r) => Date.parse(r.at) > Date.now() - seconds * 1000)
    .slice()
    .reverse()
    .map((r) => ({ timestamp: Date.parse(r.at), value: r.latencyMs, run: r }));
  return (
    <section className="card chart">
      <div className="sectionhead">
        <h2>
          <Activity />
          Response latency
        </h2>
        <select
          aria-label="Metric window"
          value={seconds}
          onChange={(e) => onWindow(Number(e.target.value))}
        >
          <option value={300}>Last 5 min</option>
          <option value={900}>Last 15 min</option>
          <option value={3600}>Last hour</option>
        </select>
      </div>
      <div className="legend">
        <span>
          <i className="swatch" />
          Probe latency
        </span>
        <span>
          <i className="dash" />
          SLA {monitor.latencySlaMs} ms
        </span>
      </div>
      {points.length ? (
        <div className="plot">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={points}
              margin={{ left: 0, right: 16, top: 16, bottom: 0 }}
            >
              <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4974ff" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#4974ff" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke="#dce3ed"
                strokeDasharray="3 4"
              />
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={[
                  (v: number) => Math.min(v, points[points.length - 1]!.timestamp - 10000),
                  "dataMax",
                ]}
                tickFormatter={(v) => time(new Date(v).toISOString())}
                tick={{ fontSize: 10, fill: "#68778c" }}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <YAxis
                width={62}
                domain={[
                  0,
                  Math.ceil(
                    Math.max(
                      monitor.latencySlaMs,
                      ...points.map((p) => p.value),
                    ) * 1.2,
                  ),
                ]}
                tickFormatter={(v) => v + " ms"}
                tick={{ fontSize: 10, fill: "#68778c" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                labelFormatter={(v) => time(new Date(Number(v)).toISOString())}
                formatter={(v) => [ms(Number(v)) + " ms", "Latency"]}
              />
              <ReferenceLine
                y={monitor.latencySlaMs}
                stroke="#b47827"
                strokeDasharray="6 4"
              />
              <Area
                isAnimationActive={false}
                type="linear"
                dataKey="value"
                stroke="#436af1"
                strokeWidth={2.5}
                fill="url(#area)"
                dot={(props) => {
                  const point = props.payload as (typeof points)[number];
                  return (
                    <circle
                      key={point.run.id}
                      cx={props.cx}
                      cy={props.cy}
                      r={4}
                      fill={point.run.status === "PASS" ? "#148768" : "#d46343"}
                      stroke="white"
                      strokeWidth={1.5}
                      onClick={() => onPick(point.run)}
                    />
                  );
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty text="Waiting for the first probe in this window." />
      )}
    </section>
  );
}
export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
export function Inspector({ run }: { run: CheckRun | undefined }) {
  const [note, N] = useState("");
  async function copy() {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(curlFor(run, location.origin));
      N("cURL copied · Bash / jq");
    } catch {
      N("Clipboard unavailable. Open on localhost or HTTPS.");
    }
  }
  function download() {
    if (!run) return;
    const blob = new Blob([regressionFor(run, location.origin)], {
        type: "text/javascript",
      }),
      url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "driftwatch-" + run.id + ".test.mjs";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    N("Vitest regression test downloaded");
  }
  return (
    <section className="card inspector">
      <div className="sectionhead">
        <h2>
          <Braces />
          Contract inspection
        </h2>
        {run && <code>#{run.id}</code>}
      </div>
      {run ? (
        <>
          <div className="runmeta">
            <Badge value={statusOf(run)} />
            <code>HTTP {run.statusCode ?? "—"}</code>
            <code>{run.latencyMs} ms</code>
          </div>
          {run.changes.length ? (
            <div className="diffs">
              {run.changes.map((c, i) => (
                <div className="diff" key={i}>
                  <span
                    className={"severity " + c.classification.toLowerCase()}
                  >
                    {c.classification}
                  </span>
                  <strong>{c.path}</strong>
                  <div>
                    <span>Expected</span> <code>{c.expected}</code>
                  </div>
                  <div>
                    <span>Actual</span>{" "}
                    <code>
                      {actualValue(c, run.capture)}
                      {c.path !== "$" &&
                      actualValue(c, run.capture) !== c.actual
                        ? " · " + c.actual
                        : ""}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="matched">
              <Check size={16} />
              Response matches the contract.
            </div>
          )}
          <details open={run.changes.length === 0}>
            <summary>Response snippet</summary>
            <pre>
              {run.capture?.responseSnippet ?? "No response body captured."}
            </pre>
          </details>
          <div className="toolrow">
            <button disabled={!run.capture} onClick={() => void copy()}>
              <Copy />
              Copy cURL
            </button>
            <button disabled={!run.capture} onClick={download}>
              <Download />
              Export regression test
            </button>
          </div>
          {note && <small role="status">{note}</small>}
        </>
      ) : (
        <Empty text="Run a check to inspect its response and contract." />
      )}
    </section>
  );
}
export function History({
  runs,
  selected,
  onPick,
}: {
  runs: CheckRun[];
  selected?: string | undefined;
  onPick: (r: CheckRun) => void;
}) {
  return (
    <section className="card">
      <div className="sectionhead">
        <h2>
          <Timer />
          Check history
        </h2>
        <small>{runs.length} recent</small>
      </div>
      {runs.length ? (
        <div className="scrolltable">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Time</th>
                <th>Outcome</th>
                <th>HTTP</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className={selected === r.id ? "chosen" : ""}
                  onClick={() => onPick(r)}
                >
                  <td>
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPick(r);
                      }}
                    >
                      #{r.id}
                    </button>
                  </td>
                  <td>{time(r.at)}</td>
                  <td>
                    <Badge value={statusOf(r)} />
                  </td>
                  <td>{r.statusCode ?? "—"}</td>
                  <td>{r.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="Completed probes will appear here." />
      )}
    </section>
  );
}
export function Incidents({ rows }: { rows: IncidentRecord[] }) {
  return (
    <section className="card">
      <div className="sectionhead">
        <h2>
          <TriangleAlert />
          Incidents
        </h2>
        <small>{rows.filter((i) => i.status === "OPEN").length} open</small>
      </div>
      {rows.length ? (
        rows.map((i) => (
          <article className="record" key={i.id}>
            <div>
              <Badge value={i.status} />
              <b>{i.kind} incident</b>
              <span className="count">×{i.failureCount} failures</span>
            </div>
            <code className="finger">{i.fingerprint}</code>
            <small>
              Opened {new Date(i.openedAt).toLocaleString()}
              {i.resolvedAt
                ? " · Resolved " + new Date(i.resolvedAt).toLocaleString()
                : ""}
            </small>
          </article>
        ))
      ) : (
        <Empty text="No incidents yet. Run a fault twice to watch failures group here." />
      )}
    </section>
  );
}
export function Alerts({ rows }: { rows: AlertRecord[] }) {
  return (
    <section className="card">
      <div className="sectionhead">
        <h2>
          <Inbox />
          Alert inbox
        </h2>
        <small>{rows.length} deliveries</small>
      </div>
      {rows.length ? (
        rows.map((a) => (
          <details className="delivery" key={a.incidentId + a.transition}>
            <summary>
              <Badge value={a.transition} />
              <code>{time(a.at)}</code> Payload
            </summary>
            <pre>{JSON.stringify(a.payload, null, 2)}</pre>
          </details>
        ))
      ) : (
        <Empty text="Opening or resolving an incident records one delivery." />
      )}
    </section>
  );
}
