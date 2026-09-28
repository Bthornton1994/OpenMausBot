// The model catalog an operator hands a server through OMB_HOSTED_MODELS,
// shared by the portal workspace policy (hosted-models.ts) and the Cloud
// home machine (cloud-home.ts). Parsing is strict: an unknown provider key,
// a malformed id or an oversized value is refused, never trimmed to fit.
import { z } from "zod";

const nativeModels = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/)).max(100);
const catalogSchema = z.object({
  anthropic: nativeModels,
  openai: nativeModels,
  openrouter: z.array(z.string().max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)).max(100),
}).strict();
export type HostedCatalog = z.infer<typeof catalogSchema>;

/** Parse OMB_HOSTED_MODELS, dropping duplicate ids. Throws on anything else. */
export function parseHostedCatalog(raw: string | undefined): HostedCatalog {
  let catalog: HostedCatalog;
  try {
    if (!raw || raw.length > 65536) throw new Error();
    catalog = catalogSchema.parse(JSON.parse(raw));
  } catch { throw new Error("Invalid hosted model catalog."); }
  for (const key of ["anthropic", "openai", "openrouter"] as const) catalog[key] = [...new Set(catalog[key])];
  return catalog;
}

/** The gateway credential format the Admin mints for a workspace or machine. */
export const HOSTED_MODEL_TOKEN = /^omb_workspace_[A-Za-z0-9_-]{43}$/;
