import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle, Check, ChevronDown, LoaderCircle,
  RefreshCw, ShieldCheck, Upload,
} from "lucide-react";
import type { ConnectResult, DeviceInfo, Preset, PresetResult, ScanEntry } from "./types";

/* ------------------------------------------------------------------ */
/* TVDeck: flat two-pane desktop layout in the Baobab/GTK tradition. */
/* ------------------------------------------------------------------ */

type Busy =
  | null
  | { kind: "scan" }
  | { kind: "connect"; ip: string }
  | { kind: "preset"; id: string }
  | { kind: "apk" };

type NoticeKind = "info" | "success" | "error";

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
      body: "Pick a TV on the left or enter its address above, then try again.",
    };
  }
  return { title: "Something went wrong", body: raw };
}

export default function App() {
  const [devices, setDevices] = useState<ScanEntry[]>([]);
  const [connected, setConnected] = useState<DeviceInfo | null>(null);
  const [connectedIp, setConnectedIp] = useState<string | null>(null);
  const [manualIp, setManualIp] = useState("");
  const [status, setStatus] = useState("Pick a TV or enter its address above.");
  const [busy, setBusy] = useState<Busy>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [launcherPkg, setLauncherPkg] = useState("com.spocky.projtv");
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<PresetResult[]>([]);
  const [dropping, setDropping] = useState(false);
  const [devOpen, setDevOpen] = useState<Record<string, boolean>>({});
  const [apkState, setApkState] = useState<"idle" | "installing" | "done">("idle");

  /* InfoBar registry: single top banner shows the newest notice, which
     auto-expires. This replaces floating toasts. */
  const notices = useRef<{ id: number; kind: NoticeKind; body: string }[]>([]);
  const [noticeTick, setNoticeTick] = useState(0);
  const pushNotice = useCallback((kind: NoticeKind, body: string) => {
    const id = Date.now() + Math.random();
    notices.current = [{ id, kind, body }, ...notices.current].slice(0, 3);
    setNoticeTick((n) => n + 1);
    window.setTimeout(() => {
      notices.current = notices.current.filter((t) => t.id !== id);
      setNoticeTick((n) => n + 1);
    }, 5000);
  }, []);
  const dismissNotice = useCallback(() => {
    notices.current = notices.current.slice(1);
    setNoticeTick((n) => n + 1);
  }, []);

  useEffect(() => {
    invoke<Preset[]>("get_presets").then(setPresets).catch(() => setPresets([]));
  }, []);

  const flashApplied = useCallback((id: string) => {
    setApplied((prev) => ({ ...prev, [id]: true }));
    window.setTimeout(() => {
      setApplied((prev) => ({ ...prev, [id]: false }));
    }, 2000);
  }, []);

  const scan = useCallback(async () => {
    setBusy({ kind: "scan" });
    setStatus("Scanning local Wi-Fi…");
    try {
      const found = await invoke<ScanEntry[]>("scan_lan");
      setDevices(found);
      setStatus(
        found.length > 0
          ? `Found ${found.length} TV${found.length > 1 ? "s" : ""}.`
          : "No TVs found. Check the TV is on and on the same network, or add it by address above.",
      );
    } catch (e) {
      const { body } = humanizeError(String(e));
      pushNotice("error", body);
    } finally {
      setBusy(null);
    }
  }, [pushNotice]);

  const connect = useCallback(async (ip: string, friendlyName?: string) => {
    setBusy({ kind: "connect", ip });
    setStatus(`Connecting to ${ip}…`);
    try {
      const res = await invoke<ConnectResult>("connect_device", { ip });
      if (res.ok && res.info) {
        setConnected(res.info);
        setConnectedIp(ip);
        setStatus("Connected.");
        pushNotice("success", `Connected to ${res.info.model}.`);
      } else {
        setConnected(null);
        setConnectedIp(null);
        setStatus("Connection failed.");
        const { body } = humanizeError(res.error ?? "Connection failed");
        pushNotice("error", body);
        void friendlyName;
      }
    } catch (e) {
      setStatus("Connection failed.");
      const { body } = humanizeError(String(e));
      pushNotice("error", body);
    } finally {
      setBusy(null);
    }
  }, [pushNotice]);

  const disconnect = useCallback(async () => {
    await invoke("disconnect").catch(() => undefined);
    setConnected(null);
    setConnectedIp(null);
    setStatus("Not connected.");
  }, []);

  const applyPreset = useCallback(async (id: string) => {
    if (!connected) {
      pushNotice("error", humanizeError("no tv connected").body);
      return;
    }
    setBusy({ kind: "preset", id });
    try {
      const res = await invoke<PresetResult>("apply_preset", { presetId: id });
      if (res.error) {
        pushNotice("error", humanizeError(res.error).body);
      } else {
        flashApplied(id);
        setResults((prev) => [...prev.filter((r) => r.preset_id !== id), res]);
      }
    } catch (e) {
      const { body } = humanizeError(String(e));
      pushNotice("error", body);
    } finally {
      setBusy(null);
    }
  }, [connected, pushNotice, flashApplied]);

  const applyLauncher = useCallback(async () => {
    if (!connected) {
      pushNotice("error", humanizeError("no tv connected").body);
      return;
    }
    setBusy({ kind: "preset", id: "grant" });
    try {
      const res = await invoke<PresetResult>("grant_launcher", { package: launcherPkg });
      if (res.error) {
        pushNotice("error", humanizeError(res.error).body);
      } else {
        flashApplied("grant");
        pushNotice("success", "The launcher is ready to use.");
      }
    } catch (e) {
      const { body } = humanizeError(String(e));
      pushNotice("error", body);
    } finally {
      setBusy(null);
    }
  }, [connected, launcherPkg, pushNotice, flashApplied]);

  const installApk = useCallback(async (apkPath: string) => {
    if (!connected) {
      pushNotice("error", humanizeError("no tv connected").body);
      setApkState("idle");
      return;
    }
    setBusy({ kind: "apk" });
    setApkState("installing");
    try {
      const res = await invoke<PresetResult>("install_apk", { apkPath });
      if (res.error) {
        pushNotice("error", humanizeError(res.error).body);
        setApkState("idle");
      } else {
        setApkState("done");
        window.setTimeout(() => setApkState("idle"), 2000);
      }
    } catch (e) {
      const { body } = humanizeError(String(e));
      pushNotice("error", body);
      setApkState("idle");
    } finally {
      setBusy(null);
    }
  }, [connected, pushNotice]);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "over") {
        setDropping(true);
      } else if (ev.payload.type === "drop") {
        setDropping(false);
        const apk = ev.payload.paths.find((p) => p.toLowerCase().endsWith(".apk"));
        if (apk) void installApk(apk);
        else pushNotice("error", "Please drop an .apk file.");
      } else {
        setDropping(false);
      }
    });
    return () => void unlisten.then((fn) => fn());
  }, [installApk, pushNotice]);

  void noticeTick;
  const notice = notices.current[0];

  return (
    <div className="flex h-full flex-col font-sans text-[13px] text-neutral-200">
      {/* HeaderBar */}
      <header className="relative flex h-12 shrink-0 items-center gap-2 border-b border-deck-line bg-deck-panel px-3">
        <button
          className="flex h-8 items-center gap-1.5 rounded-deck border border-deck-line px-2.5 text-neutral-300 transition-colors hover:bg-deck-raised disabled:opacity-40"
          onClick={() => void scan()}
          disabled={busy !== null}
        >
          {busy?.kind === "scan" ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Scan Network
        </button>

        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 font-semibold text-neutral-100">
          TVDeck
        </span>

        <div className="ml-auto flex items-center gap-2">
          <input
            className="h-8 w-40 rounded-deck border border-deck-line bg-deck-bg px-2.5 font-mono text-xs text-neutral-200 placeholder:text-neutral-500 focus:border-deck-accent focus:outline-none"
            placeholder="192.168.1.x"
            value={manualIp}
            onChange={(e) => setManualIp(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && manualIp.trim() && void connect(manualIp.trim())}
          />
          <button
            className="h-8 rounded-deck bg-deck-accent px-3 font-medium text-white transition-colors hover:bg-deck-accent-hover disabled:opacity-40"
            disabled={busy !== null || !manualIp.trim()}
            onClick={() => void connect(manualIp.trim())}
          >
            {busy?.kind === "connect" ? "Connecting…" : "Connect"}
          </button>
        </div>
      </header>

      {/* InfoBar */}
      {notice && (
        <div
          className={`flex shrink-0 items-start gap-2 border-b px-4 py-2 ${
            notice.kind === "error"
              ? "border-deck-line bg-[#2b2222] text-neutral-200"
              : notice.kind === "success"
                ? "border-deck-line bg-deck-raised text-neutral-200"
                : "border-deck-line bg-deck-raised text-neutral-200"
          }`}
        >
          {notice.kind === "error" ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-deck-err" />
          ) : notice.kind === "success" ? (
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-deck-ok" />
          ) : null}
          <p className="min-w-0 flex-1 text-xs leading-5">{notice.body}</p>
          <button
            className="shrink-0 rounded-deck p-0.5 text-neutral-500 hover:bg-deck-line hover:text-neutral-300"
            onClick={dismissNotice}
            aria-label="Dismiss"
          >
            <span className="text-xs">✕</span>
          </button>
        </div>
      )}

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1">
        {/* Left pane: device list */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-deck-line bg-deck-panel">
          <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-widest text-neutral-500">
            Devices
          </p>
          <div className="flex-1 overflow-y-auto px-1.5 pb-3">
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
              <p className="px-2 py-4 text-xs leading-5 text-neutral-500">
                No TVs found. On the TV, go to Settings, About, tap "Build number" 5 times, then turn
                on network debugging in Developer options.
              </p>
            )}
          </div>
        </aside>

        {/* Right pane: status, presets, installer */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* status banner */}
          <div className="flex items-baseline gap-3 border-b border-deck-line bg-deck-bg px-5 py-2.5">
            {connected ? (
              <>
                <span className="h-2 w-2 shrink-0 translate-y-[-1px] self-center rounded-full bg-deck-ok" />
                <span className="font-medium text-neutral-100">
                  {connected.brand} {connected.model}
                </span>
                <span className="font-mono text-xs text-neutral-400">{connectedIp}</span>
                <span className="text-xs text-neutral-500">
                  Android {connected.android_version}
                </span>
              </>
            ) : (
              <span className="text-neutral-400">No TV connected: {status}</span>
            )}
            {connected && (
              <>
                <span className="ml-auto text-xs text-neutral-500">{status}</span>
                <button
                  className="shrink-0 rounded-deck border border-deck-line px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-deck-raised hover:text-neutral-200"
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </button>
              </>
            )}
          </div>

          <SectionLabel>Presets</SectionLabel>
          <div className="mx-5 rounded-deck border border-deck-line">
            {presets.map((p, i) => (
              <PresetRow
                key={p.id}
                preset={p}
                first={i === 0}
                busy={busy === null ? false : busy.kind === "preset" && "id" in busy && busy.id === p.id}
                applied={!!applied[p.id]}
                devOpen={!!devOpen[p.id]}
                onToggleDev={() => setDevOpen((s) => ({ ...s, [p.id]: !s[p.id] }))}
                onApply={() => void applyPreset(p.id)}
              />
            ))}
          </div>

          <SectionLabel>Custom launcher</SectionLabel>
          <LauncherRow
            launcherPkg={launcherPkg}
            setLauncherPkg={setLauncherPkg}
            busy={busy === null ? false : busy.kind === "preset" && "id" in busy && busy.id === "grant"}
            applied={!!applied["grant"]}
            devOpen={!!devOpen["grant"]}
            onToggleDev={() => setDevOpen((s) => ({ ...s, grant: !s["grant"] }))}
            onApply={() => void applyLauncher()}
            connected={!!connected}
          />

          <SectionLabel>Install an app</SectionLabel>
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
              <SectionLabel>Recent activity</SectionLabel>
              <ActivityLog results={results} />
            </>
          )}
          <div className="h-8" />
        </main>
      </div>
    </div>
  );
}

/* ------------------------------ pieces ------------------------------ */

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="mb-2 mt-6 px-5 text-[11px] font-medium uppercase tracking-widest text-neutral-500">
      {children}
    </p>
  );
}

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
  const busyHere = busy === undefined || busy === null ? false : busy.kind === "connect" && "ip" in busy && busy.ip === device.ip;
  const isConnected = connectedIp === device.ip;
  return (
    <div
      className={`group flex items-center gap-2 rounded-deck px-3 py-2.5 transition-colors ${
        isConnected ? "bg-deck-raised" : "hover:bg-deck-line-soft"
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${isConnected ? "bg-deck-ok" : "bg-neutral-600"}`}
      />
      <div className="min-w-0 flex-1">
        <p className={`truncate text-xs font-medium ${isConnected ? "text-neutral-100" : "text-neutral-300"}`}>
          {device.name ?? "Unknown TV"}
        </p>
        <p className="truncate font-mono text-[11px] text-neutral-500">{device.ip}</p>
      </div>
      {!isConnected && (
        <button
          className="h-6 rounded-deck border border-deck-line px-2 text-[11px] text-neutral-300 opacity-0 transition-opacity hover:bg-deck-raised group-hover:opacity-100 disabled:opacity-30"
          disabled={busyHere || (busy !== undefined && busy !== null && busy.kind === "connect")}
          onClick={() => void onConnect(device.ip)}
        >
          {busyHere ? <LoaderCircle className="h-3 w-3 animate-spin" /> : "Connect"}
        </button>
      )}
      <button
        className="shrink-0 text-neutral-600 opacity-0 transition-opacity hover:text-neutral-400 group-hover:opacity-100"
        title="Hide this TV"
        onClick={forget}
      >
        <span className="text-xs">✕</span>
      </button>
    </div>
  );
}

function ApplyButton({
  busy,
  applied,
  onClick,
  disabled,
}: {
  busy: boolean;
  applied: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="h-7 shrink-0 rounded-deck border border-deck-line bg-deck-raised px-3 text-xs font-medium text-neutral-100 transition-colors hover:bg-deck-line disabled:opacity-40"
      disabled={busy || applied || disabled}
      onClick={onClick}
    >
      {busy ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : applied ? (
        <span className="flex items-center gap-1">
          <Check className="h-3.5 w-3.5 text-deck-ok" /> Applied
        </span>
      ) : (
        "Apply"
      )}
    </button>
  );
}

function AdvancedToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="flex items-center gap-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300"
      onClick={onToggle}
      aria-expanded={open}
    >
      <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      Advanced details
    </button>
  );
}

function PresetRow({
  preset,
  first,
  busy,
  applied,
  devOpen,
  onToggleDev,
  onApply,
}: {
  preset: Preset;
  first: boolean;
  busy: boolean;
  applied: boolean;
  devOpen: boolean;
  onToggleDev: () => void;
  onApply: () => void;
}) {
  const sub = preset.description.split(".")[0];
  return (
    <div className={`px-3.5 py-2.5 ${first ? "" : "border-t border-deck-line-soft"}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-neutral-100">{preset.label}</p>
          <p className="truncate text-xs text-neutral-400">{sub}</p>
        </div>
        {preset.restart_required && (
          <span className="shrink-0 text-[11px] text-deck-warn/80">Reboot to finish</span>
        )}
        <ApplyButton busy={busy} applied={applied} onClick={onApply} />
      </div>
      <div className="mt-1"><AdvancedToggle open={devOpen} onToggle={onToggleDev} /></div>
      {devOpen && (
        <div className="mt-1.5 rounded-deck bg-deck-bg py-1.5 font-mono text-[11px] leading-5">
          {preset.commands.map((c, i) => (
            <p key={i} className="truncate px-2 text-neutral-400" title={c.cmd}>
              {c.cmd}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function LauncherRow({
  launcherPkg,
  setLauncherPkg,
  busy,
  applied,
  devOpen,
  onToggleDev,
  onApply,
  connected,
}: {
  launcherPkg: string;
  setLauncherPkg: (s: string) => void;
  busy: boolean;
  applied: boolean;
  devOpen: boolean;
  onToggleDev: () => void;
  onApply: () => void;
  connected: boolean;
}) {
  const commands = [
    `pm grant ${launcherPkg} android.permission.WRITE_SECURE_SETTINGS`,
    `pm grant ${launcherPkg} android.permission.READ_LOGS`,
    `pm grant ${launcherPkg} android.permission.PACKAGE_USAGE_STATS`,
  ];
  return (
    <div className="mx-5 rounded-deck border border-deck-line px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-neutral-100">Use a custom home screen</p>
          <p className="truncate text-xs text-neutral-400">
            Lets a replacement launcher, such as Projectivy, take over the home screen.
          </p>
        </div>
        <select
          className="h-7 rounded-deck border border-deck-line bg-deck-bg px-2 text-xs text-neutral-200 focus:border-deck-accent focus:outline-none"
          value={launcherPkg}
          onChange={(e) => setLauncherPkg(e.target.value)}
        >
          <option value="com.spocky.projtv">Projectivy Launcher</option>
          <option value="com.spocky.projtv.free">Projectivy (Free)</option>
          <option value="com.google.android.tvlauncher">Stock Google TV launcher</option>
        </select>
        <button
          className="h-7 shrink-0 rounded-deck border border-deck-line bg-deck-raised px-3 text-xs font-medium text-neutral-100 transition-colors hover:bg-deck-line disabled:opacity-40"
          onClick={onApply}
          disabled={busy || applied || !connected}
        >
          {busy ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : applied ? (
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-deck-ok" /> Ready
            </span>
          ) : (
            "Set up"
          )}
        </button>
      </div>
      <div className="mt-1"><AdvancedToggle open={devOpen} onToggle={onToggleDev} /></div>
      {devOpen && (
        <div className="mt-1.5 rounded-deck bg-deck-bg py-1.5 font-mono text-[11px] leading-5">
          {commands.map((c, i) => (
            <p key={i} className="truncate px-2 text-neutral-400" title={c}>
              {c}
            </p>
          ))}
        </div>
      )}
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
    <div className="mx-5">
      <div
        className={`flex flex-col items-center justify-center rounded-deck border border-dashed px-6 py-8 text-center transition-colors ${
          dropping ? "border-deck-accent/70" : "border-deck-line hover:border-neutral-500"
        }`}
      >
        <Upload className={`h-5 w-5 ${dropping ? "text-neutral-200" : "text-neutral-500"}`} />
        <p className="mt-2 text-xs text-neutral-300">Drag an app file (.apk) here to install</p>
        <div className="mt-3">
          <button
            className="h-7 rounded-deck border border-deck-line bg-deck-raised px-3 text-xs font-medium text-neutral-100 transition-colors hover:bg-deck-line disabled:opacity-40"
            onClick={() => void onBrowse()}
            disabled={disabled || busy}
          >
            {busy ? (
              <span className="flex items-center gap-1.5">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Installing…
              </span>
            ) : done ? (
              <span className="flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-deck-ok" /> Installed
              </span>
            ) : (
              "Browse files"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityLog({ results }: { results: PresetResult[] }) {
  return (
    <div className="mx-5 rounded-deck border border-deck-line bg-deck-bg px-3.5 py-2 font-mono text-[11px] leading-5">
      {results.map((r, i) => (
        <div key={`${r.preset_id}-${i}`} className="mb-1.5 last:mb-0">
          {r.steps.map((s, j) => (
            <p
              key={j}
              className={
                s.toLowerCase().includes("error")
                  ? "text-deck-err"
                  : s.endsWith(": OK")
                    ? "text-deck-ok/80"
                    : "text-neutral-500"
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
