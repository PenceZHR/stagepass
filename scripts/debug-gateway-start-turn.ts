/**
 * Starts a turn through the gateway on a thread this process did not create.
 *
 * Suspicion under test: shell control provisions the persistent thread from its
 * own `codex app-server` process, and the gateway is a second, separate one. A
 * turn started on a thread the process has never loaded may need an explicit
 * `thread/resume` first -- a step the Desktop follower never needed, because
 * Codex Desktop owns every thread it is asked about.
 */
import { CodexSessionGateway } from "../server/services/codex-session-gateway.ts";

const CODEX = process.env.STAGEPASS_CODEX_BIN
  ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const REPO = "/Users/zhanghr/Desktop/stagepass";
const threadId = process.argv[2];

if (!threadId) {
  console.error("usage: debug-gateway-start-turn.ts <threadId>");
  process.exit(2);
}

async function attempt(label: string, resumeFirst: boolean) {
  const gateway = new CodexSessionGateway({ bin: CODEX, cwd: REPO });
  console.log(`\n--- ${label} ---`);
  try {
    await gateway.connect();
    if (resumeFirst) {
      const resumed = await gateway.resumeThread(threadId!);
      console.log("thread/resume ok:", JSON.stringify(resumed).slice(0, 200));
    }
    const { turnId } = await gateway.startTurn({
      threadId: threadId!,
      prompt: "Reply with exactly: GATEWAY TURN OK",
      cwd: REPO,
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
    console.log(`RESULT: started, turnId=${turnId}`);
  } catch (error) {
    console.log("RESULT: threw");
    console.log("  name :", (error as Error)?.name);
    console.log("  code :", (error as { code?: string })?.code);
    console.log("  msg  :", String((error as Error)?.message).slice(0, 500));
  } finally {
    await gateway.close();
  }
}

async function main() {
  await attempt("without thread/resume", false);
  await attempt("with thread/resume first", true);
  process.exit(0);
}

void main();
