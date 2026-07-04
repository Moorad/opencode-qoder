import crypto from "node:crypto";
import { getMachineId } from "./cosy.js";
import { QODER_EXCHANGE_URL, QODER_PAT_ENV, QODER_REFRESH_URL, QODER_USERINFO_URL, USER_AGENT } from "./constants.js";

export interface QoderCredentials {
  access: string;
  refresh: string;
  expires: number;
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

export interface QoderProviderOptions {
  apiKey?: string;
  personalAccessToken?: string;
  qoderUserID?: string;
  qoderEmail?: string;
  qoderName?: string;
  qoderMachineID?: string;
}

export const PAT_REFRESH_PREFIX = "pat";

const credentialsCache = new Map<string, Promise<QoderCredentials> | QoderCredentials>();

export function encodePatRefresh(pat: string, jobRefreshToken: string, userID: string, machineID: string): string {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

export function encodeOAuthRefresh(refreshToken: string, userID: string, machineID: string): string {
  return [refreshToken, userID, machineID].join("|");
}

export function decodeOAuthRefresh(refresh: string): { refreshToken: string; userID: string; machineID: string } {
  const parts = refresh.split("|");
  return {
    refreshToken: parts[0] || "",
    userID: parts[1] || "",
    machineID: parts[2] || "",
  };
}

function getEnvPat(): string {
  for (const key of QODER_PAT_ENV) {
    const value = process.env[key];
    if (value) return value;
  }
  return "";
}

function parseExpiresAt(expiresAt?: string, expiresIn?: number): number {
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number.parseInt(expiresAt, 10);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  if (expiresIn && expiresIn > 0) {
    // PAT exchange returns milliseconds; browser device flow returns seconds.
    return Date.now() + (expiresIn > 7 * 24 * 60 * 60 ? expiresIn : expiresIn * 1000);
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

async function fetchUserInfo(jobToken: string): Promise<{ userID: string; email: string; name: string }> {
  try {
    const res = await fetch(QODER_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
    });
    if (!res.ok) return { userID: "", email: "", name: "" };
    const info = (await res.json()) as { id?: string; email?: string; name?: string; username?: string };
    return {
      userID: info.id || "",
      email: info.email || "",
      name: info.name || info.username || "",
    };
  } catch {
    return { userID: "", email: "", name: "" };
  }
}

export async function credentialsFromPat(pat: string): Promise<QoderCredentials> {
  const cached = credentialsCache.get(pat);
  if (cached) {
    const resolved = await cached;
    if (resolved.expires > Date.now()) return resolved;
    credentialsCache.delete(pat);
  }

  const pending = (async () => {
    const res = await fetch(QODER_EXCHANGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
      body: JSON.stringify({ personal_token: pat }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Qoder PAT exchange failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      token?: string;
      refresh_token?: string;
      expires_at?: string;
      expires_in?: number;
    };
    if (!data.token) throw new Error("Qoder PAT exchange returned no job token");

    const profile = await fetchUserInfo(data.token);
    const machineID = getMachineId();
    return {
      refresh: encodePatRefresh(pat, data.refresh_token || "", profile.userID, machineID),
      access: data.token,
      expires: parseExpiresAt(data.expires_at, data.expires_in) - 5 * 60 * 1000,
      userID: profile.userID || "qoder-user",
      email: profile.email || "user@qoder.com",
      name: profile.name || "Qoder User",
      machineID,
    } satisfies QoderCredentials;
  })();

  credentialsCache.set(pat, pending);
  try {
    const resolved = await pending;
    credentialsCache.set(pat, resolved);
    return resolved;
  } catch (error) {
    credentialsCache.delete(pat);
    throw error;
  }
}

export async function refreshOAuthCredential(credential: QoderCredentials): Promise<QoderCredentials> {
  const { refreshToken, userID, machineID } = decodeOAuthRefresh(credential.refresh);
  if (!refreshToken) return credential;

  const response = await fetch(QODER_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.access}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) return credential;
  const data = (await response.json()) as { token?: string; refresh_token?: string; expires_at?: string; expires_in?: number };
  if (!data.token) return credential;

  return {
    ...credential,
    access: data.token,
    refresh: encodeOAuthRefresh(data.refresh_token || refreshToken, userID || credential.userID, machineID || credential.machineID),
    expires: parseExpiresAt(data.expires_at, data.expires_in) - 5 * 60 * 1000,
    userID: userID || credential.userID,
    machineID: machineID || credential.machineID,
  };
}

export async function resolveQoderCredentials(options: QoderProviderOptions = {}): Promise<QoderCredentials> {
  const token = options.personalAccessToken || options.apiKey || getEnvPat();
  if (!token) {
    throw new Error("Qoder credentials not set. Run `/connect qoder` in opencode or set QODER_PERSONAL_ACCESS_TOKEN.");
  }

  if (token.startsWith("pt-")) return credentialsFromPat(token);

  return {
    access: token,
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    userID: options.qoderUserID || "qoder-user",
    email: options.qoderEmail || "user@qoder.com",
    name: options.qoderName || "Qoder User",
    machineID: options.qoderMachineID || getMachineId(),
  };
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
