import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check, LoaderCircle, MonitorSmartphone,
  ScanSearch, ShieldCheck, Tv, UploadCloud, X,
} from "lucide-react";
import type { ConnectResult, DeviceInfo, Preset, PresetResult, ScanEntry } from "./types";

/* ------------------------------------------------------------------ */
/* TVDeck: a small dashboard for Android TVs on the local network.    */
/* ------------------------------------------------------------------ */

type Busy =
  | null
  | { kind: "scan" }
  | { kind: "connect"; ip: string }
  | { kind: "preset"; id: string }
  | { kind: "apk" };

type ToastKind = "info" | "success" | "error";

/* Human-facing fallback for backend errors. The backend already sends
   plain sentences for its own failures; these catch anything raw that
   slips through (socket-level text, OS error codes). */
function humanizeError(raw: string): { title: string; body: string } {
  const r = raw.toLowerCase();
  if (r.includes("allow usb debugging") || r.includes("accept the dialog") || r.includes("authorization")) {
    return {
      title: "Waiting on the TV",
      body: "The TV is showing a permission prompt. Accept the \"Allow USB debugging\" item on the TV screen, then try again.",
    };
  }
  if (r.includes("connection declined") || r.includes("cannot reach") || r.includes("os error") || r.includes("refused") || r.includes("timed out")) {
    return {
      title: "Connection Declined",
      body: "The TV did not respond. Check that the TV is awake, both devices are on the same Wi-Fi, and network debugging is turned on in the TV's developer options.",
    };
  }
  if (r.includes("apk") || r.includes("manifest")) {
    return {
      title: "Invalid File",
      body: "Please select a valid Android TV .apk file.",
    };
  }
  if (r.includes("no tv connected")) {
    return {
      title: "No TV Connected",
      body: "Pick a TV on the left or enter its address, then try again.",
    };
  }
  return { title: "Something went wrong", body: raw };
}

export default function App() {
  const [devices, setDevices] = useState<ScanEntry[]>([]);
  const [connected, setConnected] = useState<DeviceInfo | null>(null);
  const [connectedIp, setConnectedIp] = useState<string | null>(null);
  const [manualIp, setManualIp] = useState("");
  const [status, setStatus] = useState("Pick a TV or enter its address.");
  const [busy, setBusy] = useState<Busy>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [launcherPkg, setLauncherPkg] = useState("com.spocky.projtv");
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<PresetResult[]>([]);
  const [dropping, setDropping] = useState(false);
  const [apkState, setApkState] = useState<"idle" | "installing" | "done">("idle");
  const toasts = useRef<{ id: number; kind: ToastKind; body: string }[]>([]);
  const [, forceToastRerender] = useState(0);

  /* Toast registry: newest first, auto-expiring. No alert() anywhere. */
  const pushToast = useCallback((kind: ToastKind, body: string) => {
    const id = Date.now() + Math.random();
    toasts.current = [{ id, kind, body }, ...toasts.current].slice(0, 3);
    forceToastRerender((n) => n + 1);
    window.setTimeout(() => {
      toasts.current = toasts.current.filter((t) => t.id !== id);
      forceToastRerender((n) => n + 1);
    }, 4200);
  }, []);

  const dropToast = useCallback((id: number) => {
    toasts.current = toasts.current.filter((t) => t.id !== id);
    forceToastRerender((n) => n + 1);
  }, []);

  useEffect(() => {
    invoke<Preset[]>("get_presets").then(setPresets).catch(() => setPresets([]));
  }, []);

  /* Keep the two-second "Applied" chip honest: revert after 2s. */
  const flashApplied = useCallback((id: string) => {
    setApplied((prev) => ({ ...prev, [id]: true }));
    window.setTimeout(() => {
      setApplied((prev) => ({ ...prev, [id]: false }));
    }, 2000);
  }, []);

  const scan = useCallback(async () => {
    setBusy({ kind: "scan" });
    setStatus("Scanning LAN: mDNS + TCP sweep on port 5555…");
    try {
      const found = await invoke<ScanEntry[]>("scan_lan");
      setDevices(found);
      setStatus(
        found.length > 0
          ? `Found ${found.length} TV${found.length > 1 ? "s" : ""}.`
          : "No TVs found. Check the TV is on and connected to the same network, or add it by address below.",
      );
    } catch (e) {
      const { title, body } = humanizeError(String(e));
      pushToast("error", `${title}. ${body}`);
    } finally {
      setBusy(null);
    }
  }, [pushToast]);

  const connect = useCallback(async (ip: string, friendlyName?: string) => {
    setBusy({ kind: "connect", ip });
    setStatus("Connecting…");
    try {
      const res = await invoke<ConnectResult>("connect_device", { ip });
      if (res.ok && res.info) {
        setConnected(res.info);
        setConnectedIp(ip);
        setStatus(`Connected to ${res.info.model}.`);
        pushToast("success", `Connected to ${res.info.model}.`);
      } else {
        setConnected(null);
        setConnectedIp(null);
        setStatus("Connection failed.");
        const { title, body } = humanizeError(res.error ?? "Connection failed");
        pushToast("error", `${title}. ${body}`);
        void friendlyName;
      }
    } catch (e) {
      setStatus("Connection failed.");
      const { title, body } = humanizeError(String(e));
      pushToast("error", `${title}. ${body}`);
    } finally {
      setBusy(null);
    }
  }, [pushToast]);

  const disconnect = useCallback(async () => {
    await invoke("disconnect").catch(() => undefined);
    setConnected(null);
    setConnectedIp(null);
    setStatus("Not connected.");
  }, []);

  const applyPreset = useCallback(async (id: string) => {
    if (!connected) {
      const { title, body } = humanizeError("no tv connected");
      pushToast("error", `${title}. ${body}`);
      return;
    }
    setBusy({ kind: "preset", id });
    try {
      const res = await invoke<PresetResult>("apply_preset", { presetId: id });
      if (res.error) {
        pushToast("error", humanizeError(res.error).body);
      } else {
        flashApplied(id);
        pushToast("success", "Applied on the TV.");
        setResults((prev) => [...prev.filter((r) => r.preset_id !== id), res]);
      }
    } catch (e) {
      const { title, body } = humanizeError(String(e));
      pushToast("error", `${title}. ${body}`);
    } finally {
      setBusy(null);
    }
  }, [connected, pushToast, flashApplied]);

  const applyLauncher = useCallback(async () => {
    if (!connected) {
      const { title, body } = humanizeError("no tv connected");
      pushToast("error", `${title}. ${body}`);
      return;
    }
    setBusy({ kind: "preset", id: "grant" });
    try {
      const res = await invoke<PresetResult>("grant_launcher", { package: launcherPkg });
      if (res.error) {
        pushToast("error", humanizeError(res.error).body);
      } else {
        flashApplied("grant");
        pushToast("success", "The launcher is ready to use.");
      }
    } catch (e) {
      const { title, body } = humanizeError(String(e));
      pushToast("error", `${title}. ${body}`);
    } finally {
      setBusy(null);
    }
  }, [connected, launcherPkg, pushToast, flashApplied]);

  const installApk = useCallback(async (apkPath: string) => {
    if (!connected) {
      const { title, body } = humanizeError("no tv connected");
      pushToast("error", `${title}. ${body}`);
      setApkState("idle");
      return;
    }
    setBusy({ kind: "apk" });
    setApkState("installing");
    try {
      const res = await invoke<PresetResult>("install_apk", { apkPath });
      if (res.error) {
        pushToast("error", humanizeError(res.error).body);
        setApkState("idle");
      } else {
        setApkState("done");
        pushToast("success", "App installed on the TV.");
        window.setTimeout(() => setApkState("idle"), 2000);
      }
    } catch (e) {
      const { title, body } = humanizeError(String(e));
      pushToast("error", `${title}. ${body}`);
      setApkState("idle");
    } finally {
      setBusy(null);
    }
  }, [connected, pushToast]);

  /* Tauri v2 drag & drop: watch for .apk drops anywhere on the window. */
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "over") {
        setDropping(true);
      } else if (ev.payload.type === "drop") {
        setDropping(false);
        const apk = ev.payload.paths.find((p) => p.toLowerCase().endsWith(".apk"));
        if (apk) void installApk(apk);
        else pushToast("error", "Please drop an .apk file.");
      } else {
        setDropping(false);
      }
    });
    return () => void unlisten.then((fn) => fn());
  }, [installApk, pushToast]);

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
                onClick={() => void disconnect()}
                title="Disconnect"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="truncate pl-4 text-[11px] text-slate-500">
              Connected • {connectedIp}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <span className="text-[11px] font-medium uppercase tracking-widest text-slate-500">
            TVs on this network
          </span>
          <button
            className="rounded-deck p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-40"
            title="Scan the local network"
            onClick={() => void scan()}
            disabled={busy !== null}
          >
            {busy?.kind === "scan" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
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
              forget={() => setDevices((prev) => prev.filter((x) => x.ip !== d.ip))}
            />
          ))}
          {devices.length === 0 && (
            <p className="px-2 py-4 text-xs leading-5 text-slate-500">
              No TVs yet. On your TV go to Settings → About, tap "Build number" 5 times, then turn on
              network debugging in Developer options.
            </p>
          )}
        </div>

        <div className="border-t border-deck-line p-3">
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-deck border border-deck-line bg-deck-bg px-2.5 py-1.5 text-slate-200 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none"
              placeholder="Add a TV address, e.g. 192.168.1.42"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && manualIp.trim() && void connect(manualIp.trim())}
            />
            <button
              className="rounded-deck bg-cyan-500 px-3 py-1.5 font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-40"
              disabled={busy !== null || !manualIp.trim()}
              onClick={() => void connect(manualIp.trim())}
            >
              Add
            </button>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 pb-8 pt-5">
        <header className="mb-5 flex items-center gap-3">
          {connected ? (
            <>
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
              <span className="text-slate-200">
                {connected.brand} {connected.model}
              </span>
              <span className="text-xs text-slate-500">Android {connected.android_version}</span>
            </>
          ) : (
            <>
              <MonitorSmartphone className="h-4 w-4 text-slate-600" />
              <span className="text-slate-400">No TV connected</span>
            </>
          )}
          <span className="ml-auto text-xs text-slate-500">{status}</span>
        </header>

        <SectionLabel title="TV care" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {presets.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              busy={busy?.kind === "preset" && busy !== null && "id" in busy && busy.id === p.id}
              applied={!!applied[p.id]}
              onApply={() => void applyPreset(p.id)}
            />
          ))}
        </div>

        <SectionLabel title="Launcher" />
        <LauncherCard
          launcherPkg={launcherPkg}
          setLauncherPkg={setLauncherPkg}
          busy={busy?.kind === "preset" && busy !== null && "id" in busy && busy.id === "grant"}
          applied={!!applied["grant"]}
          onApply={() => void applyLauncher()}
          connected={!!connected}
        />

        <SectionLabel title="Install an app" />
        <ApkDropzone
          dropping={dropping}
          busy={apkState === "installing"}
          done={apkState === "done"}
          disabled={busy !== null}
          onBrowse={async () => {
            const file = await open({
              filters: [{ name: "Android app", extensions: ["apk"] }],
              multiple: false,
              title: "Choose an app to install",
            });
            if (file) void installApk(file);
          }}
        />

        {results.length > 0 && (
          <>
            <SectionLabel title="Recent activity" />
            <ActivityLog results={results} />
          </>
        )}
      </main>

      <ToastStack toasts={[...toasts.current]} onDismiss={dropToast} />
    </div>
  );
}

/* ------------------------------ pieces ------------------------------ */

function DeviceRow({
  device,
  connectedIp,
  busy,
  onConnect,
  forget,
}: {
  device: ScanEntry;
  connectedIp: string | null;
  busy?: Busy;
  onConnect: (ip: string) => Promise<void>;
  forget: () => void;
}) {
  const busyHere = busy?.kind === "connect" && busy !== null && "ip" in busy && busy.ip === device.ip;
  const isConnected = connectedIp === device.ip;
  return (
    <div className="group flex items-center gap-2.5 rounded-deck px-2.5 py-2 transition-colors hover:bg-slate-800/50">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          isConnected ? "bg-emerald-400" : "bg-slate-600"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-slate-200">{device.ip}</p>
        <p className="truncate text-[11px] text-slate-500">
          {device.name ? device.name : "Responding on the network"}
        </p>
      </div>
      {!isConnected && (
        <button
          className="rounded-deck border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-cyan-700 hover:bg-cyan-950/40 hover:text-cyan-200 disabled:opacity-40"
          disabled={busyHere || busy?.kind === "connect"}
          onClick={() => void onConnect(device.ip)}
        >
          {busyHere ? <LoaderCircle className="h-3 w-3 animate-spin" /> : "Connect"}
        </button>
      )}
      <button
        className="text-slate-700 opacity-0 transition-opacity hover:text-slate-400 group-hover:opacity-100"
        title="Hide this TV"
        onClick={forget}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <h2 className="mb-3 mt-8 first:mt-1 text-[11px] font-medium uppercase tracking-widest text-slate-500">
      {title}
    </h2>
  );
}

function PresetCard({
  preset,
  busy,
  applied,
  onApply,
}: {
  preset: Preset;
  busy: boolean;
  applied: boolean;
  onApply: () => void;
}) {
  const sub = preset.description.split(".")[0];
  return (
    <div className="flex flex-col rounded-deck-card border border-deck-line bg-deck-panel p-4 transition-colors hover:border-slate-700">
      <p className="font-medium text-slate-100">{preset.label}</p>
      <p className="mt-1 flex-1 text-xs leading-5 text-slate-400">{sub}</p>
      <p className="mt-2 text-[11px] text-slate-500">
        {preset.commands.map((c) => c.cmd).join("  |  ")}
      </p>
      {preset.restart_required && (
        <p className="mt-2 text-[11px] text-amber-400/70">Reboot the TV to finish.</p>
      )}
      <button
        className="mt-3 flex items-center justify-center gap-1.5 rounded-deck bg-cyan-500 px-3 py-2 text-[13px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-40"
        disabled={busy || applied}
        onClick={onApply}
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : applied ? (
          <>
            <Check className="h-4 w-4" /> Applied
          </>
        ) : (
          "Apply"
        )}
      </button>
    </div>
  );
}

function LauncherCard({
  launcherPkg,
  setLauncherPkg,
  busy,
  applied,
  onApply,
  connected,
}: {
  launcherPkg: string;
  setLauncherPkg: (s: string) => void;
  busy: boolean;
  applied: boolean;
  onApply: () => void;
  connected: boolean;
}) {
  const commands = [
    `pm grant ${launcherPkg} android.permission.WRITE_SECURE_SETTINGS`,
    `pm grant ${launcherPkg} android.permission.READ_LOGS`,
    `pm grant ${launcherPkg} android.permission.PACKAGE_USAGE_STATS`,
  ];
  return (
    <div className="rounded-deck-card border border-deck-line bg-deck-panel p-4 transition-colors hover:border-slate-700">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-slate-100">Use a custom home screen</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Grants WRITE_SECURE_SETTINGS so the selected launcher can manage the home screen.
          </p>
          <p className="mt-2 text-[11px] text-slate-500">{commands.join("  |  ")}</p>
        </div>
        <select
          className="rounded-deck border border-deck-line bg-deck-bg px-2.5 py-2 text-slate-200 focus:border-cyan-600 focus:outline-none md:w-56"
          value={launcherPkg}
          onChange={(e) => setLauncherPkg(e.target.value)}
        >
          <option value="com.spocky.projtv">Projectivy Launcher</option>
          <option value="com.spocky.projtv.free">Projectivy (Free)</option>
          <option value="com.google.android.tvlauncher">Stock Google TV launcher</option>
        </select>
        <button
          className="flex items-center justify-center gap-1.5 rounded-deck bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-slate-950 transition-colors hover:bg-violet-400 disabled:opacity-40"
          onClick={onApply}
          disabled={busy || applied || !connected}
        >
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : applied ? (
            <>
              <Check className="h-4 w-4" /> Ready
            </>
          ) : (
            <>
              <ShieldCheck className="h-4 w-4" /> Set up
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function ApkDropzone({
  dropping,
  busy,
  done,
  disabled,
  onBrowse,
}: {
  dropping: boolean;
  busy: boolean;
  done: boolean;
  disabled: boolean;
  onBrowse: () => void | Promise<void>;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-deck-card border-2 border-dashed px-6 py-10 text-center transition-colors ${
        dropping
          ? "border-cyan-500/70 bg-cyan-500/5"
          : "border-slate-800 bg-deck-panel hover:border-slate-700"
      }`}
    >
      <UploadCloud className={`h-7 w-7 ${dropping ? "text-cyan-300" : "text-slate-600"}`} />
      <p className="mt-3 text-sm text-slate-300">Drag an app file (.apk) here to install</p>
      <p className="mt-1 text-xs text-slate-500">Large files can take a minute to copy.</p>
      <div className="mt-4">
        <button
          className="rounded-deck border border-slate-700 px-3.5 py-1.5 text-[13px] text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800 disabled:opacity-40"
          onClick={() => void onBrowse()}
          disabled={disabled || busy}
        >
          {busy ? (
            <span className="flex items-center gap-1.5">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Installing…
            </span>
          ) : done ? (
            <span className="flex items-center gap-1.5 text-emerald-300">
              <Check className="h-3.5 w-3.5" /> Installed
            </span>
          ) : (
            "Browse files"
          )}
        </button>
      </div>
    </div>
  );
}

function ActivityLog({ results }: { results: PresetResult[] }) {
  return (
    <div className="rounded-deck-card bg-black/30 px-4 py-3 font-mono text-[11px] leading-6">
      {results.map((r, i) => (
        <div key={`${r.preset_id}-${i}`} className="mb-1.5 last:mb-0">
          {r.steps.map((s, j) => (
            <p
              key={j}
              className={
                s.includes("Error") || s.toLowerCase().includes("error")
                  ? "text-red-300"
                  : s.endsWith(": OK")
                    ? "text-emerald-400/70"
                    : "text-slate-500"
              }
            >
              {s}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; kind: ToastKind; body: string }[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2.5 rounded-deck-card border px-4 py-3 text-xs leading-5 shadow-lg shadow-black/40 backdrop-blur ${
            t.kind === "error"
              ? "border-red-900/70 bg-red-950/70 text-red-100"
              : t.kind === "success"
                ? "border-emerald-900/70 bg-emerald-950/60 text-emerald-100"
                : "border-slate-700 bg-slate-900/80 text-slate-200"
          }`}
        >
          {t.kind === "success" ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : t.kind === "error" ? (
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : null}
          <p className="min-w-0 flex-1">{t.body}</p>
          <button
            className="ml-1 shrink-0 opacity-60 transition-opacity hover:opacity-100"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
