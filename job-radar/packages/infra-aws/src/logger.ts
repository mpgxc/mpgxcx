export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Chaves nunca logadas, mesmo se aparecerem em `details`. */
const REDACTED_KEYS = new Set(["authorization", "cookie", "token", "apikey", "api_key", "secret"]);

export interface LogContext {
  /** Atravessa HTTP e fila. Sem isso o worker começa um trace desconectado. */
  readonly correlationId?: string;
  readonly runId?: string;
  readonly sourceId?: string;
  readonly [key: string]: unknown;
}

/**
 * Log estruturado em JSON — consultável, não uma string para humano grepar.
 *
 * `console` é usado de propósito: em Lambda, stdout já é o transporte para o
 * CloudWatch, e adicionar Pino aqui só somaria peso ao bundle e ao cold start.
 * A regra "nada de console em produção" existe contra log síncrono bloqueante
 * num servidor de longa duração — não é o caso de um handler serverless.
 */
export class Logger {
  constructor(
    private readonly service: string,
    private readonly context: LogContext = {},
    private readonly minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info",
  ) {}

  child(context: LogContext): Logger {
    return new Logger(this.service, { ...this.context, ...context }, this.minLevel);
  }

  debug(message: string, details?: unknown): void {
    this.emit("debug", message, details);
  }

  info(message: string, details?: unknown): void {
    this.emit("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.emit("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.emit("error", message, details);
  }

  private emit(level: LogLevel, message: string, details?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...this.context,
      ...(details === undefined ? {} : { details: redact(details) }),
    };

    // biome-ignore lint/suspicious/noConsole: stdout é o transporte de log em Lambda.
    console.log(JSON.stringify(entry));
  }
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      REDACTED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(item, depth + 1),
    ]),
  );
}
