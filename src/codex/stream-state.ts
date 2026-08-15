import { asRecord, type AppServerNotification } from "./app-server-protocol";

const DEFAULT_REPLAY_LIMIT = 512;

export type StreamNotification = AppServerNotification;
export type StreamItemStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type StreamTurnStatus = StreamItemStatus;

export interface StreamItem {
  readonly id: string;
  readonly turnId: string;
  readonly kind: string;
  readonly status: StreamItemStatus;
  readonly title: string;
  readonly text: string;
  readonly output: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type InteractionKind =
  | "commandApproval"
  | "fileChangeApproval"
  | "permissionsApproval"
  | "mcpElicitation"
  | "toolUserInput";

export interface StreamInteraction {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly method: string;
  readonly status: "pending" | "resolved";
  readonly params: Readonly<Record<string, unknown>>;
}

export interface StreamSnapshot {
  readonly threadId: string;
  readonly activeTurnId: string | null;
  readonly lastTurnId: string | null;
  readonly turnStatus: StreamTurnStatus | null;
  readonly items: readonly StreamItem[];
  readonly interactions: readonly StreamInteraction[];
  readonly lastSeq: number;
}

export type StreamEventKind =
  | "turn.started"
  | "turn.completed"
  | "item.started"
  | "item.delta"
  | "item.completed"
  | "interaction.requested"
  | "interaction.resolved"
  | "error"
  | "notification.unknown";

export interface StreamEvent {
  readonly seq: number;
  readonly kind: StreamEventKind;
  readonly threadId: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly interactionId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface OpenInteraction {
  readonly kind: InteractionKind;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface StreamStateOptions {
  readonly replayLimit?: number;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizedStatus(value: unknown): StreamItemStatus {
  switch (value) {
    case "completed":
    case "failed":
    case "interrupted":
      return value;
    default:
      return "inProgress";
  }
}

function itemFromWire(raw: unknown, turnId: string, previous?: StreamItem): StreamItem | null {
  const item = asRecord(raw);
  const id = stringField(item, "id");
  if (id === null) return null;
  const kind = stringField(item, "type") ?? previous?.kind ?? "unknown";
  const title = typeof item.command === "string"
    ? item.command
    : typeof item.name === "string"
      ? item.name
      : previous?.title ?? "";
  return {
    id,
    turnId,
    kind,
    status: normalizedStatus(item.status ?? previous?.status),
    title,
    text: typeof item.text === "string" ? item.text : previous?.text ?? "",
    output: typeof item.output === "string" ? item.output : previous?.output ?? "",
    data: item,
  };
}

function completionKey(method: string, params: Readonly<Record<string, unknown>>): string {
  return `${method}:${JSON.stringify(params)}`;
}

/** Materialized, replayable projection of one Codex App Server thread. */
export class StreamState {
  private readonly items = new Map<string, StreamItem>();
  private readonly interactions = new Map<string, StreamInteraction>();
  private readonly turns = new Map<string, StreamTurnStatus>();
  private readonly replayLimit: number;
  private readonly replay: StreamEvent[] = [];
  private readonly completionKeys = new Set<string>();
  private readonly listeners = new Set<(event: StreamEvent) => void>();
  private nextSeq = 1;
  private nextInteraction = 1;
  private activeTurnId: string | null = null;
  private lastTurnId: string | null = null;

  constructor(
    readonly threadId: string,
    options: StreamStateOptions = {},
  ) {
    this.replayLimit = Math.max(1, Math.floor(options.replayLimit ?? DEFAULT_REPLAY_LIMIT));
  }

  accept(message: StreamNotification): boolean {
    const params = message.params;
    if (stringField(params, "threadId") !== this.threadId) return false;

    if (message.method === "turn/started") return this.acceptTurnStarted(params);
    if (message.method === "turn/completed") return this.acceptTurnCompleted(message);
    if (message.method === "item/started") return this.acceptItem(params, false);
    if (message.method === "item/completed") return this.acceptItem(params, true, message);
    if (message.method.endsWith("/delta") || message.method.endsWith("Delta")) {
      return this.acceptDelta(params);
    }
    if (message.method === "error") {
      this.emit("error", params);
      return true;
    }
    this.emit("notification.unknown", params);
    return true;
  }

  snapshot(): StreamSnapshot {
    return {
      threadId: this.threadId,
      activeTurnId: this.activeTurnId,
      lastTurnId: this.lastTurnId,
      turnStatus: this.lastTurnId === null ? null : this.turns.get(this.lastTurnId) ?? null,
      items: [...this.items.values()].map((item) => ({ ...item })),
      interactions: [...this.interactions.values()].map((interaction) => ({ ...interaction })),
      lastSeq: this.nextSeq - 1,
    };
  }

  eventsAfter(seq: number): readonly StreamEvent[] | null {
    const oldest = this.replay[0]?.seq ?? this.nextSeq;
    if (seq < oldest - 1) return null;
    return this.replay.filter((event) => event.seq > seq);
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  statusOf(turnId: string): StreamTurnStatus | null {
    return this.turns.get(turnId) ?? null;
  }

  itemsForTurn(turnId: string): readonly StreamItem[] {
    return [...this.items.values()].filter((item) => item.turnId === turnId);
  }

  openInteraction(input: OpenInteraction): StreamInteraction {
    const interaction: StreamInteraction = {
      id: `interaction-${this.nextInteraction++}`,
      kind: input.kind,
      method: input.method,
      status: "pending",
      params: input.params,
    };
    this.interactions.set(interaction.id, interaction);
    this.emit("interaction.requested", input.params, {
      interactionId: interaction.id,
    });
    return interaction;
  }

  resolveInteraction(id: string): boolean {
    const current = this.interactions.get(id);
    if (current === undefined || current.status === "resolved") return false;
    this.interactions.set(id, { ...current, status: "resolved" });
    this.emit("interaction.resolved", {}, { interactionId: id });
    return true;
  }

  noteTurnStarted(turn: Readonly<Record<string, unknown>>): void {
    this.acceptTurnStarted({ threadId: this.threadId, turn });
  }

  hydrate(turns: readonly unknown[]): void {
    for (const rawTurn of turns) {
      const turn = asRecord(rawTurn);
      const turnId = stringField(turn, "id");
      if (turnId === null) continue;
      const status = normalizedStatus(turn.status);
      this.turns.set(turnId, status);
      this.lastTurnId = turnId;
      if (status === "inProgress") this.activeTurnId = turnId;
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const rawItem of items) {
        const materialized = itemFromWire(rawItem, turnId);
        if (materialized !== null) this.items.set(materialized.id, materialized);
      }
    }
  }

  private acceptTurnStarted(params: Readonly<Record<string, unknown>>): boolean {
    const turn = asRecord(params.turn);
    const turnId = stringField(turn, "id");
    if (turnId === null) return false;
    const existing = this.turns.get(turnId);
    if (existing === "completed" || existing === "failed" || existing === "interrupted") {
      return false;
    }
    if (this.activeTurnId === turnId && this.turns.get(turnId) === "inProgress") {
      return false;
    }
    this.turns.set(turnId, "inProgress");
    this.activeTurnId = turnId;
    this.lastTurnId = turnId;
    this.emit("turn.started", turn, { turnId });
    return true;
  }

  private acceptTurnCompleted(message: StreamNotification): boolean {
    const key = completionKey(message.method, message.params);
    if (this.completionKeys.has(key)) return false;
    const turn = asRecord(message.params.turn);
    const turnId = stringField(turn, "id");
    if (turnId === null) return false;
    this.completionKeys.add(key);
    const status = normalizedStatus(turn.status);
    this.turns.set(turnId, status === "inProgress" ? "completed" : status);
    this.lastTurnId = turnId;
    if (this.activeTurnId === turnId) this.activeTurnId = null;
    const finalItems = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of finalItems) {
      const wire = asRecord(rawItem);
      const itemId = stringField(wire, "id");
      const materialized = itemFromWire(
        { ...wire, status: wire.status ?? "completed" },
        turnId,
        itemId === null ? undefined : this.items.get(itemId),
      );
      if (materialized !== null) this.items.set(materialized.id, materialized);
    }
    this.emit("turn.completed", turn, { turnId });
    return true;
  }

  private acceptItem(
    params: Readonly<Record<string, unknown>>,
    completed: boolean,
    message?: StreamNotification,
  ): boolean {
    if (message !== undefined) {
      const key = completionKey(message.method, message.params);
      if (this.completionKeys.has(key)) return false;
      this.completionKeys.add(key);
    }
    const turnId = stringField(params, "turnId");
    const wire = asRecord(params.item);
    const itemId = stringField(wire, "id");
    if (turnId === null || itemId === null) return false;
    const materialized = itemFromWire(
      completed ? { ...wire, status: wire.status ?? "completed" } : wire,
      turnId,
      this.items.get(itemId),
    );
    if (materialized === null) return false;
    this.items.set(itemId, materialized);
    this.emit(completed ? "item.completed" : "item.started", wire, {
      turnId,
      itemId,
    });
    return true;
  }

  private acceptDelta(params: Readonly<Record<string, unknown>>): boolean {
    const turnId = stringField(params, "turnId");
    const itemId = stringField(params, "itemId");
    const delta = typeof params.delta === "string" ? params.delta : null;
    if (turnId === null || itemId === null || delta === null) return false;
    const previous = this.items.get(itemId) ?? {
      id: itemId,
      turnId,
      kind: "unknown",
      status: "inProgress" as const,
      title: "",
      text: "",
      output: "",
      data: {},
    };
    if (previous.status !== "inProgress") return false;
    const isOutput = previous.kind === "commandExecution" || previous.kind === "fileChange";
    this.items.set(itemId, {
      ...previous,
      text: isOutput ? previous.text : `${previous.text}${delta}`,
      output: isOutput ? `${previous.output}${delta}` : previous.output,
    });
    this.emit("item.delta", { delta }, { turnId, itemId });
    return true;
  }

  private emit(
    kind: StreamEventKind,
    payload: Readonly<Record<string, unknown>>,
    identity: Pick<StreamEvent, "turnId" | "itemId" | "interactionId"> = {},
  ): void {
    const event: StreamEvent = {
      seq: this.nextSeq++,
      kind,
      threadId: this.threadId,
      ...identity,
      payload,
    };
    this.replay.push(event);
    if (this.replay.length > this.replayLimit) this.replay.shift();
    for (const listener of this.listeners) listener(event);
  }
}
