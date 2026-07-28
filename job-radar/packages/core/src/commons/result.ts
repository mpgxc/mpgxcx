import type { BusinessError } from "./business-error.js";

/**
 * Falhas de negócio esperadas são valores, não exceções. `throw` fica reservado
 * para o genuinamente excepcional (infra fora do ar, bug, invariante violada).
 *
 * Devolver a falha como valor coloca ela na assinatura do método, então o
 * compilador obriga quem chama a tratar.
 */
export type Result<T, E = BusinessError> = Ok<T, E> | Err<T, E>;

export class Ok<T, E> {
  readonly _tag = "Ok" as const;

  constructor(readonly value: T) {}

  isOk(): this is Ok<T, E> {
    return true;
  }

  isErr(): this is Err<T, E> {
    return false;
  }

  unwrapOrThrow(): T {
    return this.value;
  }
}

export class Err<T, E> {
  readonly _tag = "Err" as const;

  constructor(readonly error: E) {}

  isOk(): this is Ok<T, E> {
    return false;
  }

  isErr(): this is Err<T, E> {
    return true;
  }

  unwrapOrThrow(): never {
    throw this.error;
  }
}

export const Result = {
  ok<T, E = never>(value: T): Result<T, E> {
    return new Ok(value);
  },
  err<E>(error: E): Result<never, E> {
    return new Err(error);
  },
} as const;
