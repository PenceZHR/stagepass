import {
  App,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  PublicInteractionEnvelope,
} from "../../server/services/mcp-presentation-auth-service";

export type InteractionFormValues = Record<string, unknown>;

export interface InteractionCardPrivateState {
  envelope: PublicInteractionEnvelope;
  invocationNonce: string;
}

export interface InteractionCardToolClient {
  callServerTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<CallToolResult>;
}

function present(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

export function firstInvalidField(
  envelope: PublicInteractionEnvelope,
  values: InteractionFormValues,
): string | null {
  return envelope.form.fields.find(
    (field) => field.required && !present(values[field.id]),
  )?.id ?? null;
}

function payloadList(
  envelope: PublicInteractionEnvelope,
  key: "blockers" | "warnings" | "evidenceReferences",
): unknown[] {
  const value = envelope.payload[key];
  return Array.isArray(value) ? value : [];
}

export function hasP0Blocker(envelope: PublicInteractionEnvelope): boolean {
  return payloadList(envelope, "blockers").some((blocker) => (
    blocker
    && typeof blocker === "object"
    && "severity" in blocker
    && blocker.severity === "P0"
  ));
}

export function requiresConfirmation(actionId: string): boolean {
  return /(reject|waive|override|adopt)/i.test(actionId);
}

export function canSubmit(
  envelope: PublicInteractionEnvelope,
  values: InteractionFormValues,
  actionId = envelope.actionIds[0] ?? "",
): boolean {
  if (
    envelope.status !== "presented"
    || !actionId
    || !envelope.actionIds.includes(actionId)
    || hasP0Blocker(envelope)
    || firstInvalidField(envelope, values)
  ) return false;
  return !requiresConfirmation(actionId) || values.__confirmation === true;
}

function structured<T>(result: CallToolResult): T {
  if (result.isError || !result.structuredContent) {
    throw new Error("stagepass_private_tool_failed");
  }
  return result.structuredContent as T;
}

export async function submitCard(
  client: InteractionCardToolClient,
  state: InteractionCardPrivateState,
  input: {
    actionId: string;
    formValues: InteractionFormValues;
  },
): Promise<{ commandId: string; continuation: Record<string, unknown> }> {
  const current = structured<{ status: string }>(
    await client.callServerTool({
      name: "get_stagepass_interaction_status",
      arguments: { interactionId: state.envelope.id },
    }),
  );
  if (current.status !== "presented") {
    throw new Error(
      current.status === "expired"
        ? "interaction_expired"
        : "interaction_not_presented",
    );
  }
  if (!canSubmit(state.envelope, input.formValues, input.actionId)) {
    throw new Error("interaction_form_invalid");
  }
  const submitted = structured<{ commandId: string; status: string }>(
    await client.callServerTool({
      name: "submit_stagepass_interaction",
      arguments: {
        interactionId: state.envelope.id,
        actionId: input.actionId,
        expectedGateVersion: state.envelope.gateVersion,
        expectedSourceDbHash: state.envelope.sourceDbHash,
        expectedHeadSha: state.envelope.expectedHeadSha,
        idempotencyKey:
          `mcp-interaction:${state.envelope.id}:${input.actionId}`,
        invocationNonce: state.invocationNonce,
        formValues: input.formValues,
      },
    }),
  );
  if (submitted.status !== "completed" || !submitted.commandId) {
    throw new Error("interaction_submit_not_completed");
  }
  let continuation: Record<string, unknown>;
  try {
    continuation = structured<Record<string, unknown>>(
      await client.callServerTool({
        name: "continue_stagepass_interaction",
        arguments: {
          interactionId: state.envelope.id,
          commandId: submitted.commandId,
        },
      }),
    );
  } catch {
    throw new Error("continuation_failed_after_decision");
  }
  return { commandId: submitted.commandId, continuation };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value
    && typeof value === "object"
    && "title" in value
    && typeof value.title === "string"
  ) return value.title;
  return JSON.stringify(value);
}

function renderList(
  root: HTMLElement,
  label: string,
  items: unknown[],
  className: string,
): void {
  if (items.length === 0) return;
  const section = document.createElement("section");
  section.className = className;
  const title = document.createElement("h3");
  title.textContent = label;
  section.append(title);
  const list = document.createElement("ul");
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = text(item);
    list.append(row);
  }
  section.append(list);
  root.append(section);
}

function inputFor(
  field: PublicInteractionEnvelope["form"]["fields"][number],
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (field.type === "textarea") {
    input = document.createElement("textarea");
  } else if (field.type === "select") {
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "请选择";
    select.append(blank);
    for (const option of field.options ?? []) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.append(element);
    }
    input = select;
  } else {
    const element = document.createElement("input");
    element.type = field.type === "checkbox" || field.type === "confirmation"
      ? "checkbox"
      : "text";
    input = element;
  }
  input.id = `stagepass-field-${field.id}`;
  input.name = field.id;
  input.required = field.required;
  return input;
}

export function renderInteractionCard(
  root: HTMLElement,
  state: InteractionCardPrivateState,
  client: InteractionCardToolClient,
): void {
  const envelope = state.envelope;
  root.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = envelope.title;
  const phase = document.createElement("p");
  phase.className = "stagepass-phase";
  phase.textContent = `${envelope.phase} · ${envelope.kind}`;
  const summary = document.createElement("p");
  summary.textContent = envelope.summary;
  root.append(heading, phase, summary);
  renderList(root, "阻断项", payloadList(envelope, "blockers"), "blockers");
  renderList(root, "警告", payloadList(envelope, "warnings"), "warnings");
  renderList(
    root,
    "证据",
    payloadList(envelope, "evidenceReferences"),
    "evidence",
  );

  const form = document.createElement("form");
  const values: InteractionFormValues = {};
  for (const field of envelope.form.fields) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `stagepass-field-${field.id}`;
    label.textContent = `${field.label}${field.required ? " *" : ""}`;
    const input = inputFor(field);
    input.addEventListener("input", () => {
      values[field.id] = input instanceof HTMLInputElement
        && input.type === "checkbox"
        ? input.checked
        : input.value;
    });
    wrapper.append(label, input);
    if (field.description) {
      const description = document.createElement("small");
      description.textContent = field.description;
      wrapper.append(description);
    }
    form.append(wrapper);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("aria-live", "polite");
  for (const actionId of envelope.actionIds) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = actionId;
    button.disabled = hasP0Blocker(envelope);
    button.addEventListener("click", async () => {
      let confirmation: HTMLInputElement | null = null;
      if (requiresConfirmation(actionId)) {
        confirmation = form.querySelector<HTMLInputElement>(
          "[name='__confirmation']",
        );
        if (!confirmation) {
          const wrapper = document.createElement("label");
          wrapper.className = "confirmation";
          confirmation = document.createElement("input");
          confirmation.type = "checkbox";
          confirmation.name = "__confirmation";
          confirmation.addEventListener("change", () => {
            values.__confirmation = confirmation?.checked === true;
          });
          wrapper.append(confirmation, " 我确认执行此操作");
          actions.prepend(wrapper);
        }
      }
      const invalid = firstInvalidField(envelope, values);
      if (invalid) {
        form.querySelector<HTMLElement>(
          `#stagepass-field-${CSS.escape(invalid)}`,
        )?.focus();
        status.textContent = "请填写所有必填项。";
        return;
      }
      if (!canSubmit(envelope, values, actionId)) {
        status.textContent = hasP0Blocker(envelope)
          ? "存在 P0 阻断项，无法提交。"
          : "请先确认此操作。";
        confirmation?.focus();
        return;
      }
      for (const control of actions.querySelectorAll("button")) {
        (control as HTMLButtonElement).disabled = true;
      }
      status.textContent = "正在保存决策…";
      try {
        await submitCard(client, state, { actionId, formValues: values });
        status.textContent = "决策已保存，任务已继续。";
      } catch (error) {
        status.textContent = error instanceof Error
          && error.message === "interaction_expired"
          ? "该决策已过期，请使用最新卡片。"
          : error instanceof Error
              && error.message === "continuation_failed_after_decision"
            ? "决策已保存，任务将在恢复后继续"
            : "决策提交失败，请重试。";
      }
    });
    actions.append(button);
  }
  form.append(actions, status);
  root.append(form);
}

export async function mountInteractionApp(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#stagepass-interaction");
  if (!root) return;
  const app = new App(
    { name: "stagepass-interaction-card", version: "1.0.0" },
    {},
    { autoResize: true, strict: true },
  );
  app.ontoolresult = (result) => {
    const envelope = result.structuredContent as
      | PublicInteractionEnvelope
      | undefined;
    const invocationNonce = (
      result._meta?.stagepass as { invocationNonce?: string } | undefined
    )?.invocationNonce;
    if (!envelope || !invocationNonce) return;
    renderInteractionCard(root, { envelope, invocationNonce }, app);
  };
  await app.connect(new PostMessageTransport(window.parent, window.parent));
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void mountInteractionApp();
}
