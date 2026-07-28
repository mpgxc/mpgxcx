import { SourceHttpError } from "./http-client.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly now?: () => number;
}

/**
 * Breaker POR DEPENDÊNCIA — nunca global. Um breaker compartilhado faz a queda
 * do Gupy cortar o Greenhouse, que está saudável.
 *
 * Só falha de DISPONIBILIDADE alimenta o breaker (timeout, 5xx, 429, rede). Um
 * 4xx de negócio é resposta legítima da fonte e não pode abrir o circuito.
 *
 * Em Lambda o estado é por instância (execution environment), e tudo bem: cada
 * instância protege a si mesma. Um breaker distribuído em Redis custa mais do
 * que resolve aqui.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private openedAt = 0;

  private readonly now: () => number;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  get currentState(): CircuitState {
    return this.state;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.now() - this.openedAt < this.options.cooldownMs) {
        throw new SourceHttpError(null, `Circuito aberto para ${this.name}`);
      }
      this.state = "HALF_OPEN";
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.countsAsUnavailability(error)) this.onFailure();
      else this.onSuccess(); // 4xx de negócio: a fonte está viva.
      throw error;
    }
  }

  private countsAsUnavailability(error: unknown): boolean {
    return error instanceof SourceHttpError && error.isRetryable;
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === "HALF_OPEN" || this.failures >= this.options.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = this.now();
    }
  }
}
