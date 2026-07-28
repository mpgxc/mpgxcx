/**
 * Tipo SEMÂNTICO do erro. Nunca um status HTTP — a tradução `type -> status`
 * vive num único lugar, na borda HTTP.
 */
export enum ErrorType {
  VALIDATION = "VALIDATION",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  /** A fonte está fora do ar / rate-limited. Vale retentar. */
  SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE",
  /** A fonte respondeu, mas o payload não casa com o contrato conhecido. */
  SOURCE_CONTRACT_DRIFT = "SOURCE_CONTRACT_DRIFT",
  UNEXPECTED = "UNEXPECTED",
}

export abstract class BusinessError extends Error {
  abstract readonly type: ErrorType;
  /** Código estável, consumível por cliente e por alerta operacional. */
  abstract readonly code: string;

  readonly timestamp: string = new Date().toISOString();
  readonly details: unknown;

  protected constructor(payload: { message: string; details?: unknown } | string) {
    const { message, details } =
      typeof payload === "string" ? { message: payload, details: undefined } : payload;

    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Se vale a pena retentar. O pipeline usa isso para decidir DLQ vs backoff. */
  get retryable(): boolean {
    return this.type === ErrorType.SOURCE_UNAVAILABLE;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      type: this.type,
      message: this.message,
      details: this.details ?? null,
      timestamp: this.timestamp,
    };
  }
}
