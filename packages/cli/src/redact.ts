const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9-]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /api[_-]?key[=:]\s*["']?[a-zA-Z0-9_-]{20,}["']?/gi,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /(?:^|[^a-zA-Z])[a-zA-Z_]*(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_CREDENTIAL|API_KEY|SECRET_KEY)[a-zA-Z_]*[=:]\s*["']?[^\s"']{8,}["']?/gi,
  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY-----/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
];

export function redactSecrets(content: string): string {
  let result =
    typeof content === "string"
      ? content
      : content === null || content === undefined
        ? ""
        : typeof content === "object"
          ? JSON.stringify(content)
          : String(content);
  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED_API_KEY]");
  }
  return result;
}

export function containsSecrets(content: string): boolean {
  const normalized =
    typeof content === "string"
      ? content
      : content === null || content === undefined
        ? ""
        : typeof content === "object"
          ? JSON.stringify(content)
          : String(content);
  return API_KEY_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(normalized);
  });
}

export function maskToken(token: string | undefined): string {
  if (!token) return "(not set)";
  if (token.length <= 8) return "*****";
  return `${token.slice(0, 3)}...${token.slice(-3)}`;
}
