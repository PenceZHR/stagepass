/**
 * Proves the gateway transport is wired into the real bridge composition --
 * not merely type-correct.
 *
 * `probe()` is the narrowest call that exercises the whole new path: the flag
 * is read, the composition picks a transport, the adapter connects, a real
 * `codex app-server` starts and initializes, and the bridge's capability gate
 * accepts what comes back. If any link is wrong this fails; if it passes, the
 * only thing left unproven is what a full stage adds on top.
 *
 *   STAGEPASS_CODEX_TURN_TRANSPORT=gateway npx tsx scripts/verify-gateway-transport-wiring.ts
 */
import { readCodexNativeFlags } from "../server/config/codex-native-flags.ts";
import { getProductionCodexDesktopBridge } from "../server/services/codex-desktop-engine.ts";

async function main() {
  const flags = readCodexNativeFlags();
  console.log(`turnTransport = ${flags.turnTransport}`);

  const started = Date.now();
  const bridge = await getProductionCodexDesktopBridge();
  console.log(`bridge composed in ${Date.now() - started}ms`);

  let probe;
  try {
    probe = await bridge.probe();
  } catch (error) {
    // Reported rather than rethrown: the same failure on both transports means
    // it is not the transport, and that distinction is the whole point of
    // being able to run this on either path.
    console.error(`probe failed on the ${flags.turnTransport} path:`);
    console.error(String(error).slice(0, 600));
    process.exit(1);
  }
  console.log(JSON.stringify(probe, null, 2));

  if (flags.turnTransport !== "gateway") {
    console.log("\n(desktop path -- run with STAGEPASS_CODEX_TURN_TRANSPORT=gateway to check the gateway)");
    process.exit(0);
  }

  // The fingerprint is the tell: the desktop path reports a Codex Desktop
  // bundle, this path must report the gateway. Anything else means the flag
  // did not actually change which transport got composed.
  const viaGateway = probe.desktopFollowerProtocolFingerprint
    === "app-server-gateway-v1";
  console.log(`\nVERDICT: ${viaGateway ? "WIRED THROUGH GATEWAY" : "NOT the gateway transport"}`);
  process.exit(viaGateway ? 0 : 1);
}

void main().catch((error) => {
  console.error("wiring check failed:", error);
  process.exit(1);
});
