#!/usr/bin/env node
/**
 * Start the local-only factory lane bridge on 127.0.0.1:8798 (t1742u / t1743u harden).
 *
 * Windows env for Grok Shell → localhost (never put the token in chat/prompts/logs):
 *   setx FACTORY_BRIDGE_TOKEN "<local secret>"   # or set for session
 *   set COS_FACTORY_PROTECT_DIR=C:\path\to\protect
 *   set OMB_DATA_DIR=C:\path\to\omb-data          # optional isolated store
 *   set FACTORY_BRIDGE_PORT=8798
 *   set FACTORY_BRIDGE_LOG=C:\path\to\bridge-access.log
 *
 * Then: node --experimental-strip-types scripts/factory-bridge.ts
 * Call with: curl -H "Authorization: Bearer %FACTORY_BRIDGE_TOKEN%" http://127.0.0.1:8798/factory/lanes
 */
import { listenFactoryBridge, FACTORY_BRIDGE_DEFAULT_PORT, FACTORY_BRIDGE_TOKEN_ENV } from "../server/factory-bridge-http.ts";

const port = Number(process.env.FACTORY_BRIDGE_PORT ?? FACTORY_BRIDGE_DEFAULT_PORT);
const accessLogPath = process.env.FACTORY_BRIDGE_LOG?.trim() || undefined;
const tokenConfigured = Boolean(process.env[FACTORY_BRIDGE_TOKEN_ENV]?.trim());

const { url } = await listenFactoryBridge({ port, accessLogPath });
process.stdout.write(`factory-bridge ready ${url}\n`);
process.stdout.write(`protectDir=${process.env.COS_FACTORY_PROTECT_DIR ?? "(unset — mutating ops fail closed)"}\n`);
process.stdout.write(`dataDir=${process.env.OMB_DATA_DIR ?? "(default ~/.openmausbot)"}\n`);
process.stdout.write(`auth=${tokenConfigured ? "configured" : "MISSING — non-health requests return 401"}\n`);