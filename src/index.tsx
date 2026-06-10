import { ButtonItem, ModalRoot, PanelSection, PanelSectionRow, SliderField, staticClasses, TextField } from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
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
  accel_exponent: number;
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
  daemon_bundle_ready?: boolean;
  daemon_installed?: boolean;
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
const installDaemon = callable<[authPassword: string], DaemonState>("install_daemon");
const uninstallDaemon = callable<[authPassword: string], DaemonState>("uninstall_daemon");
const startDaemon = callable<[], DaemonState>("start_daemon");
const stopDaemon = callable<[], DaemonState>("stop_daemon");
const restartDaemon = callable<[], DaemonState>("restart_daemon");

const defaultConfig: DaemonConfig = {
  global: { enabled: true },
  region: { x_min: 0.5, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
  motion: {
    sensitivity: 100,
    accel_strength: 0.4,
    accel_exponent: 1.8,
    smoothing: 0.1,
    deadzone: 0.0,
  },
  inertia: { enabled: true, friction: 0.92, cutoff: 0.01 },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return candidate.message;
    }

    try {
      return JSON.stringify(candidate, null, 2);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

type InlineError = {
  title: string;
  call: string;
  message: string;
  raw: string;
};

function formatRawError(error: unknown) {
  if (error instanceof Error) {
    return JSON.stringify(
      {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      null,
      2,
    );
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
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
      accel_exponent: config?.motion?.accel_exponent ?? defaultConfig.motion.accel_exponent,
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
        minWidth: 0,
        maxWidth: "12rem",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        flex: "0 1 auto",
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
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
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
    <div style={{ marginBottom: "0.9rem" }}>
      <SliderField
        label={label}
        description={format(value)}
        value={value}
        min={min}
        max={max}
        step={step}
        showValue={false}
        highlightOnFocus
        onChange={onChange}
      />
    </div>
  );
}

function Content() {
  const [state, setState] = useState<DaemonState | null>(null);
  const [config, setLocalConfig] = useState<DaemonConfig>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"install" | "uninstall" | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const authPasswordRef = useRef(authPassword);
  const authBusyRef = useRef(authBusy);
  authPasswordRef.current = authPassword;
  authBusyRef.current = authBusy;

  // Intercept Enter in capture phase so ModalRoot doesn't close the dialog first.
  useEffect(() => {
    if (!authModalOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !authBusyRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setAuthBusy(true);
        setAuthError(null);
        runInstall(authPasswordRef.current)
          .then((success) => { if (success) closeAuthorizationModal(); })
          .catch((err: unknown) => { setAuthError(formatError(err)); })
          .finally(() => { setAuthBusy(false); });
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authModalOpen]);

  const recordInlineError = (title: string, call: string, error: unknown) => {
    const message = formatError(error);
    const raw = formatRawError(error);
    setInlineError({ title, call, message, raw });
    return message;
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await getState();
      setState(next);
      setLocalConfig(normalizeConfig(next.config));
    } catch (error) {
      const message = recordInlineError("Unable to reach daemon", "getState()", error);
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
      setInlineError(null);
    } catch (error) {
      const message = recordInlineError("Failed to update config", "setConfig(patch)", error);
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
      setInlineError(null);
    } catch (error) {
      const message = recordInlineError("Service action failed", "runServiceAction(action)", error);
      toaster.toast({ title: "Service action failed", body: message });
      await refresh();
    }
  };

  const runInstall = async (password: string) => {
    setInstalling(true);
    try {
      const next = state?.daemon_installed
        ? await uninstallDaemon(password)
        : await installDaemon(password);
      setState(next);
      if (next.config) {
        setLocalConfig(normalizeConfig(next.config));
      }
      setInlineError(null);
      toaster.toast({
        title: state?.daemon_installed ? "Daemon uninstalled" : "Daemon installed",
        body: state?.daemon_installed
          ? "The user service, permissions, and bundled daemon files were removed."
          : "The user service and permissions were installed.",
      });
      return true;
    } catch (error) {
      const title = state?.daemon_installed ? "Daemon uninstall failed" : "Daemon install failed";
      const call = state?.daemon_installed ? "uninstallDaemon()" : "installDaemon()";
      const message = recordInlineError(title, call, error);
      toaster.toast({
        title,
        body: message || "See ~/.local/state/touchscreen-trackpad/plugin.log for details.",
      });
      await refresh();
      return false;
    } finally {
      setInstalling(false);
    }
  };

  const openAuthorizationModal = (mode: "install" | "uninstall") => {
    setAuthMode(mode);
    setAuthPassword("");
    setAuthError(null);
    setAuthModalOpen(true);
  };

  const closeAuthorizationModal = () => {
    setAuthModalOpen(false);
    setAuthPassword("");
    setAuthMode(null);
    setAuthError(null);
  };

  const submitAuthorization = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const success = await runInstall(authPassword);
      if (success) {
        closeAuthorizationModal();
      }
    } catch (error) {
      setAuthError(formatError(error));
    } finally {
      setAuthBusy(false);
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

  const controlReady = state?.service_control_ready ?? false;
  const bundleReady = state?.daemon_bundle_ready ?? false;
  const daemonInstalled = state?.daemon_installed ?? false;
  const connected = state?.connected ?? false;
  const serviceStatus = state?.service_status;
  const serviceActive = serviceStatus?.active_state === "active" || state?.service_active === true;
  const showInstalledUI = daemonInstalled || serviceActive;
  const statusLabel = loading
    ? "Loading"
    : connected
      ? serviceActive
        ? "Connected"
        : "Socket ready"
      : "Offline";

  return (
    <div
      style={{
        minHeight: "100%",
        padding: "1rem",
        width: "100%",
        boxSizing: "border-box",
        overflowX: "hidden",
        background: "linear-gradient(160deg, rgba(6, 10, 18, 0.98), rgba(13, 21, 37, 0.94))",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          width: "100%",
          maxWidth: "100%",
          boxSizing: "border-box",
          margin: "0 auto",
        }}
      >
        <section
          style={{
            padding: "1rem",
            borderRadius: 18,
            background: "rgba(20, 25, 35, 0.96)",
            border: `1px solid ${inlineError ? "rgba(255, 127, 145, 0.3)" : "rgba(137, 145, 175, 0.18)"}`,
            boxShadow: "0 18px 45px rgba(0, 0, 0, 0.26)",
            color: "#ffe7eb",
          }}
        >
          <div style={{ fontSize: "0.95rem", fontWeight: 800, marginBottom: "0.4rem" }}>Debug</div>
          <div style={{ display: "grid", gap: "0.4rem", fontSize: "0.82rem", color: "#d4d7e0" }}>
            <div>
              Install state: <strong style={{ color: "#f4f6fb" }}>{daemonInstalled ? "installed" : "not installed"}</strong>
            </div>
            <div>
              Bundle: <strong style={{ color: "#f4f6fb" }}>{bundleReady ? "ready" : "missing"}</strong>
            </div>
            <div>
              Control: <strong style={{ color: "#f4f6fb" }}>{controlReady ? "ready" : "not ready"}</strong>
            </div>
            <div>
              Socket: <strong style={{ color: "#f4f6fb" }}>{state?.socket_path ?? "unknown"}</strong>
            </div>
            <div>
              Plugin log: <strong style={{ color: "#f4f6fb" }}>~/.local/state/touchscreen-trackpad/plugin.log</strong>
            </div>
          </div>

          <div style={{ marginTop: "0.9rem", paddingTop: "0.8rem", borderTop: "1px solid rgba(255, 255, 255, 0.12)" }}>
            <div style={{ fontSize: "0.86rem", fontWeight: 700, marginBottom: "0.35rem", color: inlineError ? "#ffbcc6" : "#aeb5c7" }}>
              {inlineError ? inlineError.title : "No error captured"}
            </div>
            <div style={{ fontSize: "0.78rem", fontWeight: 700, marginBottom: "0.45rem", color: inlineError ? "#ffbcc6" : "#aeb5c7" }}>
              {inlineError ? `Failed call: ${inlineError.call}` : "Waiting for the next failure to capture details."}
            </div>
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, fontSize: "0.86rem", color: inlineError ? "#ffd8de" : "#cfd5e2" }}>
              {inlineError ? inlineError.message : "This panel stays visible even when the daemon is not installed, so you can confirm bundle state and the current socket path before testing install."}
            </div>
            {inlineError ? (
              <div style={{ marginTop: "0.8rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(255, 255, 255, 0.12)" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: "0.35rem", color: "#ffbcc6" }}>Raw exception</div>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 240,
                    overflow: "auto",
                    fontSize: "0.78rem",
                    lineHeight: 1.45,
                    color: "#ffeef1",
                  }}
                >
                  {inlineError.raw}
                </pre>
              </div>
            ) : null}
          </div>
        </section>

        <section
          style={{
            padding: "1.1rem 1rem",
            borderRadius: 20,
            background: "linear-gradient(135deg, rgba(25, 33, 53, 0.98), rgba(12, 17, 29, 0.98))",
            border: "1px solid rgba(137, 145, 175, 0.16)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "stretch" }}>
            <div style={{ width: "100%", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.35rem", flexWrap: "wrap", minWidth: 0 }}>
                <div className={staticClasses.Title}>Touchscreen Trackpad</div>
                <Badge active={connected} label={statusLabel} />
              </div>
              <div style={{ color: "#aeb5c7", fontSize: "0.92rem", maxWidth: 640 }}>
                Install the daemon, manage the user service from Game Mode, and tune the runtime config over JSON IPC.
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-start", width: "100%" }}>
              {showInstalledUI ? (
                <ButtonItem layout="below" onClick={() => void refresh()}>
                  Refresh
                </ButtonItem>
              ) : (
                <ButtonItem layout="below" onClick={() => openAuthorizationModal("install")} disabled={installing}>
                  Install daemon
                </ButtonItem>
              )}
            </div>
          </div>
          <div style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "#8f98ad" }}>
            Socket: {state?.socket_path ?? "unknown"} {saving ? "• saving" : ""}
          </div>
          <div style={{ marginTop: "0.45rem", fontSize: "0.82rem", color: "#8f98ad" }}>
            Service: {serviceStatus?.active_state ?? "unknown"} / {serviceStatus?.sub_state ?? "unknown"} / {serviceStatus?.unit_file_state ?? "unknown"}
          </div>
          <div style={{ marginTop: "0.45rem", fontSize: "0.82rem", color: "#8f98ad" }}>
            Bundle: {bundleReady ? "ready" : "missing"} • Install: {daemonInstalled ? "installed" : "not installed"}
          </div>
        </section>

        {showInstalledUI ? (
        <PanelSection title="Core">
          <PanelSectionRow>
            <SectionCard
              title="Daemon control"
              subtitle="Install the daemon once, then start or stop the service and tune runtime config from Game Mode."
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                  <Badge active={serviceActive} label={serviceActive ? "Running" : "Stopped"} />
                  <Badge active={daemonInstalled} label={daemonInstalled ? "Installed" : "Not installed"} />
                  <Badge active={controlReady} label={controlReady ? "Control ready" : "No service control"} />
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <ButtonItem layout="below" onClick={() => openAuthorizationModal(daemonInstalled ? "uninstall" : "install")} disabled={installing}>
                    {daemonInstalled ? "Uninstall daemon" : "Install daemon"}
                  </ButtonItem>
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
                  The installer writes a user service, a touchscreen symlink rule, and a uinput permission rule. If the packaged daemon files are missing, the click will fail with a detailed error instead of being blocked here.
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
                min={1}
                max={200}
                step={1}
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
                label="Acceleration exponent"
                value={config.motion.accel_exponent}
                min={0.5}
                max={3}
                step={0.01}
                format={(value) => value.toFixed(2)}
                onChange={(value) => void updateMotion({ ...config.motion, accel_exponent: value })}
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
              <SliderRow
                label="Cutoff"
                value={config.inertia.cutoff}
                min={0}
                max={0.1}
                step={0.001}
                format={(value) => value.toFixed(3)}
                onChange={(value) => void updateInertia({ ...config.inertia, cutoff: value })}
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
        ) : null}

        {authModalOpen ? (
          <ModalRoot
            closeModal={closeAuthorizationModal}
            onCancel={closeAuthorizationModal}
            onOK={() => void submitAuthorization()}
            onEscKeypress={closeAuthorizationModal}
            bDisableBackgroundDismiss
          >
            <div style={{ display: "grid", gap: "0.7rem", padding: "0.25rem 0 0.1rem", width: "min(92vw, 24rem)", maxWidth: "100%", boxSizing: "border-box" }}>
              <div style={{ fontSize: "1rem", fontWeight: 800, color: "#f4f6fb" }}>
                {authMode === "uninstall" ? "Authorize uninstall" : "Authorize install"}
              </div>
              <div style={{ fontSize: "0.88rem", color: "#aeb5c7", lineHeight: 1.45 }}>
                {authMode === "uninstall"
                  ? "Enter your sudo password to remove the udev rule and uninstall the daemon."
                  : "Enter your sudo password to install the udev rule and finish the daemon install."}
              </div>
              <TextField
                label="sudo password"
                value={authPassword}
                bIsPassword
                focusOnMount
                onChange={(event) => setAuthPassword(event.currentTarget.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  borderRadius: 12,
                  border: "1px solid rgba(137, 145, 175, 0.2)",
                  background: "rgba(8, 12, 20, 0.9)",
                  color: "#f4f6fb",
                  padding: "0.8rem 0.9rem",
                  fontSize: "0.95rem",
                }}
              />
              <div style={{ fontSize: "0.8rem", color: authError ? "#ffbcc6" : "#aeb5c7", whiteSpace: "pre-wrap" }}>
                {authError ?? "This dialog is used to trigger the Steam keyboard and keep authorization separate from the main UI."}
              </div>
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
                <ButtonItem layout="below" onClick={closeAuthorizationModal} disabled={authBusy}>
                  Cancel
                </ButtonItem>
                <ButtonItem layout="below" onClick={() => void submitAuthorization()} disabled={authBusy || authPassword.length === 0}>
                  {authBusy ? "Working..." : authMode === "uninstall" ? "Uninstall" : "Install"}
                </ButtonItem>
              </div>
            </div>
          </ModalRoot>
        ) : null}
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
