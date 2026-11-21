import { useEffect, useRef, useState } from "react";
import { X, Trash2, ShieldCheck } from "lucide-react";
import { api } from "./client.js";
import type { DemoMonitor, DemoForm } from "@driftwatch/shared";
export function MonitorForm({
  monitor,
  close,
  saved,
}: {
  monitor?: DemoMonitor | undefined;
  close: () => void;
  saved: (id?: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  const [name, N] = useState(monitor?.name ?? ""),
    [flow, F] = useState(
      monitor?.target.kind === "sandbox" ? monitor.target.flow : "checkout",
    );
  const [external, E] = useState(false),
    [url, U] = useState(""),
    [interval, I] = useState(String((monitor?.intervalMs ?? 10000) / 1000)),
    [sla, S] = useState(String(monitor?.latencySlaMs ?? 500));
  const [active, A] = useState(monitor?.active ?? true),
    [error, err] = useState(""),
    [pending, P] = useState(false),
    [confirm, D] = useState(false);
  async function submit(remove = false) {
    P(true);
    err("");
    try {
      if (remove && monitor) {
        await api.remove(monitor.id);
        saved();
      } else {
        const form: DemoForm = {
          name,
          target: external
            ? { kind: "external", url }
            : { kind: "sandbox", flow },
          intervalMs: Number(interval) * 1000,
          latencySlaMs: Number(sla),
          active,
        };
        const result = await api.save(form, monitor?.id);
        saved(result.id);
      }
    } catch (e) {
      err(e instanceof Error ? e.message : "Save failed");
    } finally {
      P(false);
    }
  }
  return (
    <dialog ref={ref} onCancel={close} aria-labelledby="form-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="sectionhead">
          <h2 id="form-title">{monitor ? "Edit monitor" : "Create monitor"}</h2>
          <button
            type="button"
            className="iconbtn"
            aria-label="Close editor"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <label>
          Monitor name
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => N(e.target.value)}
            placeholder="Orders API"
          />
        </label>
        <label>
          Probe target
          <select
            value={external ? "external" : flow}
            onChange={(e) => {
              E(e.target.value === "external");
              if (e.target.value !== "external")
                F(e.target.value as typeof flow);
              err("");
            }}
          >
            <option value="checkout">Checkout API</option>
            <option value="orders">Login → orders</option>
            <option value="external">External URL · guard check</option>
          </select>
        </label>
        {external && (
          <label>
            Endpoint URL
            <input
              type="url"
              required
              placeholder="http://127.0.0.1"
              value={url}
              onChange={(e) => U(e.target.value)}
            />
            <small>
              <ShieldCheck size={14} /> The server checks the address before
              accepting a target.
            </small>
          </label>
        )}
        <div className="formrow">
          <label>
            Interval (seconds)
            <input
              type="number"
              min="5"
              max="86400"
              required
              value={interval}
              onChange={(e) => I(e.target.value)}
            />
          </label>
          <label>
            SLA budget (ms)
            <input
              type="number"
              required
              min="1"
              max="86400000"
              value={sla}
              onChange={(e) => S(e.target.value)}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => A(e.target.checked)}
          />{" "}
          Active scheduled checks
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {confirm ? (
          <div className="deletebox">
            Delete this monitor and its recorded history?
            <div className="actions">
              <button type="button" disabled={pending} onClick={() => D(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={pending}
                onClick={() => void submit(true)}
              >
                Confirm delete
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            {monitor && (
              <button
                type="button"
                className="danger left"
                onClick={() => D(true)}
              >
                <Trash2 size={15} /> Delete
              </button>
            )}
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={pending}>
              {pending
                ? "Saving…"
                : external
                  ? "Validate target"
                  : "Save monitor"}
            </button>
          </div>
        )}
      </form>
    </dialog>
  );
}
