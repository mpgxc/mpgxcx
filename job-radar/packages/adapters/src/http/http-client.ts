/**
 * Camada 1 — transporte puro.
 *
 * Este arquivo não conhece domínio, `JobPosting` nem `BusinessError`. Ele faz
 * uma coisa: executar HTTP com timeout e normalizar QUALQUER falha num único
 * erro tipado. A tradução para erro de negócio acontece no adapter (camada 2).
 */

/**
 * `status === null` significa que não houve resposta: timeout, DNS, socket.
 * A distinção importa — sem resposta é sempre retentável, com resposta depende
 * do código.
 */
export class SourceHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }

  get isRetryable(): boolean {
    if (this.status === null) return true;
    return this.status === 429 || this.status >= 500;
  }
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface HttpRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Mandados como If-None-Match / If-Modified-Since. */
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

export interface HttpClientOptions {
  readonly timeoutMs: number;
  readonly userAgent: string;
}

/** Status 304 é resposta válida e esperada, não erro. */
export const NOT_MODIFIED = 304;

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async get(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "user-agent": this.options.userAgent,
      ...request.headers,
    };
    if (request.etag) headers["if-none-match"] = request.etag;
    if (request.lastModified) headers["if-modified-since"] = request.lastModified;

    try {
      const response = await fetch(request.url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });

      if (response.status === NOT_MODIFIED) {
        return {
          status: NOT_MODIFIED,
          body: "",
          contentType: response.headers.get("content-type") ?? "",
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
      }

      const body = await response.text();

      if (!response.ok) {
        throw new SourceHttpError(
          response.status,
          `HTTP ${response.status} em ${request.url}`,
          body.slice(0, 500),
        );
      }

      return {
        status: response.status,
        body,
        contentType: response.headers.get("content-type") ?? "",
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    } catch (error) {
      if (error instanceof SourceHttpError) throw error;

      const isAbort = error instanceof Error && error.name === "AbortError";
      const message = isAbort
        ? `Timeout de ${this.options.timeoutMs}ms em ${request.url}`
        : error instanceof Error
          ? error.message
          : String(error);

      // Sem resposta: status null.
      throw new SourceHttpError(null, message);
    } finally {
      clearTimeout(timer);
    }
  }
}
