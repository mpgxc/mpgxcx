import { BusinessError, ErrorType } from "../../../commons/business-error.js";

/**
 * Parâmetro de busca que o domínio recusa.
 *
 * É `VALIDATION` e não uma exceção porque entrada torta de cliente HTTP é o
 * caso ESPERADO de uma API pública, não o excepcional. A borda traduz o tipo
 * em status; o domínio nunca sabe que 400 existe.
 */
export class InvalidSearchQuery extends BusinessError {
  readonly type = ErrorType.VALIDATION;
  readonly code = "INVALID_SEARCH_QUERY";

  static create(field: string, reason: string) {
    return new InvalidSearchQuery({
      message: `Parâmetro '${field}' inválido: ${reason}`,
      details: { field, reason },
    });
  }
}

/**
 * Pedido de página além do teto de janela do índice.
 *
 * Separado de `InvalidSearchQuery` porque o sinal é outro: não é um parâmetro
 * malformado, é uma consulta legítima pedindo profundidade que o índice não
 * serve. O cliente conserta refinando o filtro, não corrigindo a sintaxe — e
 * essa distinção é o que a mensagem precisa carregar.
 */
export class SearchWindowExceeded extends BusinessError {
  readonly type = ErrorType.VALIDATION;
  readonly code = "SEARCH_WINDOW_EXCEEDED";

  static create(requested: number, limit: number) {
    return new SearchWindowExceeded({
      message:
        `Paginação profunda demais: a consulta pediria o resultado ${requested}, ` +
        `e a janela do índice vai até ${limit}. Refine os filtros em vez de avançar páginas.`,
      details: { requested, limit },
    });
  }
}
