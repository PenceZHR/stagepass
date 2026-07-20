import pino, { type Logger } from "pino";

const LOGGER_KEY = Symbol.for("stagepass.logger");

type LoggerGlobal = typeof globalThis & {
  [LOGGER_KEY]?: Logger;
};

function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL || "info",
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });
}

const loggerGlobal = globalThis as LoggerGlobal;

export const logger = loggerGlobal[LOGGER_KEY] ?? (loggerGlobal[LOGGER_KEY] = createLogger());

export function createChildLogger(module: string) {
  return logger.child({ module });
}
