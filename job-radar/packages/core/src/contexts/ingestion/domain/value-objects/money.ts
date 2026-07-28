/**
 * Dinheiro em centavos inteiros, sempre. Ponto flutuante para valor monetário é
 * um bug esperando acontecer; a conversão de decimal (o Gupy fala BRL decimal,
 * o Greenhouse fala USD) acontece SÓ no mapper do adapter, nas duas direções.
 */
export type Currency = "BRL" | "USD" | "EUR" | "GBP" | "CAD";

const CURRENCIES: readonly Currency[] = ["BRL", "USD", "EUR", "GBP", "CAD"];

export class Money {
  private constructor(
    readonly amountCents: number,
    readonly currency: Currency,
  ) {}

  /** Devolve `null` em falha esperada — vira `Result.err` em quem chama, sem try/catch. */
  static fromCents(amountCents: number, currency: string): Money | null {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) return null;
    const normalized = currency.trim().toUpperCase();
    if (!Money.isCurrency(normalized)) return null;
    return new Money(amountCents, normalized);
  }

  /** Aceita o decimal que as fontes publicam (ex.: 4500.5 BRL) e arredonda a centavos. */
  static fromDecimal(amount: number, currency: string): Money | null {
    if (!Number.isFinite(amount)) return null;
    return Money.fromCents(Math.round(amount * 100), currency);
  }

  static isCurrency(value: string): value is Currency {
    return (CURRENCIES as readonly string[]).includes(value);
  }

  get decimal(): number {
    return this.amountCents / 100;
  }

  equals(other: Money): boolean {
    return this.amountCents === other.amountCents && this.currency === other.currency;
  }

  toString(): string {
    return `${this.currency} ${this.decimal.toFixed(2)}`;
  }
}

export type SalaryPeriod = "HOUR" | "MONTH" | "YEAR";

/**
 * Faixa salarial. Ambos os lados são opcionais porque a maioria das fontes
 * publica só um ("a partir de") ou nenhum.
 */
export class Compensation {
  private constructor(
    readonly min: Money | null,
    readonly max: Money | null,
    readonly period: SalaryPeriod,
  ) {}

  static create(input: {
    min?: Money | null;
    max?: Money | null;
    period: SalaryPeriod;
  }): Compensation | null {
    const min = input.min ?? null;
    const max = input.max ?? null;

    if (min === null && max === null) return null;
    // Moedas divergentes na mesma faixa é payload corrompido, não faixa válida.
    if (min && max && min.currency !== max.currency) return null;
    if (min && max && min.amountCents > max.amountCents) return null;

    return new Compensation(min, max, input.period);
  }

  get currency(): Currency {
    // Ao menos um dos lados existe (garantido em `create`) e ambos compartilham a moeda.
    return (this.min ?? this.max)?.currency as Currency;
  }
}
