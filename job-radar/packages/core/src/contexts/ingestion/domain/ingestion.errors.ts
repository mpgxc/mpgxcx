import { BusinessError, ErrorType } from "../../../commons/business-error.js";

/** A fonte não respondeu, estourou timeout ou devolveu 5xx/429. Vale retentar. */
export class SourceUnavailable extends BusinessError {
  readonly type = ErrorType.SOURCE_UNAVAILABLE;
  readonly code = "SOURCE_UNAVAILABLE";

  static create(sourceId: string, cause: { status: number | null; message: string }) {
    return new SourceUnavailable({
      message: `Fonte ${sourceId} indisponível: ${cause.message}`,
      details: { sourceId, ...cause },
    });
  }
}

/**
 * A fonte respondeu 200, mas o payload não casa com o contrato conhecido.
 *
 * Erro separado de propósito: NÃO vale retentar (retentar devolve o mesmo
 * payload) e o sinal operacional é oposto — significa que a fonte mudou a API
 * e o parser precisa ser corrigido. É o alerta que o canário de contrato dispara.
 */
export class SourceContractDrift extends BusinessError {
  readonly type = ErrorType.SOURCE_CONTRACT_DRIFT;
  readonly code = "SOURCE_CONTRACT_DRIFT";

  static create(sourceId: string, reason: string, sample?: unknown) {
    return new SourceContractDrift({
      message: `Payload da fonte ${sourceId} fora do contrato: ${reason}`,
      details: { sourceId, reason, sample },
    });
  }
}

/** Config de fonte inválida no registro. */
export class InvalidSourceConfig extends BusinessError {
  readonly type = ErrorType.VALIDATION;
  readonly code = "INVALID_SOURCE_CONFIG";

  static create(sourceId: string, reason: string) {
    return new InvalidSourceConfig({
      message: `Config inválida para ${sourceId}: ${reason}`,
      details: { sourceId, reason },
    });
  }
}

/** Nenhum adapter registrado para o `sourceId` pedido. */
export class UnknownSource extends BusinessError {
  readonly type = ErrorType.NOT_FOUND;
  readonly code = "UNKNOWN_SOURCE";

  static create(sourceId: string) {
    return new UnknownSource({
      message: `Nenhum adapter registrado para a fonte ${sourceId}`,
      details: { sourceId },
    });
  }
}
