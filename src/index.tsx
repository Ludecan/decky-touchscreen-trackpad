import { ButtonItem, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaWaveSquare } from "react-icons/fa";

type RegionConfig = {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
};

type MotionConfig = {
  sensitivity: number;
  accel_strength: number;
  smoothing: number;
  deadzone: number;
};

type InertiaConfig = {
  enabled: boolean;
  friction: number;
  cutoff: number;
};

type DaemonConfig = {
  global: { enabled: boolean };
  region: RegionConfig;
  motion: MotionConfig;
  inertia: InertiaConfig;
};

type DaemonState = {
  connected: boolean;
  service_active: boolean;
  service_control_ready?: boolean;
  service_status?: {
    active_state: string;
    sub_state: string;
    unit_file_state: string;
    query_ok?: boolean;
  };
  socket_path: string;
  config: DaemonConfig | null;
};

type PartialDaemonConfig = Partial<DaemonConfig>;

const getState = callable<[], DaemonState>("get_state");
const setConfig = callable<[patch: PartialDaemonConfig], DaemonState>("set_config");
const startDaemon = callable<[], DaemonState>("start_daemon");
const stopDaemon = callable<[], DaemonState>("stop_daemon");
const restartDaemon = callable<[], DaemonState>("restart_daemon");

const defaultConfig: DaemonConfig = {
  global: { enabled: true },
  region: { x_min: 0.5, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
  motion: {
    sensitivity: 1.0,
    accel_strength: 0.4,
    smoothing: 0.1,
    deadzone: 0.0,
  },
  inertia: { enabled: true, friction: 0.92, cutoff: 0.01 },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeConfig(config: Partial<DaemonConfig> | null | undefined): DaemonConfig {
  return {
    global: {
      enabled: config?.global?.enabled ?? defaultConfig.global.enabled,
    },
    region: {
      x_min: config?.region?.x_min ?? defaultConfig.region.x_min,
      x_max: config?.region?.x_max ?? defaultConfig.region.x_max,
      y_min: config?.region?.y_min ?? defaultConfig.region.y_min,
      y_max: config?.region?.y_max ?? defaultConfig.region.y_max,
    },
    motion: {
      sensitivity: config?.motion?.sensitivity ?? defaultConfig.motion.sensitivity,
      accel_strength: config?.motion?.accel_strength ?? defaultConfig.motion.accel_strength,
      smoothing: config?.motion?.smoothing ?? defaultConfig.motion.smoothing,
      deadzone: config?.motion?.deadzone ?? defaultConfig.motion.deadzone,
    },
    inertia: {
      enabled: config?.inertia?.enabled ?? defaultConfig.inertia.enabled,
      friction: config?.inertia?.friction ?? defaultConfig.inertia.friction,
      cutoff: config?.inertia?.cutoff ?? defaultConfig.inertia.cutoff,
    },
  };
}

function mergePatch(base: DaemonConfig, patch: PartialDaemonConfig): DaemonConfig {
  return normalizeConfig({
    global: patch.global ?? base.global,
    region: patch.region ?? base.region,
    motion: patch.motion ?? base.motion,
    inertia: patch.inertia ?? base.inertia,
  });
}

function Badge({ active, label }: { active: boolean; label: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.45rem",
        padding: "0.4rem 0.75rem",
        borderRadius: 999,
        fontSize: "0.8rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: active ? "#0f1f12" : "#d4d7e0",
        background: active ? "#84f59f" : "#3b4152",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: active ? "#0f1f12" : "#b4b9c6",
        }}
      />
      {label}
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        padding: "1rem",
        borderRadius: 18,
        background: "rgba(13, 18, 30, 0.88)",
        border: "1px solid rgba(137, 145, 175, 0.18)",
        boxShadow: "0 18px 45px rgba(0, 0, 0, 0.26)",
      }}
    >
      <div style={{ marginBottom: "0.9rem" }}>
        <div style={{ fontSize: "1rem", fontWeight: 700, color: "#f4f6fb" }}>{title}</div>
        <div style={{ marginTop: 4, fontSize: "0.85rem", color: "#aeb5c7" }}>{subtitle}</div>
      </div>
      {children}
    </section>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.9rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", marginBottom: "0.35rem" }}>
        <span style={{ fontSize: "0.9rem", color: "#e8ebf5", fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: "0.85rem", color: "#aeb5c7" }}>{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        style={{ width: "100%" }}
      />
    </label>
  );
}

function Content() {
  const [state, setState] = useState<DaemonState | null>(null);
  const [config, setLocalConfig] = useState<DaemonConfig>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await getState();
      setState(next);
      setLocalConfig(normalizeConfig(next.config));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toaster.toast({ title: "Unable to reach daemon", body: message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const applyPatch = async (patch: PartialDaemonConfig) => {
    setLocalConfig((current) => mergePatch(current, patch));
    setSaving(true);
    try {
      const next = await setConfig(patch);
      setState(next);
      if (next.config) {
        setLocalConfig(normalizeConfig(next.config));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toaster.toast({ title: "Failed to update config", body: message });
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const runServiceAction = async (action: () => Promise<DaemonState>) => {
    try {
      const next = await action();
      setState(next);
      if (next.config) {
        setLocalConfig(normalizeConfig(next.config));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toaster.toast({ title: "Service action failed", body: message });
      await refresh();
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    await applyPatch({ global: { enabled } });
  };

  const updateRegion = async (nextRegion: RegionConfig) => {
    await applyPatch({ region: nextRegion });
  };

  const updateMotion = async (nextMotion: MotionConfig) => {
    await applyPatch({ motion: nextMotion });
  };

  const updateInertia = async (nextInertia: InertiaConfig) => {
    await applyPatch({ inertia: nextInertia });
  };

  const updateRegionBounds = async (key: keyof RegionConfig, rawValue: number) => {
    const nextRegion = { ...config.region };
    const value = clamp(rawValue, 0, 1);

    if (key === "x_min") {
      nextRegion.x_min = Math.min(value, nextRegion.x_max - 0.01);
    } else if (key === "x_max") {
      nextRegion.x_max = Math.max(value, nextRegion.x_min + 0.01);
    } else if (key === "y_min") {
      nextRegion.y_min = Math.min(value, nextRegion.y_max - 0.01);
    } else {
      nextRegion.y_max = Math.max(value, nextRegion.y_min + 0.01);
    }

    await updateRegion(nextRegion);
  };

  const serviceActive = state?.service_active ?? false;
  const controlReady = state?.service_control_ready ?? false;
  const connected = state?.connected ?? false;
  const serviceStatus = state?.service_status;
  const statusLabel = loading
    ? "Loading"
    : connected
      ? serviceActive
        ? "Daemon connected"
        : "Socket ready"
      : "Disconnected";

  return (
    <div
      style={{
        minHeight: "100%",
        padding: "1rem",
        background: "linear-gradient(160deg, rgba(6, 10, 18, 0.98), rgba(13, 21, 37, 0.94))",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          maxWidth: 920,
          margin: "0 auto",
        }}
      >
        <section
          style={{
            padding: "1.1rem 1rem",
            borderRadius: 20,
            background: "linear-gradient(135deg, rgba(25, 33, 53, 0.98), rgba(12, 17, 29, 0.98))",
            border: "1px solid rgba(137, 145, 175, 0.16)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.35rem" }}>
                <div className={staticClasses.Title}>Touchscreen Trackpad</div>
                <Badge active={connected} label={statusLabel} />
              </div>
              <div style={{ color: "#aeb5c7", fontSize: "0.92rem", maxWidth: 640 }}>
                Control the daemon directly over its JSON socket and manage the systemd service from Game Mode.
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <ButtonItem layout="below" onClick={() => void refresh()}>
                Refresh
              </ButtonItem>
            </div>
          </div>
          <div style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "#8f98ad" }}>
            Socket: {state?.socket_path ?? "unknown"} {saving ? "• saving" : ""}
          </div>
          <div style={{ marginTop: "0.45rem", fontSize: "0.82rem", color: "#8f98ad" }}>
            Service: {serviceStatus?.active_state ?? "unknown"} / {serviceStatus?.sub_state ?? "unknown"} / {serviceStatus?.unit_file_state ?? "unknown"}
          </div>
        </section>

        <PanelSection title="Core">
          <PanelSectionRow>
            <SectionCard
              title="Daemon control"
              subtitle="Start or stop the service, then flip runtime config independently for debugging."
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                  <Badge active={serviceActive} label={serviceActive ? "Running" : "Stopped"} />
                  <Badge active={controlReady} label={controlReady ? "Control ready" : "No service control"} />
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <ButtonItem layout="below" onClick={() => void runServiceAction(startDaemon)} disabled={serviceActive || !controlReady}>
                    Start daemon
                  </ButtonItem>
                  <ButtonItem layout="below" onClick={() => void runServiceAction(stopDaemon)} disabled={!serviceActive || !controlReady}>
                    Stop daemon
                  </ButtonItem>
                  <ButtonItem layout="below" onClick={() => void runServiceAction(restartDaemon)} disabled={!controlReady}>
                    Restart daemon
                  </ButtonItem>
                  <ButtonItem layout="below" onClick={() => void refresh()}>
                    Recheck
                  </ButtonItem>
                </div>
                <div style={{ color: "#aeb5c7", fontSize: "0.82rem" }}>
                  If control is unavailable, the backend likely needs root or a narrow passwordless sudo rule for systemctl.
                </div>
              </div>
            </SectionCard>
          </PanelSectionRow>

          <PanelSectionRow>
            <SectionCard
              title="Runtime config"
              subtitle="This toggles the daemon's runtime config, while the buttons above manage the systemd unit."
            >
              <label style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <input
                  type="checkbox"
                  checked={config.global.enabled}
                  onChange={(event) => void toggleEnabled(event.currentTarget.checked)}
                />
                <span style={{ color: "#e8ebf5", fontWeight: 600 }}>
                  {config.global.enabled ? "Enabled" : "Disabled"}
                </span>
              </label>
            </SectionCard>
          </PanelSectionRow>

          <PanelSectionRow>
            <SectionCard title="Motion" subtitle="Live trackpad tuning parameters.">
              <SliderRow
                label="Sensitivity"
                value={config.motion.sensitivity}
                min={0.1}
                max={4}
                step={0.01}
                format={(value) => value.toFixed(2)}
                onChange={(value) => void updateMotion({ ...config.motion, sensitivity: value })}
              />
              <SliderRow
                label="Acceleration strength"
                value={config.motion.accel_strength}
                min={0}
                max={2}
                step={0.01}
                format={(value) => value.toFixed(2)}
                onChange={(value) => void updateMotion({ ...config.motion, accel_strength: value })}
              />
              <SliderRow
                label="Smoothing"
                value={config.motion.smoothing}
                min={0}
                max={1}
                step={0.01}
                format={(value) => value.toFixed(2)}
                onChange={(value) => void updateMotion({ ...config.motion, smoothing: value })}
              />
              <SliderRow
                label="Deadzone"
                value={config.motion.deadzone}
                min={0}
                max={0.5}
                step={0.001}
                format={(value) => value.toFixed(3)}
                onChange={(value) => void updateMotion({ ...config.motion, deadzone: value })}
              />
            </SectionCard>
          </PanelSectionRow>

          <PanelSectionRow>
            <SectionCard title="Inertia" subtitle="Trackball-style glide after finger lift.">
              <SliderRow
                label="Friction"
                value={config.inertia.friction}
                min={0}
                max={1}
                step={0.01}
                format={(value) => value.toFixed(2)}
                onChange={(value) => void updateInertia({ ...config.inertia, friction: value })}
              />
            </SectionCard>
          </PanelSectionRow>

          <PanelSectionRow>
            <SectionCard title="Active region" subtitle="Normalized coordinates in the touchscreen space.">
              <SliderRow
                label="Left edge"
                value={config.region.x_min}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(value) => void updateRegionBounds("x_min", value)}
              />
              <SliderRow
                label="Right edge"
                value={config.region.x_max}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(value) => void updateRegionBounds("x_max", value)}
              />
              <SliderRow
                label="Top edge"
                value={config.region.y_min}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(value) => void updateRegionBounds("y_min", value)}
              />
              <SliderRow
                label="Bottom edge"
                value={config.region.y_max}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                onChange={(value) => void updateRegionBounds("y_max", value)}
              />
            </SectionCard>
          </PanelSectionRow>
        </PanelSection>
      </div>
    </div>
  );
}

export default definePlugin(() => {
  return {
    name: "Touchscreen Trackpad",
    titleView: <div className={staticClasses.Title}>Touchscreen Trackpad</div>,
    content: <Content />,
    icon: <FaWaveSquare />,
  };
});
