#!/usr/bin/env node
/**
 * Start the local-only factory lane bridge on 127.0.0.1:8798 (t1742u).
 *
 * Env:
 *   OMB_DATA_DIR              — lane store directory (default ~/.openmausbot)
 *   COS_FACTORY_PROTECT_DIR   — protect SoT directory (recommended)
 *   FACTORY_BRIDGE_PORT       — default 8798
 *   FACTORY_BRIDGE_LOG        — optional access log path
 */
import { listenFactoryBridge, FACTORY_BRIDGE_DEFAULT_PORT } from "../server/factory-bridge-http.ts";

const port = Number(process.env.FACTORY_BRIDGE_PORT ?? FACTORY_BRIDGE_DEFAULT_PORT);
const accessLogPath = process.env.FACTORY_BRIDGE_LOG?.trim() || undefined;

const { url } = await listenFactoryBridge({ port, accessLogPath });
process.stdout.write(`factory-bridge ready ${url}\n`);
process.stdout.write(`protectDir=${process.env.COS_FACTORY_PROTECT_DIR ?? "(unset — ownership-only / QA rules)"}\n`);
process.stdout.write(`dataDir=${process.env.OMB_DATA_DIR ?? "(default ~/.openmausbot)"}\n`);