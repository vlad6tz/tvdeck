import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ScanSearch, Tv, X } from "lucide-react";
import type { ConnectResult, DeviceInfo, ScanEntry } from "./types";

type Busy = null | { kind: "scan" } | { kind: "connect"; ip: string };

export default function App() {
  const [devices, setDevices] = useState<ScanEntry[]>([]);
  const [connected, setConnected] = useState<DeviceInfo | null>(null);
  const [connectedIp, setConnectedIp] = useState<string | null>(null);
  const [status, setStatus] = useState("Idle. Scan the LAN.");
  const [busy, setBusy] = useState<Busy>(null);
  const [manualIp, setManualIp] = useState("");

  const scan = useCallback(async () => {
    setBusy({ kind: "scan" });
    setStatus("Scanning LAN (mDNS + TCP sweep)...");
    try {
      const found = await invoke<ScanEntry[]>("scan_lan");
      setDevices(found);
      setStatus(found.length ? `Found ${found.length} device(s).` : "No devices found.");
    } catch (e) {
      setStatus(`Scan failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const connect = useCallback(async (ip: string) => {
    setBusy({ kind: "connect", ip });
    setStatus(`Connecting to ${ip}...`);
    try {
      const res = await invoke<ConnectResult>("connect_device", { ip });
      if (res.ok && res.info) {
        setConnected(res.info);
        setConnectedIp(ip);
        setStatus(`Connected to ${res.info.model}.`);
      } else {
        setStatus(`Connect failed: ${res.error ?? "unknown error"}`);
      }
    } catch (e) {
      setStatus(`Connect failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="flex h-full font-sans text-sm">
      <aside className="flex w-72 shrink-0 flex-col border-r border-deck-line bg-deck-panel">
        <div className="flex items-center gap-2 border-b border-deck-line px-4 py-3">
          <Tv className="h-5 w-5 text-deck-accent" />
          <span className="text-base font-semibold tracking-wide">TVDeck</span>
        </div>

        {connected && (
          <div className="mx-3 mt-3 rounded-deck-card border border-deck-line bg-deck-bg/60 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
              <p className="truncate text-slate-100">{connected.model}</p>
              <button
                className="ml-auto text-[13px] text-slate-500 hover:text-slate-300"
                onClick={() => {
                  setConnected(null);
                  setConnectedIp(null);
                  setStatus("Disconnected.");
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="truncate pl-4 text-[11px] text-slate-500">Connected · {connectedIp}</p>
          </div>
        )}

        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <span className="text-[11px] font-medium uppercase tracking-widest text-slate-500">
            Devices
          </span>
          <button
            className="rounded-deck p-1 text-slate-500 hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-40"
            title="Scan LAN"
            onClick={() => void scan()}
            disabled={busy !== null}
          >
            {busy?.kind === "scan" ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-300" />
            ) : (
              <ScanSearch className="h-4 w-4" />
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2">
          {devices.map((d) => (
            <DeviceRow
              key={d.ip}
              device={d}
              connectedIp={connectedIp}
              busy={busy}
              onConnect={connect}
            />
          ))}
          {devices.length === 0 && (
            <p className="px-2 py-4 text-xs leading-5 text-slate-500">
              No devices yet. Scan the LAN to find TVs with network debugging on port 5555.
            </p>
          )}
        </div>

        <div className="border-t border-deck-line p-3">
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-deck border border-deck-line bg-deck-bg px-2.5 py-1.5 text-slate-200 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none"
              placeholder="Enter device IP (192.168.x.x)"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && manualIp.trim() && void connect(manualIp.trim())}
            />
            <button
              className="rounded-deck bg-cyan-500 px-3 py-1.5 font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
              disabled={busy !== null || !manualIp.trim()}
              onClick={() => void connect(manualIp.trim())}
            >
              Connect
            </button>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col px-8 pt-5">
        <header className="flex items-center gap-3">
          {connected ? (
            <span className="text-slate-200">
              {connected.brand} {connected.model}
            </span>
          ) : (
            <span className="text-slate-400">No device connected</span>
          )}
          <span className="ml-auto text-xs text-slate-500">{status}</span>
        </header>
      </main>
    </div>
  );
}

function DeviceRow({
  device,
  connectedIp,
  busy,
  onConnect,
}: {
  device: ScanEntry;
  connectedIp: string | null;
  busy?: Busy;
  onConnect: (ip: string) => Promise<void>;
}) {
  const busyHere = busy?.kind === "connect" && busy !== null && "ip" in busy && busy.ip === device.ip;
  const isConnected = connectedIp === device.ip;
  return (
    <div className="flex items-center gap-2.5 rounded-deck px-2.5 py-2 hover:bg-slate-800/50">
      <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-emerald-400" : "bg-slate-600"}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-slate-200">{device.ip}</p>
        <p className="truncate text-[11px] text-slate-500">
          {device.name ?? `${device.source} at ${device.ip}`}
        </p>
      </div>
      {!isConnected && (
        <button
          className="rounded-deck border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-cyan-700 hover:bg-cyan-950/40 disabled:opacity-40"
          disabled={busyHere || busy?.kind === "connect"}
          onClick={() => void onConnect(device.ip)}
        >
          {busyHere ? "..." : "Connect"}
        </button>
      )}
    </div>
  );
}
