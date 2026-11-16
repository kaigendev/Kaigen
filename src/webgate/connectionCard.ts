export type WebgateConnectionCard = {
  format: "kaigen-webgate";
  version: 1;
  endpoint: string;
  profileName: string;
  profileId?: string;
  certificateSha256?: string;
  identity?: { serverId: string; workspaceId: string; profileId: string };
  password?: string;
};

export type WebgateConnectionInput = {
  endpoint: string;
  profileName: string;
  password: string;
  profileId?: string;
  certificateSha256?: string;
  identity?: WebgateConnectionCard["identity"];
};

export const emptyWebgateConnection = (): WebgateConnectionInput => ({ endpoint: "", profileName: "", password: "" });

export function isOnionEndpoint(value: string): boolean {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return host.endsWith(".onion");
  } catch { return false; }
}

export function validateWebgateEndpoint(value: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > 8192 || /[\u0000-\u0020\u007f]/u.test(text)) {
    throw new Error("WEBGATE_ENDPOINT_INVALID");
  }
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("WEBGATE_ENDPOINT_INVALID"); }
  if (url.username || url.password || !url.hostname || url.search) throw new Error("WEBGATE_ENDPOINT_INVALID");
  const onion = url.hostname.toLowerCase().endsWith(".onion");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && onion)) {
    throw new Error("WEBGATE_HTTPS_REQUIRED");
  }
  // Existing workspace links use #k=; the native transport derives the API
  // path. Arbitrary fragments are never sent to a server or logged.
  if (url.hash && !/^#k=[A-Za-z0-9_-]+$/u.test(url.hash)) throw new Error("WEBGATE_ENDPOINT_INVALID");
  if (/%(?:2f|5c|00)/iu.test(url.pathname) || url.pathname.includes("\\")) throw new Error("WEBGATE_ENDPOINT_INVALID");
  return url.href;
}

export function makeWebgateCard(input: WebgateConnectionInput): WebgateConnectionCard {
  const endpoint = validateWebgateEndpoint(input.endpoint);
  const profileName = input.profileName.trim();
  if (!profileName || profileName.length > 256 || /[\u0000-\u001f\u007f]/u.test(profileName)) {
    throw new Error("WEBGATE_ACCOUNT_INVALID");
  }
  const result: WebgateConnectionCard = { format: "kaigen-webgate", version: 1, endpoint, profileName };
  if (input.certificateSha256) {
    const digest = input.certificateSha256.replace(/:/gu, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("WEBGATE_CERTIFICATE_INVALID");
    result.certificateSha256 = digest;
  }
  if (input.identity) result.identity = input.identity;
  if (input.profileId !== undefined) {
    if (!input.profileId || input.profileId.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.profileId)) throw new Error("WEBGATE_CARD_INVALID");
    result.profileId = input.profileId;
  }
  return result;
}

export function parseWebgateCard(text: string): WebgateConnectionInput {
  if (text.length > 32768) throw new Error("WEBGATE_CARD_INVALID");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("WEBGATE_CARD_INVALID"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("WEBGATE_CARD_INVALID");
  const value = data as Record<string, unknown>;
  const allowed = new Set(["format", "version", "endpoint", "profileName", "profileId", "certificateSha256", "identity", "password"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.format !== "kaigen-webgate" || value.version !== 1
    || typeof value.endpoint !== "string" || typeof value.profileName !== "string"
    || (value.profileId !== undefined && typeof value.profileId !== "string")
    || (value.password !== undefined && (typeof value.password !== "string" || value.password.length > 4096))
    || (value.certificateSha256 !== undefined && typeof value.certificateSha256 !== "string")) {
    throw new Error("WEBGATE_CARD_INVALID");
  }
  let identity: WebgateConnectionCard["identity"];
  if (value.identity !== undefined) {
    if (!value.identity || typeof value.identity !== "object" || Array.isArray(value.identity)) throw new Error("WEBGATE_CARD_INVALID");
    const fields = value.identity as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !["serverId", "workspaceId", "profileId"].includes(key))
      || [fields.serverId, fields.workspaceId, fields.profileId].some((field) => typeof field !== "string" || !field || field.length > 512)) {
      throw new Error("WEBGATE_CARD_INVALID");
    }
    identity = { serverId: fields.serverId as string, workspaceId: fields.workspaceId as string, profileId: fields.profileId as string };
  }
  const card = makeWebgateCard({ endpoint: value.endpoint, profileName: value.profileName, password: "",
    profileId: value.profileId as string | undefined, certificateSha256: value.certificateSha256 as string | undefined, identity });
  return { ...card, password: typeof value.password === "string" ? value.password : "" };
}

export function serializeWebgateCard(card: WebgateConnectionCard, explicitPassword?: string): string {
  const validated = makeWebgateCard({ ...card, password: "" });
  return JSON.stringify(explicitPassword === undefined ? validated : { ...validated, password: explicitPassword }, null, 2);
}
