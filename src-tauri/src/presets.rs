//! One-click preset definitions: safe batch ADB shell commands per intent.
//! Presets are compile-time data, never deserialized from IPC.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PresetCommand {
    pub cmd: String,
    /// What the command accomplishes, shown in per-step results.
    pub note: String,
    /// Matching re-enable command, surfaced so every step is reversible.
    pub undo_cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preset {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Whether the TV needs a reboot for effects to fully apply.
    pub restart_required: bool,
    pub commands: Vec<PresetCommand>,
}

fn disable_cmd(pkg: &str, note: &'static str) -> PresetCommand {
    PresetCommand {
        cmd: format!("pm disable-user --user 0 {}", pkg),
        note: note.to_string(),
        undo_cmd: Some(format!("pm enable --user 0 {}", pkg)),
    }
}

fn grant_cmd(pkg: &str, perm: &str, note: &str) -> PresetCommand {
    PresetCommand {
        cmd: format!("pm grant {} {}", pkg, perm),
        note: note.to_string(),
        undo_cmd: Some(format!("pm revoke {} {}", pkg, perm)),
    }
}

/// PatchWall / MIUI-TV promo, push and telemetry packages seen on Mi Box & Mi
/// TV firmware. Disabling is per-user, fully reversible with `pm enable`; no
/// app data is removed.
const XIAOMI_BLOAT: [(&str, &str); 6] = [
    ("com.xiaomi.mitv.tvpush", "TV push / ad push service"),
    ("com.mi.android.globalminet", "MIUI global promo overlay"),
    ("com.xiaomi.mibrainsdk", "Xiaomi personalization / telemetry"),
    ("com.miui.systemAdSolution", "System ad solution service"),
    ("com.mitv.statisticxmi", "MiTV statistics collection"),
    ("com.mitv.screensaver", "Screensaver ad carousel"),
];

/// Full preset catalog exposed to the frontend.
pub fn catalog() -> Vec<Preset> {
    let mut presets = vec![
        Preset {
            id: "xiaomi-debloat".into(),
            label: "Remove Xiaomi Stock Ads".into(),
            description:
                "Turns off PatchWall ads, promo push and telemetry apps. Reversible from the same card.".into(),
            restart_required: true,
            commands: XIAOMI_BLOAT
                .iter()
                .map(|(pkg, note)| disable_cmd(pkg, note))
                .collect(),
        },
        Preset {
            id: "background-ram-opt".into(),
            label: "Cap Idle Background Apps".into(),
            description:
                "Keeps extra memory free so the home screen stays quick.".into(),
            restart_required: false,
            commands: vec![
                PresetCommand {
                    cmd: "device_config put activity_manager max_phantom_processes 2".into(),
                    note: "Cap background processes to 2".into(),
                    undo_cmd:
                        Some("device_config put activity_manager max_phantom_processes -1".into()),
                },
                PresetCommand {
                    cmd: "settings put global hidden_api_policy 1".into(),
                    note: "Keep hidden system APIs reachable".into(),
                    undo_cmd:
                        Some("settings put global hidden_api_policy -1".into()),
                },
            ],
        },
        Preset {
            id: "animation-speedup".into(),
            label: "Speed Up Animations".into(),
            description: "Cuts menu transition times in half.".into(),
            restart_required: false,
            commands: [
                ("window_animation_scale", "Window animation"),
                ("transition_animation_scale", "Transition animation"),
                ("animator_duration_scale", "Animator duration"),
            ]
            .iter()
            .map(|(key, note)| PresetCommand {
                cmd: format!("settings put global {} 0.5", key),
                note: format!("{} at 0.5x", note),
                undo_cmd: Some(format!("settings put global {} 1.0", key)),
            })
            .collect(),
        },
    ];

    // Individual toggles for fine-grained control over Xiaomi bloat.
    for (pkg, note) in XIAOMI_BLOAT.iter() {
        presets.push(Preset {
            id: format!("toggle-{}", pkg.split('.').last().unwrap_or(pkg)),
            label: format!("Disable {}", note),
            description: "Can be turned back on later.".into(),
            restart_required: true,
            commands: vec![disable_cmd(pkg, note)],
        });
    }

    presets
}

/// Launcher permission grant card (Module C).
pub fn launcher_preset(package: &str) -> Preset {
    Preset {
        id: "grant-launcher".into(),
        label: "Grant launcher permissions".into(),
        description: format!(
            "Grants WRITE_SECURE_SETTINGS & friends to {} so it can manage app hiding and act as the default launcher.",
            package
        ),
        restart_required: false,
        commands: vec![
            grant_cmd(package, "android.permission.WRITE_SECURE_SETTINGS", "WRITE_SECURE_SETTINGS"),
            grant_cmd(package, "android.permission.READ_LOGS", "READ_LOGS"),
            grant_cmd(package, "android.permission.PACKAGE_USAGE_STATS", "Usage access"),
        ],
    }
}

/// Launchers offered in the card dropdown.
pub const KNOWN_LAUNCHERS: [(&str, &str); 3] = [
    ("com.spocky.projtv", "Projectivy Launcher"),
    ("com.spocky.projtv.free", "Projectivy (Free)"),
    ("com.google.android.tvlauncher", "Stock Google TV launcher"),
];
