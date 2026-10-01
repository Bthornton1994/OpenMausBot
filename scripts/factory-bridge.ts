#!/usr/bin/env node
/**
 * Start the local-only factory lane bridge on 127.0.0.1:8798 (t1742u / t1743u harden).
 *
 * Windows env for Grok Shell → localhost (never put the token in chat/prompts/logs/argv).
 * Set FACTORY_BRIDGE_TOKEN from a hidden prompt — see docs/SETUP_WINDOWS.md. Then:
 *   set COS_FACTORY_PROTECT_DIR=C:\path\to\protect  # or COS_FACTORY_ROOT=C:\path\to\root (uses <root>\protect)
 *   set OMB_DATA_DIR=C:\path\to\omb-data          # optional isolated store
 *   set FACTORY_BRIDGE_PORT=8798
 *   set FACTORY_BRIDGE_LOG=C:\path\to\bridge-access.log
 *
 * Then: node --experimental-strip-types scripts/factory-bridge.ts
 * Call from PowerShell; the header is built in-process, so the token is never a curl.exe argument:
 *   Invoke-RestMethod http://127.0.0.1:8798/factory/lanes -Headers @{ Authorization = "Bearer $env:FACTORY_BRIDGE_TOKEN" }
 */
import {
  formatDataDirStatus,
  formatProtectDirStatus,
  listenFactoryBridge,
  FACTORY_BRIDGE_DEFAULT_PORT,
  FACTORY_BRIDGE_TOKEN_ENV,
} from "../server/factory-bridge-http.ts";

const port = Number(process.env.FACTORY_BRIDGE_PORT ?? FACTORY_BRIDGE_DEFAULT_PORT);
const accessLogPath = process.env.FACTORY_BRIDGE_LOG?.trim() || undefined;
const tokenConfigured = Boolean(process.env[FACTORY_BRIDGE_TOKEN_ENV]?.trim());

const { url } = await listenFactoryBridge({ port, accessLogPath });
process.stdout.write(`factory-bridge ready ${url}\n`);
process.stdout.write(`protectDir=${formatProtectDirStatus(process.env)}\n`);
process.stdout.write(`dataDir=${formatDataDirStatus(process.env)}\n`);
process.stdout.write(`auth=${tokenConfigured ? "configured" : "MISSING — non-health requests return 401"}\n`);
