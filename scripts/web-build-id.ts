const WEB_BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$/u;

export function requireWebBuildId(value: string | undefined) {
  if (value == null || value !== value.trim() || !WEB_BUILD_ID_PATTERN.test(value)) {
    throw new Error(
      "KAIGEN_WEB_BUILD_ID must be an exact 12-80 character immutable candidate id using only ASCII letters, digits, '.', '_' or '-'",
    );
  }
  return value;
}
