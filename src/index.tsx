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

type OutputConfig = {
  mouse: boolean;
  gamepad: boolean;
};

type InputConfig = {
  max_touch_frame_age_ms: number;
};

type DaemonConfig = {
  global: { enabled: boolean };
  input: InputConfig;
  region: RegionConfig;
  motion: MotionConfig;
  inertia: InertiaConfig;
  output: OutputConfig;
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

const defaultConfig: DaemonConfig = {
  global: { enabled: true },
  input: { max_touch_frame_age_ms: 60 },
  region: { x_min: 0.5, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
  motion: {
    sensitivity: 4.1,
    accel_strength: 0.6,
    accel_exponent: 1.2,
    smoothing: 0.5,
    deadzone: 0.0002,
  },
  inertia: { enabled: true, friction: 0.20, cutoff: 0.01 },
  output: { mouse: true, gamepad: false },
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
    input: {
      max_touch_frame_age_ms: config?.input?.max_touch_frame_age_ms ?? defaultConfig.input.max_touch_frame_age_ms,
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
    output: {
      mouse: config?.output?.mouse ?? defaultConfig.output.mouse,
      gamepad: config?.output?.gamepad ?? defaultConfig.output.gamepad,
    },
  };
}

function mergePatch(base: DaemonConfig, patch: PartialDaemonConfig): DaemonConfig {
  return normalizeConfig({
    global: patch.global ?? base.global,
    input: patch.input ?? base.input,
    region: patch.region ?? base.region,
    motion: patch.motion ?? base.motion,
    inertia: patch.inertia ?? base.inertia,
    output: patch.output ?? base.output,
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
  const [, setLoading] = useState(true);
  const [, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [, setInlineError] = useState<InlineError | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"install" | "uninstall" | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const authPasswordRef = useRef(authPassword);
  const authBusyRef = useRef(authBusy);
  const pendingConfigRef = useRef<DaemonConfig | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  authPasswordRef.current = authPassword;
  authBusyRef.current = authBusy;

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (pendingConfigRef.current) {
        void setConfig(pendingConfigRef.current);
      }
    };
  }, []);

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
    pendingConfigRef.current = mergePatch(pendingConfigRef.current ?? config, patch);

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      const nextConfig = pendingConfigRef.current;
      pendingConfigRef.current = null;
      saveTimerRef.current = null;

      if (!nextConfig) {
        return;
      }

      setSaving(true);
      void setConfig(nextConfig)
        .then((next) => {
          setState(next);
          if (next.config) {
            setLocalConfig(normalizeConfig(next.config));
          }
          setInlineError(null);
        })
        .catch(async (error) => {
          const message = recordInlineError("Failed to update config", "setConfig(patch)", error);
          toaster.toast({ title: "Failed to update config", body: message });
          await refresh();
        })
        .finally(() => {
          setSaving(false);
        });
    }, 180);
  };

  const flushPendingConfig = async () => {
    const nextConfig = pendingConfigRef.current;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingConfigRef.current = null;

    if (!nextConfig) {
      return;
    }

    setSaving(true);
    try {
      const next = await setConfig(nextConfig);
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
    await flushPendingConfig();
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
    await flushPendingConfig();
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

  const updateOutput = async (patch: Partial<OutputConfig>) => {
    await applyPatch({ output: { ...config.output, ...patch } });
  };

  const updateRegion = async (nextRegion: RegionConfig) => {
    await applyPatch({ region: nextRegion });
  };

  const updateMotion = async (nextMotion: MotionConfig) => {
    await applyPatch({ motion: nextMotion });
  };

  const updateInput = async (nextInput: InputConfig) => {
    await applyPatch({ input: nextInput });
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
  const daemonInstalled = state?.daemon_installed ?? false;
  const serviceStatus = state?.service_status;
  const serviceActive = serviceStatus?.active_state === "active" || state?.service_active === true;
  const statusLabel = serviceActive ? "Running" : daemonInstalled ? "Stopped" : "Not Installed";
  const showRuntimeConfig = serviceActive;

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
            padding: "1.1rem 1rem",
            borderRadius: 20,
            background: "linear-gradient(135deg, rgba(25, 33, 53, 0.98), rgba(12, 17, 29, 0.98))",
            border: "1px solid rgba(137, 145, 175, 0.16)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <div className={staticClasses.Title}>Touchscreen Trackpad</div>
              {!daemonInstalled ? (
                <div style={{ color: "#aeb5c7", fontSize: "0.92rem", maxWidth: 680, lineHeight: 1.45 }}>
                  Decky plugin for managing the touchscreen-trackpad service. Turn your touchscreen into a configurable trackpad virtual mouse/gamepad input.
                </div>
              ) : null}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              <Badge active={serviceActive} label={statusLabel} />
              {!daemonInstalled ? (
                <ButtonItem layout="below" onClick={() => openAuthorizationModal("install")} disabled={installing}>
                  Install daemon
                </ButtonItem>
              ) : serviceActive ? (
                <ButtonItem layout="below" onClick={() => void runServiceAction(stopDaemon)} disabled={!controlReady}>
                  Stop daemon
                </ButtonItem>
              ) : (
                <>
                  <ButtonItem layout="below" onClick={() => void runServiceAction(startDaemon)} disabled={!controlReady}>
                    Start daemon
                  </ButtonItem>
                  <ButtonItem layout="below" onClick={() => openAuthorizationModal("uninstall")} disabled={installing}>
                    Uninstall daemon
                  </ButtonItem>
                </>
              )}
            </div>
          </div>
        </section>

        {showRuntimeConfig ? (
          <PanelSection title="Runtime config">
            <PanelSectionRow>
              <SectionCard title="Runtime enabled" subtitle="Enable or disable the daemon's runtime config.">
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
              <SectionCard
                title="Output devices"
                subtitle="If a game also treats the virtual gamepad as a second controller (e.g. uzdoom) and double-applies aim, disable the gamepad. Applies immediately (restarts the daemon)."
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <input
                      type="checkbox"
                      checked={config.output.mouse}
                      disabled={!config.output.gamepad}
                      onChange={(event) => void updateOutput({ mouse: event.currentTarget.checked })}
                    />
                    <span style={{ color: "#e8ebf5", fontWeight: 600 }}>Virtual mouse</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <input
                      type="checkbox"
                      checked={config.output.gamepad}
                      disabled={!config.output.mouse}
                      onChange={(event) => void updateOutput({ gamepad: event.currentTarget.checked })}
                    />
                    <span style={{ color: "#e8ebf5", fontWeight: 600 }}>Virtual gamepad</span>
                  </label>
                </div>
              </SectionCard>
            </PanelSectionRow>

            <PanelSectionRow>
              <SectionCard title="Input timing" subtitle="Tune how aggressively the UI drops delayed touch frames.">
                <SliderRow
                  label="Max frame age"
                  value={config.input.max_touch_frame_age_ms}
                  min={4}
                  max={100}
                  step={1}
                  format={(value) => `${value.toFixed(0)} ms`}
                  onChange={(value) => void updateInput({ ...config.input, max_touch_frame_age_ms: value })}
                />
              </SectionCard>
            </PanelSectionRow>

            <PanelSectionRow>
              <SectionCard title="Motion" subtitle="Live trackpad tuning parameters.">
                <SliderRow
                  label="Sensitivity"
                  value={config.motion.sensitivity}
                  min={0.1}
                  max={50}
                  step={0.5}
                  format={(value) => `${value.toFixed(1)}x`}
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
                  label="Smoothing (higher = smoother)"
                  value={config.motion.smoothing}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(value) => value.toFixed(2)}
                  onChange={(value) => void updateMotion({ ...config.motion, smoothing: value })}
                />
                <SliderRow
                  label="Deadzone"
                  value={config.motion.deadzone}
                  min={0}
                  max={0.005}
                   step={0.00005}
                   format={(value) => value.toFixed(5)}
                  onChange={(value) => void updateMotion({ ...config.motion, deadzone: value })}
                />
              </SectionCard>
            </PanelSectionRow>

            <PanelSectionRow>
              <SectionCard title="Inertia" subtitle="Glide that settles when movement stops (pressed or lifted).">
                <SliderRow
                  label="Friction (higher = stops sooner)"
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
