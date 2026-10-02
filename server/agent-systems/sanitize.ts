/**
 * Inter-agent handoff sanitization (t1765u Cap 1) — vendored for OMB.
 * Pure, offline, fail-closed. No network. Pin: see VERSION.
 */

const SECRET_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "auth_token",
  "private_key",
  "client_secret",
];

const CONTENT_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { name: "sk_like", re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { name: "ghp", re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: "xai", re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { name: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

function isSecretName(name: string): boolean {
  const lower = String(name).toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

function mask(value: unknown): string {
  const s = String(value);
  return `«redacted ${s.length} chars»`;
}

function redactText(text: string, stripped: string[]): string {
  let out = text;
  for (const { name, re } of CONTENT_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      stripped.push(`content:${name}`);
      out = out.replace(re, (m) => mask(m));
    }
  }
  return out;
}

export type SanitizeOk = { ok: true; sanitized: unknown; stripped: string[] };
export type SanitizeFail = { ok: false; reason: string; stripped: string[] };

/**
 * Sanitize an inter-agent handoff payload. Fail closed on circular / too-deep structures.
 */
export function sanitizeHandoff(
  payload: unknown,
  opts: { maxDepth?: number } = {},
): SanitizeOk | SanitizeFail {
  const maxDepth = opts.maxDepth ?? 12;
  const stripped: string[] = [];
  const seen = new WeakSet<object>();

  function walk(value: unknown, depth: number, path: string): unknown {
    if (typeof value === "string") return redactText(value, stripped);
    if (value === null || typeof value !== "object") return value;
    if (depth > maxDepth) {
      throw Object.assign(new Error("unsanitizable"), { code: "unsanitizable" });
    }
    if (seen.has(value)) {
      throw Object.assign(new Error("unsanitizable"), { code: "unsanitizable" });
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, depth + 1, `${path}[${i}]`));
    }

    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === "string" && isSecretName(key)) {
        stripped.push(`key:${path}.${key}`);
        out[key] = mask(raw);
        continue;
      }
      out[key] = walk(raw, depth + 1, path ? `${path}.${key}` : key);
    }
    return out;
  }

  try {
    const sanitized = walk(payload, 0, "");
    return { ok: true, sanitized, stripped };
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "unsanitizable") {
      return { ok: false, reason: "unsanitizable", stripped };
    }
    throw err;
  }
}

export function assertNoRawSecrets(serialized: string): { ok: true } | { ok: false; pattern: string } {
  const s = String(serialized);
  if (/\bsk-[A-Za-z0-9]{16,}\b/.test(s) && !s.includes("«redacted")) return { ok: false, pattern: "sk_like" };
  if (/\bghp_[A-Za-z0-9]{20,}\b/.test(s)) return { ok: false, pattern: "ghp" };
  if (/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}/i.test(s) && !/Bearer\s+«redacted/i.test(s)) {
    return { ok: false, pattern: "bearer" };
  }
  return { ok: true };
}

export const __test = { isSecretName, mask, CONTENT_PATTERNS };
