import type {
  ProcessIdentity,
  ProcessIdentityProbe,
} from "./process-identity-service";
import { processIdentityProbe } from "./process-identity-service";

export interface ActiveProviderEntry {
  registrationId: string;
  ownerPid: number;
  identity: ProcessIdentity;
  onStopped(signal: NodeJS.Signals): void | Promise<void>;
}

export interface ActiveProviderRegistryOptions {
  currentPid?: number;
  validateIdentity?: ProcessIdentityProbe["validate"];
  signalProvider?: (pid: number, signal: NodeJS.Signals) => void;
}

export class ActiveProviderRegistry {
  private readonly entries = new Map<string, ActiveProviderEntry>();
  private readonly currentPid: number;
  private readonly validateIdentity: ProcessIdentityProbe["validate"];
  private readonly signalProvider: (pid: number, signal: NodeJS.Signals) => void;

  constructor(options: ActiveProviderRegistryOptions = {}) {
    this.currentPid = options.currentPid ?? process.pid;
    this.validateIdentity = options.validateIdentity
      ?? processIdentityProbe.validate.bind(processIdentityProbe);
    this.signalProvider = options.signalProvider
      ?? ((pid, signal) => process.kill(pid, signal));
  }

  get size(): number {
    return this.entries.size;
  }

  register(entry: ActiveProviderEntry): void {
    if (this.entries.has(entry.registrationId)) return;
    this.entries.set(entry.registrationId, entry);
  }

  unregister(registrationId: string): void {
    this.entries.delete(registrationId);
  }

  async handleSignal(signal: NodeJS.Signals): Promise<number> {
    let handled = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.ownerPid !== this.currentPid) continue;

      let identityMatches = false;
      try {
        identityMatches = (await this.validateIdentity(entry.identity)).ok;
      } catch {
        identityMatches = false;
      }
      if (!identityMatches) continue;

      handled += 1;
      this.unregister(entry.registrationId);
      try {
        this.signalProvider(entry.identity.pid, signal);
      } catch {}
      try {
        await entry.onStopped(signal);
      } catch {}
    }
    return handled;
  }
}

export const activeProviderRegistry = new ActiveProviderRegistry();

export function installActiveProviderSignalHandlers(
  registry: ActiveProviderRegistry = activeProviderRegistry,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => {
      void registry.handleSignal(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}
