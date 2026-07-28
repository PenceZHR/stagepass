import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";

const SERVER_NAME = "StagePass Requirement Choices";
const SERVER_VERSION = "0.3.0";
const PRESENT_TOOL_NAME = "present_stagepass_choices";
const RECORD_TOOL_NAME = "record_stagepass_choice";
const UI_URI = "ui://stagepass/requirement-choice-v2";
const UI_MIME = "text/html;profile=mcp-app";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-11-25"]);
const MAX_STRING_LENGTH = 8_000;
const MAX_OPTIONS = 8;
const MAX_QUESTIONS = 10;
const DATA_DIRECTORY =
  process.env.PLUGIN_DATA
  || process.env.STAGEPASS_CARD_DATA_DIR
  || join(homedir(), ".codex", "plugin-data", "stagepass-card");
const RECEIPT_PATH = join(DATA_DIRECTORY, "stagepass-choice-receipts.jsonl");
const API_BASE_URL =
  process.env.STAGEPASS_API_BASE_URL || "http://127.0.0.1:3000";

const presented = new Map();
const receiptsByIdempotencyKey = new Map();
let initialized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function boundedString(value, field, { max = MAX_STRING_LENGTH, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

function validatePresentArguments(value) {
  const input = asObject(value);
  if (!input) throw new Error("invalid_choice_card");
  const interactionId = boundedString(input.interactionId, "interaction_id", {
    max: 256,
  });
  const logicalTurnId = boundedString(
    input.logicalTurnId,
    "logical_turn_id",
    { max: 256 },
  );
  const projectId = boundedString(input.projectId, "project_id", {
    max: 256,
  });
  const changeId = input.changeId === null || input.changeId === undefined
    ? null
    : boundedString(input.changeId, "change_id", { max: 256 });
  const threadId = boundedString(input.threadId, "thread_id", {
    max: 256,
  });
  const batchTitle = boundedString(input.batchTitle, "batch_title", {
    max: 512,
  });
  const project = boundedString(input.project, "project", {
    max: 256,
    optional: true,
  });
  const stage = boundedString(input.stage, "stage", {
    max: 128,
    optional: true,
  });
  const helperText = boundedString(input.helperText, "helper_text", {
    max: 2_000,
    optional: true,
  });
  if (
    !Array.isArray(input.questions)
    || input.questions.length < 1
    || input.questions.length > MAX_QUESTIONS
  ) {
    throw new Error("invalid_questions");
  }
  const questionIds = new Set();
  const questions = input.questions.map((value) => {
    const question = asObject(value);
    if (!question) throw new Error("invalid_question");
    const questionId = boundedString(question.id, "question_id", { max: 128 });
    if (questionIds.has(questionId)) throw new Error("duplicate_question_id");
    questionIds.add(questionId);
    const selectionMode = question.selectionMode ?? "single";
    if (selectionMode !== "single" && selectionMode !== "multiple") {
      throw new Error("invalid_selection_mode");
    }
    if (
      !Array.isArray(question.options)
      || question.options.length < 2
      || question.options.length > MAX_OPTIONS
    ) {
      throw new Error("invalid_options");
    }
    const optionIds = new Set();
    const options = question.options.map((value) => {
      const option = asObject(value);
      if (!option) throw new Error("invalid_option");
      const id = boundedString(option.id, "option_id", { max: 128 });
      if (optionIds.has(id)) throw new Error("duplicate_option_id");
      optionIds.add(id);
      return {
        id,
        label: boundedString(option.label, "option_label", { max: 512 }),
        ...(option.description === undefined
          ? {}
          : {
              description: boundedString(
                option.description,
                "option_description",
                { max: 2_000 },
              ),
            }),
      };
    });
    const minSelections = selectionMode === "single"
      ? 1
      : Number.isSafeInteger(question.minSelections)
        ? question.minSelections
        : 1;
    const maxSelections = selectionMode === "single"
      ? 1
      : Number.isSafeInteger(question.maxSelections)
        ? question.maxSelections
        : options.length;
    if (
      minSelections < 1
      || maxSelections < minSelections
      || maxSelections > options.length
    ) {
      throw new Error("invalid_selection_bounds");
    }
    return {
      id: questionId,
      question: boundedString(question.question, "question"),
      options,
      selectionMode,
      minSelections,
      maxSelections,
    };
  });
  return {
    interactionId,
    logicalTurnId,
    projectId,
    changeId,
    threadId,
    batchTitle,
    questions,
    ...(project ? { project } : {}),
    ...(stage ? { stage } : {}),
    ...(helperText ? { helperText } : {}),
  };
}

function selectionHash(answers) {
  const normalized = answers
    .map((answer) => ({
      questionId: answer.questionId,
      selectedOptionIds: [...answer.selectedOptionIds].sort(),
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function validateRecordArguments(value) {
  const input = asObject(value);
  if (!input) throw new Error("invalid_choice_submission");
  const interactionId = boundedString(input.interactionId, "interaction_id", {
    max: 256,
  });
  const idempotencyKey = boundedString(
    input.idempotencyKey,
    "idempotency_key",
    { max: 512 },
  );
  if (
    !Array.isArray(input.answers)
    || input.answers.length < 1
    || input.answers.length > MAX_QUESTIONS
  ) throw new Error("invalid_answers");
  const questionIds = new Set();
  const answers = input.answers.map((value) => {
    const answer = asObject(value);
    if (!answer) throw new Error("invalid_answer");
    const questionId = boundedString(answer.questionId, "question_id", {
      max: 128,
    });
    if (questionIds.has(questionId)) throw new Error("duplicate_question_id");
    questionIds.add(questionId);
    if (
      !Array.isArray(answer.selectedOptionIds)
      || answer.selectedOptionIds.length === 0
      || answer.selectedOptionIds.length > MAX_OPTIONS
    ) throw new Error("invalid_selection");
    const selectedOptionIds = answer.selectedOptionIds.map((selected) =>
      boundedString(selected, "selected_option_id", { max: 128 })
    );
    if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw new Error("duplicate_selection");
    }
    return { questionId, selectedOptionIds };
  });
  return { interactionId, idempotencyKey, answers };
}

function secureDataDirectory() {
  mkdirSync(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = lstatSync(DATA_DIRECTORY);
  const userId = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    directory.isSymbolicLink()
    || !directory.isDirectory()
    || (userId !== null && directory.uid !== userId)
  ) {
    throw new Error("receipt_directory_untrusted");
  }
  chmodSync(DATA_DIRECTORY, 0o700);
}

function appendReceipt(receipt) {
  secureDataDirectory();
  let descriptor;
  try {
    try {
      if (lstatSync(RECEIPT_PATH).isSymbolicLink()) {
        throw new Error("receipt_file_untrusted");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    descriptor = openSync(
      RECEIPT_PATH,
      fsConstants.O_WRONLY
        | fsConstants.O_APPEND
        | fsConstants.O_CREAT
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, `${JSON.stringify(receipt)}\n`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadReceipts() {
  try {
    const lines = readFileSync(RECEIPT_PATH, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const receipt = JSON.parse(line);
      if (
        receipt
        && typeof receipt === "object"
        && typeof receipt.idempotencyKey === "string"
        && typeof receipt.selectionHash === "string"
        && typeof receipt.receiptId === "string"
      ) {
        receiptsByIdempotencyKey.set(receipt.idempotencyKey, receipt);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write("stagepass_receipt_recovery_failed\n");
    }
  }
}

loadReceipts();

const presentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "interactionId",
    "logicalTurnId",
    "projectId",
    "changeId",
    "threadId",
    "batchTitle",
    "questions",
  ],
  properties: {
    interactionId: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Stable identifier for this clarification.",
    },
    logicalTurnId: { type: "string", minLength: 1, maxLength: 256 },
    projectId: { type: "string", minLength: 1, maxLength: 256 },
    changeId: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 256 },
        { type: "null" },
      ],
    },
    threadId: { type: "string", minLength: 1, maxLength: 256 },
    project: { type: "string", minLength: 1, maxLength: 256 },
    stage: { type: "string", minLength: 1, maxLength: 128 },
    batchTitle: { type: "string", minLength: 1, maxLength: 512 },
    helperText: { type: "string", minLength: 1, maxLength: 2_000 },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "options"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          question: {
            type: "string",
            minLength: 1,
            maxLength: MAX_STRING_LENGTH,
          },
          selectionMode: {
            type: "string",
            enum: ["single", "multiple"],
            default: "single",
          },
          minSelections: {
            type: "integer",
            minimum: 1,
            maximum: MAX_OPTIONS,
          },
          maxSelections: {
            type: "integer",
            minimum: 1,
            maximum: MAX_OPTIONS,
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 128 },
                label: { type: "string", minLength: 1, maxLength: 512 },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: 2_000,
                },
              },
            },
          },
        },
      },
    },
  },
};

const recordInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["interactionId", "idempotencyKey", "answers"],
  properties: {
    interactionId: { type: "string", minLength: 1, maxLength: 256 },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 512 },
    answers: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "selectedOptionIds"],
        properties: {
          questionId: { type: "string", minLength: 1, maxLength: 128 },
          selectedOptionIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_OPTIONS,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
  },
};

const widgetHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StagePass 需求确认</title>
  <style>
    :root {
      color-scheme: light dark;
      --sp-bg: var(--color-background-primary, #0f1015);
      --sp-surface: var(--color-background-secondary, #171922);
      --sp-text: var(--color-text-primary, #f3f0e8);
      --sp-muted: var(--color-text-secondary, #aaa6a0);
      --sp-border: color-mix(in srgb, var(--sp-text) 16%, transparent);
      --sp-accent: #e6bd7a;
      --sp-success: #69b887;
      --sp-warning: #d69a53;
      --sp-danger: #d46f64;
      font-family: var(--font-sans, "Geist", "PingFang SC", system-ui, sans-serif);
      background: transparent;
      color: var(--sp-text);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; }
    main {
      overflow: hidden;
      border: 1px solid var(--sp-border);
      border-radius: 14px;
      background: var(--sp-surface);
    }
    header { padding: 16px 16px 12px; border-bottom: 1px solid var(--sp-border); }
    .eyebrow { margin: 0 0 6px; color: var(--sp-accent); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 17px; line-height: 1.4; }
    .context { margin: 6px 0 0; color: var(--sp-muted); font-size: 11px; }
    form { display: grid; gap: 12px; padding: 14px 16px; }
    #choice-questions { display: grid; gap: 12px; }
    .question-card {
      display: grid;
      gap: 9px;
      padding: 12px;
      border: 1px solid var(--sp-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--sp-bg) 34%, transparent);
    }
    .question-heading {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .question-number {
      display: grid;
      width: 22px;
      height: 22px;
      place-items: center;
      border-radius: 6px;
      background: color-mix(in srgb, var(--sp-accent) 14%, transparent);
      color: var(--sp-accent);
      font-size: 10px;
      font-weight: 800;
    }
    .question-title { margin: 1px 0 0; font-size: 13px; font-weight: 700; line-height: 1.45; }
    .question-hint { margin: 0 0 0 32px; color: var(--sp-muted); font-size: 10px; }
    .question-options { display: grid; gap: 7px; }
    .option {
      display: grid;
      grid-template-columns: 18px 22px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      margin: 0;
      padding: 9px 10px;
      border: 1px solid var(--sp-border);
      border-radius: 8px;
      cursor: pointer;
      background: color-mix(in srgb, var(--sp-bg) 58%, transparent);
    }
    .option:has(input:checked) {
      border-color: color-mix(in srgb, var(--sp-accent) 70%, transparent);
      background: color-mix(in srgb, var(--sp-accent) 10%, var(--sp-bg));
    }
    input[type="checkbox"], input[type="radio"] {
      width: 17px;
      height: 17px;
      margin: 1px 0 0;
      accent-color: var(--sp-accent);
    }
    .option-key {
      display: grid;
      width: 20px;
      height: 20px;
      place-items: center;
      border: 1px solid var(--sp-border);
      border-radius: 5px;
      color: var(--sp-muted);
      font-size: 10px;
      font-weight: 800;
    }
    .option-title { display: block; color: var(--sp-text); font-size: 13px; font-weight: 650; line-height: 1.35; }
    .option-description { display: block; margin-top: 3px; color: var(--sp-muted); font-size: 11px; line-height: 1.45; }
    .helper { margin: 0; color: var(--sp-muted); font-size: 11px; line-height: 1.5; }
    .progress { margin: 0; color: var(--sp-muted); font-size: 11px; font-weight: 650; }
    button {
      width: 100%;
      min-height: 38px;
      border: 0;
      border-radius: 9px;
      cursor: pointer;
      background: var(--sp-accent);
      color: #271e13;
      font: 700 12px/1 var(--font-sans, system-ui, sans-serif);
    }
    button:disabled { cursor: not-allowed; opacity: .42; }
    footer {
      min-height: 40px;
      padding: 11px 16px;
      border-top: 1px solid var(--sp-border);
      color: var(--sp-muted);
      font-size: 11px;
      line-height: 1.45;
    }
    footer[data-state="success"] { color: var(--sp-success); }
    footer[data-state="warning"] { color: var(--sp-warning); }
    footer[data-state="error"] { color: var(--sp-danger); }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow" id="stage-label">StagePass · 需求确认</p>
      <h1 id="choice-question">正在读取模型给出的具体问题…</h1>
      <p class="context" id="choice-context"></p>
    </header>
    <form id="choice-form">
      <div id="choice-questions"></div>
      <p class="progress" id="choice-progress">已回答 0/0</p>
      <p class="helper" id="choice-helper">逐题勾选后会回到当前 Codex 任务继续检查阻塞项。</p>
      <button id="submit-choice" type="button" disabled>提交本批答案并继续</button>
    </form>
    <footer id="card-status" role="status" aria-live="polite" aria-atomic="true">等待选择</footer>
  </main>
  <script>
    (function () {
      var nextRequestId = 1;
      var pendingRequests = new Map();
      var card = null;
      var questionInputs = [];
      var answersByQuestion = {};
      var receipt = null;
      var continuing = false;
      var questionsRoot = document.getElementById("choice-questions");
      var question = document.getElementById("choice-question");
      var context = document.getElementById("choice-context");
      var progress = document.getElementById("choice-progress");
      var helper = document.getElementById("choice-helper");
      var stageLabel = document.getElementById("stage-label");
      var submit = document.getElementById("submit-choice");
      var status = document.getElementById("card-status");

      function request(method, params) {
        var id = nextRequestId++;
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            pendingRequests.delete(id);
            reject(new Error(method + "_timeout"));
          }, 10000);
          pendingRequests.set(id, {
            resolve: function (value) {
              clearTimeout(timer);
              resolve(value);
            },
            reject: function (error) {
              clearTimeout(timer);
              reject(error);
            }
          });
          window.parent.postMessage({
            jsonrpc: "2.0",
            id: id,
            method: method,
            params: params
          }, "*");
        });
      }

      function notify(method, params) {
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: method,
          params: params
        }, "*");
      }

      function hasCodexCompatibilityHost() {
        return !!(
          window.openai
          && typeof window.openai.callTool === "function"
        );
      }

      function callAppTool(name, argumentsValue) {
        if (window.openai && typeof window.openai.callTool === "function") {
          return Promise.resolve(window.openai.callTool(name, argumentsValue));
        }
        return request("tools/call", {
          name: name,
          arguments: argumentsValue
        });
      }

      function setStatus(text, state) {
        status.textContent = text;
        status.dataset.state = state || "";
      }

      function persist(uiStatus) {
        if (!window.openai || typeof window.openai.setWidgetState !== "function") return;
        window.openai.setWidgetState({
          modelContent: uiStatus === "completed"
            ? "The user confirmed a StagePass requirement selection."
            : "The StagePass requirement choice is still pending.",
          privateContent: {
            interactionId: card && card.interactionId,
            status: uiStatus,
            answers: answersForSubmission(),
            receipt: receipt
          }
        });
      }

      function selectedIdsFor(questionId) {
        return Array.isArray(answersByQuestion[questionId])
          ? answersByQuestion[questionId]
          : [];
      }

      function questionValid(questionValue) {
        var selected = selectedIdsFor(questionValue.id);
        return selected.length >= questionValue.minSelections
          && selected.length <= questionValue.maxSelections;
      }

      function completedQuestionCount() {
        if (!card) return 0;
        return card.questions.filter(questionValid).length;
      }

      function selectionValid() {
        if (!card) return false;
        return card.questions.length > 0
          && completedQuestionCount() === card.questions.length;
      }

      function answersForSubmission() {
        if (!card) return [];
        return card.questions.map(function (questionValue) {
          return {
            questionId: String(questionValue.id),
            selectedOptionIds: selectedIdsFor(questionValue.id).slice()
          };
        });
      }

      function updateProgress() {
        var completed = completedQuestionCount();
        var total = card ? card.questions.length : 0;
        progress.textContent = "已回答 " + completed + "/" + total;
      }

      function refresh() {
        var locked = continuing || (receipt && receipt.continuationConfirmed);
        questionInputs.forEach(function (input) {
          input.disabled = !!locked;
        });
        updateProgress();
        submit.disabled = locked || (!receipt && !selectionValid());
        submit.textContent = continuing
          ? "正在回到当前任务…"
          : receipt && !receipt.continuationConfirmed
            ? "重试回到当前任务"
            : receipt && receipt.continuationConfirmed
              ? "已提交"
              : "提交本批答案并继续";
      }

      function restoreWidgetState() {
        var state = window.openai
          && window.openai.widgetState
          && window.openai.widgetState.privateContent;
        if (!state || state.interactionId !== card.interactionId) return;
        if (Array.isArray(state.answers)) {
          state.answers.forEach(function (answer) {
            if (!answer || typeof answer !== "object") return;
            var questionValue = card.questions.find(function (candidate) {
              return candidate.id === answer.questionId;
            });
            if (!questionValue || !Array.isArray(answer.selectedOptionIds)) return;
            answersByQuestion[questionValue.id] = answer.selectedOptionIds.filter(function (id) {
              return questionValue.options.some(function (option) {
                return option.id === id;
              });
            });
          });
        }
        if (state.receipt && typeof state.receipt === "object") {
          receipt = state.receipt;
        }
      }

      function render(value) {
        if (!value || typeof value !== "object" || !Array.isArray(value.questions)) return;
        card = value;
        card.questions = card.questions.map(function (questionValue) {
          var mode = questionValue.selectionMode === "multiple"
            ? "multiple"
            : "single";
          return Object.assign({}, questionValue, {
            selectionMode: mode,
            minSelections: Number.isInteger(questionValue.minSelections)
              ? questionValue.minSelections
              : 1,
            maxSelections: Number.isInteger(questionValue.maxSelections)
              ? questionValue.maxSelections
              : mode === "single" ? 1 : questionValue.options.length
          });
        });
        answersByQuestion = {};
        receipt = null;
        restoreWidgetState();
        question.textContent = String(card.batchTitle || "运行前需要你确认");
        stageLabel.textContent = ["StagePass", card.stage, "需求确认"]
          .filter(Boolean)
          .join(" · ");
        context.textContent = [
          card.project ? String(card.project) : "",
          "本批 " + card.questions.length + " 个具体问题"
        ].filter(Boolean).join(" · ");
        helper.textContent = String(
          card.helperText
          || "逐题勾选后会回到当前 Codex 任务继续检查阻塞项。"
        );
        questionsRoot.replaceChildren();
        questionInputs = [];

        card.questions.forEach(function (questionValue, questionIndex) {
          var section = document.createElement("section");
          section.className = "question-card";
          var heading = document.createElement("div");
          heading.className = "question-heading";
          var number = document.createElement("span");
          number.className = "question-number";
          number.textContent = String(questionIndex + 1);
          var title = document.createElement("h2");
          title.className = "question-title";
          title.textContent = String(questionValue.question);
          heading.append(number, title);
          section.append(heading);
          var hint = document.createElement("p");
          hint.className = "question-hint";
          hint.textContent = questionValue.selectionMode === "multiple"
            ? "可多选，至少 " + questionValue.minSelections
              + " 项，最多 " + questionValue.maxSelections + " 项"
            : "单选";
          section.append(hint);
          var optionGroup = document.createElement("div");
          optionGroup.className = "question-options";

          questionValue.options.forEach(function (option, optionIndex) {
            var label = document.createElement("label");
            label.className = "option";
            var input = document.createElement("input");
            input.type = questionValue.selectionMode === "multiple"
              ? "checkbox"
              : "radio";
            input.name = "stagepass-" + card.interactionId + "-" + questionValue.id;
            input.value = String(option.id);
            input.dataset.questionId = String(questionValue.id);
            input.checked = selectedIdsFor(questionValue.id).indexOf(input.value) >= 0;
            input.setAttribute(
              "aria-label",
              String(questionValue.question) + "：" + String(option.label)
            );
            var key = document.createElement("span");
            key.className = "option-key";
            key.textContent = String.fromCharCode(65 + optionIndex);
            var copy = document.createElement("span");
            var optionTitle = document.createElement("span");
            optionTitle.className = "option-title";
            optionTitle.textContent = String(option.label);
            copy.append(optionTitle);
            if (option.description) {
              var description = document.createElement("span");
              description.className = "option-description";
              description.textContent = String(option.description);
              copy.append(description);
            }
            input.addEventListener("change", function () {
              var group = questionInputs.filter(function (candidate) {
                return candidate.dataset.questionId === questionValue.id;
              });
              if (questionValue.selectionMode === "single") {
                group.forEach(function (candidate) {
                  if (candidate !== input) candidate.checked = false;
                });
              }
              var selected = group
                .filter(function (candidate) { return candidate.checked; })
                .map(function (candidate) { return candidate.value; });
              if (selected.length > questionValue.maxSelections) {
                input.checked = false;
                selected = group
                  .filter(function (candidate) { return candidate.checked; })
                  .map(function (candidate) { return candidate.value; });
                answersByQuestion[questionValue.id] = selected;
                setStatus(
                  "第 " + (questionIndex + 1) + " 题最多选择 "
                    + questionValue.maxSelections + " 项",
                  "warning"
                );
              } else {
                answersByQuestion[questionValue.id] = selected;
                setStatus(
                  selectionValid()
                    ? "本批问题已全部回答，等待提交"
                    : "请继续回答本批剩余问题",
                  ""
                );
              }
              persist("selecting");
              refresh();
            });
            questionInputs.push(input);
            label.append(input, key, copy);
            optionGroup.append(label);
          });
          section.append(optionGroup);
          questionsRoot.append(section);
        });

        if (receipt && receipt.continuationConfirmed) {
          setStatus("已生效：选择已记录，并已回到当前 Codex 任务继续。", "success");
        } else if (receipt) {
          setStatus("选择已记录，但当前 Codex 任务尚未确认继续。", "warning");
        } else {
          setStatus("等待选择", "");
        }
        refresh();
      }

      function compactAnswerHash(value) {
        var text = JSON.stringify(value);
        var hash = 2166136261;
        for (var index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
      }

      async function recordSelection() {
        var answers = answersForSubmission();
        var key = [
          "stagepass-choice",
          card.interactionId,
          compactAnswerHash(answers)
        ].join(":");
        var result = await callAppTool("record_stagepass_choice", {
          interactionId: card.interactionId,
          idempotencyKey: key,
          answers: answers
        });
        if (result && result.isError) throw new Error("record_failed");
        var recorded = result && result.structuredContent;
        if (
          !recorded
          || recorded.status !== "recorded"
          || !recorded.receiptId
          || recorded.backendConfirmed !== true
        ) {
          throw new Error("record_not_acknowledged");
        }
        receipt = {
          receiptId: recorded.receiptId,
          acceptedAt: recorded.acceptedAt,
          duplicate: recorded.duplicate === true,
          continuationConfirmed: recorded.continuationConfirmed === true,
          continuationThreadId: recorded.continuationThreadId || null,
          continuationTurnId: recorded.continuationTurnId || null,
          continuationErrorCode: recorded.continuationErrorCode || null
        };
        persist(
          receipt.continuationConfirmed ? "completed" : "recorded_only"
        );
        if (!receipt.continuationConfirmed || !receipt.continuationTurnId) {
          throw new Error("continuation_not_acknowledged");
        }
      }

      submit.addEventListener("click", async function () {
        if (!card || continuing || (!receipt && !selectionValid())) return;
        continuing = true;
        setStatus(
          receipt ? "正在重试当前任务…" : "正在记录选择…",
          ""
        );
        refresh();
        try {
          await recordSelection();
          setStatus("已生效：选择已记录，并已回到当前 Codex 任务继续。", "success");
        } catch (error) {
          // Say which failure this is. Both branches used to end in 「请重试」,
          // and for a card whose run has already died that is advice the user
          // cannot act on: retrying the card cannot revive the run, so the same
          // click fails forever while the message keeps promising otherwise.
          var reason = (error && error.message) || "";
          var runIsGone = reason === "continuation_not_acknowledged";
          if (receipt) {
            persist("recorded_only");
            setStatus(
              runIsGone
                ? "选择已记录，但这张卡对应的运行已经结束，无法继续。请回到 StagePass 重跑该阶段。"
                : "选择已记录，但当前 Codex 任务尚未确认继续。请重试。",
              "warning"
            );
          } else {
            persist("failed");
            setStatus(
              runIsGone
                ? "这张卡对应的运行已经结束，选择无处可去。请回到 StagePass 重跑该阶段，会出现一张新的卡。"
                : "提交失败，选择尚未生效。请重试。（" + (reason || "unknown") + "）",
              "error"
            );
          }
        } finally {
          continuing = false;
          refresh();
        }
      });

      window.addEventListener("message", function (event) {
        if (event.source !== window.parent) return;
        var message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pendingRequests.has(message.id)) {
          var pending = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || "request_failed"));
          else pending.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          render(message.params && message.params.structuredContent);
        } else if (message.method === "ui/notifications/tool-input" && !card) {
          render(message.params);
        }
      }, { passive: true });

      if (!hasCodexCompatibilityHost()) {
        request("ui/initialize", {
          protocolVersion: "2026-01-26",
          appCapabilities: { availableDisplayModes: ["inline"] },
          appInfo: { name: "stagepass-card", version: "0.3.0" }
        }).then(function () {
          notify("ui/notifications/initialized", {});
        }).catch(function () {
          setStatus("Codex 卡片宿主初始化失败，选择尚未生效。", "error");
        });
      }
      if (window.openai && window.openai.toolOutput) {
        render(window.openai.toolOutput);
      }
    })();
  </script>
</body>
</html>`;

const tools = [
  {
    name: PRESENT_TOOL_NAME,
    title: "Present StagePass requirement question batch",
    description:
      "Show one to ten concrete requirement questions as separate A/B/C choice cards in the current Codex task. Ask actual blocking questions, never category names or a checklist of PRD dimensions.",
    inputSchema: presentInputSchema,
    annotations: { readOnlyHint: true },
    _meta: {
      ui: {
        resourceUri: UI_URI,
        visibility: ["model", "app"],
      },
      "openai/outputTemplate": UI_URI,
      "openai/widgetAccessible": true,
      "openai/visibility": "public",
      "openai/toolInvocation/invoking": "正在准备需求选项…",
      "openai/toolInvocation/invoked": "需求选项已准备。",
    },
  },
  {
    name: RECORD_TOOL_NAME,
    title: "Record StagePass requirement answers",
    description:
      "Record all answers from one StagePass question batch. This tool is private to the app UI.",
    inputSchema: recordInputSchema,
    _meta: {
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/toolInvocation/invoking": "正在记录选择…",
      "openai/toolInvocation/invoked": "选择已记录。",
    },
  },
];

function toolFailure(code) {
  return {
    isError: true,
    content: [{ type: "text", text: code }],
  };
}

function callPresent(argumentsValue) {
  const card = validatePresentArguments(argumentsValue);
  presented.set(card.interactionId, card);
  return {
    content: [{
      type: "text",
      text: "StagePass is waiting for the user's answers to the rendered concrete question batch.",
    }],
    structuredContent: {
      schemaVersion: "stagepass.requirement-choice/v2",
      status: "awaiting_selection",
      ...card,
    },
  };
}

function trustedApiBaseUrl() {
  const url = new URL(API_BASE_URL);
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    throw new Error("backend_url_untrusted");
  }
  return url;
}

async function confirmBackendReceipt(receipt, card) {
  const endpoint = new URL(
    "/api/codex/card-choice-receipts",
    trustedApiBaseUrl(),
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: receipt.schemaVersion,
      receiptId: receipt.receiptId,
      interactionId: receipt.interactionId,
      idempotencyKey: receipt.idempotencyKey,
      logicalTurnId: card.logicalTurnId,
      projectId: card.projectId,
      changeId: card.changeId,
      threadId: card.threadId,
      stage: card.stage ?? null,
      batchTitle: card.batchTitle,
      answers: receipt.answers,
      clientRecordedAt: receipt.acceptedAt,
    }),
  });
  const result = await response.json().catch(() => null);
  if (
    !response.ok
    || !result
    || result.status !== "recorded"
    || result.receiptId !== receipt.receiptId
    || typeof result.acceptedAt !== "string"
  ) {
    throw new Error(
      result && typeof result.error === "string"
        ? result.error
        : "backend_receipt_not_acknowledged",
    );
  }
  return result;
}

async function callRecord(argumentsValue) {
  const input = validateRecordArguments(argumentsValue);
  const card = presented.get(input.interactionId);
  if (!card) throw new Error("interaction_not_presented");
  if (input.answers.length !== card.questions.length) {
    throw new Error("answer_count_invalid");
  }
  const questionsById = new Map(
    card.questions.map((question) => [question.id, question]),
  );
  const normalizedAnswers = input.answers.map((answer) => {
    const question = questionsById.get(answer.questionId);
    if (!question) throw new Error("unknown_question");
    const labelsById = new Map(
      question.options.map((option) => [option.id, option.label]),
    );
    if (
      answer.selectedOptionIds.some((id) => !labelsById.has(id))
    ) throw new Error("unknown_option");
    if (
      answer.selectedOptionIds.length < question.minSelections
      || answer.selectedOptionIds.length > question.maxSelections
    ) throw new Error("selection_count_invalid");
    return {
      questionId: question.id,
      question: question.question,
      selectedOptionIds: [...answer.selectedOptionIds],
      selectedLabels: answer.selectedOptionIds.map((id) => labelsById.get(id)),
    };
  });
  if (new Set(normalizedAnswers.map((answer) => answer.questionId)).size !== card.questions.length) {
    throw new Error("answer_count_invalid");
  }
  const hash = selectionHash(normalizedAnswers);
  const existing = receiptsByIdempotencyKey.get(input.idempotencyKey);
  if (existing) {
    if (
      existing.interactionId !== input.interactionId
      || existing.selectionHash !== hash
    ) {
      throw new Error("idempotency_conflict");
    }
    const backend = await confirmBackendReceipt(existing, card);
    return {
      content: [{ type: "text", text: "StagePass choice was already recorded." }],
      structuredContent: {
        status: "recorded",
        receiptId: existing.receiptId,
        acceptedAt: backend.acceptedAt,
        duplicate: true,
        backendConfirmed: true,
        continuationConfirmed: backend.continuationConfirmed === true,
        continuationThreadId: backend.continuationThreadId ?? null,
        continuationTurnId: backend.continuationTurnId ?? null,
        continuationErrorCode: backend.continuationErrorCode ?? null,
      },
    };
  }
  const receipt = {
    schemaVersion: "stagepass.choice-receipt/v2",
    receiptId: randomUUID(),
    interactionId: input.interactionId,
    idempotencyKey: input.idempotencyKey,
    selectionHash: hash,
    answers: normalizedAnswers,
    project: card.project ?? null,
    stage: card.stage ?? null,
    threadId: card.threadId ?? null,
    acceptedAt: new Date().toISOString(),
  };
  appendReceipt(receipt);
  receiptsByIdempotencyKey.set(input.idempotencyKey, receipt);
  const backend = await confirmBackendReceipt(receipt, card);
  return {
    content: [{ type: "text", text: "StagePass choice recorded." }],
    structuredContent: {
      status: "recorded",
      receiptId: receipt.receiptId,
      acceptedAt: backend.acceptedAt,
      duplicate: backend.duplicate === true,
      backendConfirmed: true,
      continuationConfirmed: backend.continuationConfirmed === true,
      continuationThreadId: backend.continuationThreadId ?? null,
      continuationTurnId: backend.continuationTurnId ?? null,
      continuationErrorCode: backend.continuationErrorCode ?? null,
    },
  };
}

async function handleRequest(message) {
  const { id, method } = message;
  const params = asObject(message.params) ?? {};
  if (method === "initialize") {
    const requested = params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : "2025-06-18";
    initialized = true;
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Use present_stagepass_choices for batches of one to ten concrete execution-blocking requirement questions. Never substitute category names or PRD dimensions for actual questions.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (!initialized) {
    sendError(id, -32002, "Server not initialized");
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }
  if (method === "resources/list") {
    sendResult(id, {
      resources: [{
        uri: UI_URI,
        name: "StagePass concrete requirement question batch",
        description: "Up to ten concrete questions with separate A/B/C choices.",
        mimeType: UI_MIME,
      }],
    });
    return;
  }
  if (method === "resources/read") {
    if (params.uri !== UI_URI) {
      sendError(id, -32602, "Unknown resource URI");
      return;
    }
    sendResult(id, {
      contents: [{
        uri: UI_URI,
        mimeType: UI_MIME,
        text: widgetHtml,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/widgetPrefersBorder": true,
        },
      }],
    });
    return;
  }
  if (method === "tools/call") {
    if (typeof params.name !== "string" || !asObject(params.arguments)) {
      sendError(id, -32602, "tools/call requires a tool name and arguments");
      return;
    }
    try {
      if (params.name === PRESENT_TOOL_NAME) {
        sendResult(id, callPresent(params.arguments));
      } else if (params.name === RECORD_TOOL_NAME) {
        sendResult(id, await callRecord(params.arguments));
      } else {
        sendError(id, -32601, "Unknown tool");
      }
    } catch (error) {
      sendResult(
        id,
        toolFailure(error instanceof Error ? error.message : "tool_failed"),
      );
    }
    return;
  }
  sendError(id, -32601, "Method not found");
}

export async function processLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || message.jsonrpc !== "2.0"
    || typeof message.method !== "string"
  ) {
    sendError(
      message && typeof message === "object" && "id" in message
        ? message.id
        : null,
      -32600,
      "Invalid Request",
    );
    return;
  }
  if (message.id === undefined) return;
  await handleRequest(message);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    void processLine(line);
  });
}
