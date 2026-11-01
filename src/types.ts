/// Shared IPC types mirroring the Rust serde structs.
export interface DeviceInfo {
  model: string;
  brand: string;
  android_version: string;
  sdk_level: string;
  data_partition: string;
}

export interface ScanEntry {
  ip: string;
  name: string | null;
  source: "mdns" | "tcp";
}

export interface ConnectResult {
  ok: boolean;
  info: DeviceInfo | null;
  fingerprint: string | null;
  error: string | null;
}

export interface PresetCommand {
  cmd: string;
  note: string;
  undo_cmd: string | null;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  restart_required: boolean;
  commands: PresetCommand[];
}

export interface PresetResult {
  preset_id: string;
  steps: string[];
  error: string | null;
}
