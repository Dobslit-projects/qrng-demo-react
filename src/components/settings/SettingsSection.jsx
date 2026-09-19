import { useContext, useState, useCallback } from "react";
import { AppContext } from "../../contexts/AppContext";
import { useLanguage, SOURCE_KEY_MAP } from "../../contexts/LanguageContext";
import { fetchHealth, API_ROUTES } from "../../qrngApi";
import { theme, formatBytes } from "../../theme";
import { QRNG_PRECOLLECTED } from "../../qrngFallbackData";

const SOURCES = [
  {
    key: "remote",
    icon: "\u{1F4E1}",
    titleKey: "settSrc0Title",
    descKey: "settSrc0Desc",
    route: "/qrng/api",
  },
  {
    key: "fpga",
    icon: "\u{1F52C}",
    titleKey: "settSrc1Title",
    descKey: "settSrc1Desc",
    route: "/qrng/api-fpga",
  },
  {
    key: "pre-collected",
    icon: "\u{1F4BE}",
    titleKey: "settSrc2Title",
    descKey: "settSrc2Desc",
    route: null,
  },
];

function StatusDot({ online, degraded }) {
  const color = online ? theme.success : degraded ? theme.warning : theme.danger;
  return (
    <span style={{
      display: "inline-block",
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: color,
      marginRight: 8,
      boxShadow: `0 0 6px ${color}40`,
    }} />
  );
}

function SourceCard({ source, isActive, health, latency, onSelect }) {
  const { t } = useLanguage();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const isFallback = source.key === "pre-collected";
  const online   = isFallback ? true : (health !== null && health.buffer_bytes_available !== 0);
  const degraded = !isFallback && health !== null && health.buffer_bytes_available === 0;

  const handleTest = useCallback(async () => {
    if (isFallback) return;
    setTesting(true);
    setTestResult(null);
    const prefix = API_ROUTES[source.key];
    const h = await fetchHealth(prefix);
    setTestResult(h ? "ok" : "fail");
    setTesting(false);
  }, [source.key, isFallback]);

  return (
    <div
      onClick={() => onSelect(source.key)}
      style={{
        border: `2px solid ${isActive ? theme.quantum : theme.border}`,
        borderRadius: 12,
        padding: 20,
        background: isActive ? `${theme.quantum}08` : theme.surface,
        cursor: "pointer",
        transition: "all 0.2s",
        position: "relative",
      }}
    >
      {/* Selo "ATIVA" */}
      {isActive && (
        <span style={{
          position: "absolute",
          top: 12,
          right: 12,
          background: theme.quantum,
          color: "#fff",
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: 6,
          fontFamily: "IBM Plex Mono, monospace",
          letterSpacing: 1,
        }}>
          {t("settActiveBadge")}
        </span>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 24 }}>{source.icon}</span>
        <div>
          <div style={{
            fontFamily: "Space Grotesk, sans-serif",
            fontWeight: 600,
            fontSize: 16,
            color: theme.text,
          }}>
            {t(source.titleKey)}
          </div>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 12,
            color: theme.textMuted,
          }}>
            {t(source.descKey)}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 13,
        color: theme.textDim,
      }}>
        <span>
          <StatusDot online={online} degraded={degraded} />
          {online ? t("settOnline") : degraded ? t("settDegraded") : t("settOffline")}
        </span>

        {!isFallback && source.route && (
          <span style={{ color: theme.textMuted }}>
            {t("settRoute")}: {source.route}
          </span>
        )}

        {!isFallback && latency !== null && (
          <span style={{
            color: latency < 100 ? theme.success : latency < 500 ? theme.warning : theme.danger,
          }}>
            {latency}ms
          </span>
        )}

        {isFallback && (
          <span>{QRNG_PRECOLLECTED.length} {t("settBytesAvailable")}</span>
        )}
      </div>

      {/* Buffer info */}
      {!isFallback && health && (
        <div style={{
          marginTop: 12,
          display: "flex",
          gap: 16,
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 12,
          color: theme.textMuted,
        }}>
          <span>{t("buffer")}: {formatBytes(health.buffer_bytes_available)} / {formatBytes(health.buffer_capacity)}</span>
          <span>{t("generated")}: {formatBytes(health.total_pushed)}</span>
          <span>{t("consumed")}: {formatBytes(health.total_popped)}</span>
        </div>
      )}

      {/* Testar conexao */}
      {!isFallback && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={(e) => { e.stopPropagation(); handleTest(); }}
            disabled={testing}
            style={{
              background: "transparent",
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "4px 12px",
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 12,
              color: theme.textDim,
              cursor: testing ? "wait" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {testing ? t("settTesting") : t("settTestConnection")}
          </button>
          {testResult && (
            <span style={{
              marginLeft: 10,
              fontSize: 12,
              fontFamily: "IBM Plex Mono, monospace",
              color: testResult === "ok" ? theme.success : theme.danger,
            }}>
              {testResult === "ok" ? t("settConnected") : t("settFailed")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function SettingsSection() {
  const { t } = useLanguage();
  const {
    qrngSource, setQrngSource,
    remoteHealth, remoteLatency,
    fpgaHealth, fpgaLatency,
  } = useContext(AppContext);

  const getHealth = (key) => {
    if (key === "remote") return remoteHealth;
    if (key === "fpga") return fpgaHealth;
    return null;
  };

  const getLatency = (key) => {
    if (key === "remote") return remoteLatency;
    if (key === "fpga") return fpgaLatency;
    return null;
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{
          fontFamily: "Space Grotesk, sans-serif",
          fontWeight: 700,
          fontSize: 24,
          color: theme.text,
          margin: 0,
        }}>
          {t("settTitle")}
        </h2>
        <p style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 13,
          color: theme.textMuted,
          margin: "6px 0 0",
        }}>
          {t("settSubtitle")}
        </p>
      </div>

      {/* Fonte ativa label */}
      <div style={{
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 12,
        color: theme.textMuted,
        marginBottom: 12,
        textTransform: "uppercase",
        letterSpacing: 1,
      }}>
        {t("settActiveSource")}: <span style={{ color: theme.quantum, fontWeight: 600 }}>
          {t(SOURCE_KEY_MAP[qrngSource])}
        </span>
      </div>

      {/* Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {SOURCES.map((src) => (
          <SourceCard
            key={src.key}
            source={src}
            isActive={qrngSource === src.key}
            health={getHealth(src.key)}
            latency={getLatency(src.key)}
            onSelect={setQrngSource}
          />
        ))}
      </div>

      {/* Info box */}
      <div style={{
        marginTop: 24,
        padding: 16,
        background: theme.surfaceAlt,
        borderRadius: 8,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 12,
        color: theme.textMuted,
        lineHeight: 1.6,
      }}>
        <strong style={{ color: theme.textDim }}>{t("settHowItWorks")}</strong>
        <br />
        {t("settInfoPrefix")} <strong>{t("settRemoteWord")}</strong> {t("settInfoRemoteSuffix")}
        <br />
        {t("settInfoPrefix")} <strong>FPGA</strong> {t("settInfoFpgaSuffix")}
        <br />
        {t("settInfoFallbackPrefix")} <strong>Fallback</strong> {t("settInfoFallbackSuffix", { n: QRNG_PRECOLLECTED.length })}
        <br />
        {t("settInfoAutoFallback")}
      </div>
    </div>
  );
}
