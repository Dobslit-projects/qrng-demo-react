// Classificação das respostas de identidade do portal (doc 155, §2.4/§2.5).
//
// A client-api responde {error: "<CÓDIGO>", message}; o Bongo responde
// {error: "<texto>", code: "<CÓDIGO>"} — por isso o código vem de `code` e,
// na falta dele, de `error`.

export function errorCode(res) {
  const d = (res && res.data) || {};
  return d.code || d.error || null;
}

// Estado da tela de entrada a partir de uma falha de /identity/status (ou de
// /auth/me em modo portal).
export function identityFailureState(res) {
  const code = errorCode(res);
  if (code === "IDENTITY_UNAVAILABLE" || res.status >= 500) return "unavailable";
  if (code === "DEVELOPER_ACCOUNT_NOT_PROVISIONED") return "not_provisioned";
  if (res.status === 401) return "session_invalid";
  if (res.status === 403) return "denied";
  return "error";
}

// Chave de i18n para uma falha de provisionamento, vínculo ou reautenticação.
export function identityErrorKey(res) {
  const code = errorCode(res);
  switch (code) {
    case "IDENTITY_UNAVAILABLE":       return "devIdUnavailable";
    case "PORTAL_SESSION_INVALID":     return "devIdSessionInvalid";
    case "QRNG_ACCESS_DENIED":         return "devIdAccessDenied";
    case "PORTAL_ALREADY_LINKED":      return "devIdPortalAlreadyLinked";
    case "ACCOUNT_ALREADY_LINKED":     return "devIdAccountAlreadyLinked";
    case "INVALID_LEGACY_CREDENTIALS": return "devIdInvalidLegacyCredentials";
    case "REAUTH_REQUIRED":            return "devIdReauthRequired";
    case "CURRENT_PASSWORD_INVALID":   return "devIdPortalPasswordInvalid";
    case "MISSING_FIELDS":             return "devIdMissingFields";
    default: break;
  }
  if (res.status >= 500) return "devIdUnavailable";
  if (res.status === 429) return "devIdTooManyAttempts";
  if (res.status === 401) return "devIdSessionInvalid";
  return "devIdUnknownError";
}
