import { useContext } from "react";
import { theme } from "../../theme";
import { AppContext } from "../../contexts/AppContext";
import { useLanguage, SOURCE_KEY_MAP } from "../../contexts/LanguageContext";

export default function Footer() {
  // Item 5 da auditoria: isOnline é um flag de "seguro habilitar UI", TAMBÉM
  // true para a fonte pré-coletada -- não pode decidir a alegação "conectado
  // ao hardware / dados em tempo real" abaixo. isLiveData só é true quando
  // uma checagem de rede real confirmou sucesso.
  const { isLiveData, qrngSource } = useContext(AppContext);
  const { t } = useLanguage();
  const sourceLabel = t(SOURCE_KEY_MAP[qrngSource]) || qrngSource;

  return (
    <>
      <div
        style={{
          padding: "16px 20px",
          borderRadius: 12,
          background: theme.surface,
          border: `1px solid ${isLiveData ? theme.success : theme.border}`,
          fontSize: 11,
          lineHeight: 1.8,
          color: theme.textMuted,
          fontFamily: "'IBM Plex Mono', monospace",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {isLiveData ? (
          <>
            <strong style={{ color: theme.success }}>{t("footerConnectedTitle")}</strong>{" "}
            {t("footerConnectedPrefix")}{" "}
            <strong style={{ color: theme.quantum }}>{sourceLabel}</strong>
            {t("footerConnectedSuffix")}
          </>
        ) : (
          <>
            <strong style={{ color: theme.warning }}>{t("footerOfflineTitle")}</strong>{" "}
            {t("footerOfflinePrefix")}{" "}
            <strong style={{ color: theme.quantum }}>{t("footerSamplePrecollected")}</strong>{" "}
            {t("footerOfflineSuffix")}
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          marginTop: 24,
          paddingBottom: 20,
        }}
      >
        <img src="/LOGOMARCA_DOBSLIT.PNG" alt="DOBSLIT" style={{ height: 22, opacity: 0.5 }} />
        <span
          style={{
            fontSize: 10,
            color: theme.textMuted,
            fontFamily: "'IBM Plex Mono', monospace",
            letterSpacing: "0.06em",
          }}
        >
          {t("footerDevelopedBy")}
        </span>
      </div>
    </>
  );
}
