const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article)[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;

const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0?39;|&apos;/gi, "'"],
];

/**
 * Descrição da vaga nas duas formas. Guardamos o HTML porque é o que a fonte
 * publicou (e o que permite reprocessar), e o texto porque é o que vai para o
 * índice de busca e para a extração de stack/senioridade.
 */
export class RichText {
  private constructor(
    readonly html: string,
    readonly text: string,
  ) {}

  static fromHtml(html: string): RichText {
    return new RichText(html, RichText.toPlainText(html));
  }

  static fromPlain(text: string): RichText {
    return new RichText(text, text.trim());
  }

  /**
   * Conversão deliberadamente simples: sem parser de DOM, sem dependência.
   * Só precisa ser boa o bastante para busca full-text e casamento de
   * dicionário — não para renderizar.
   */
  private static toPlainText(html: string): string {
    let out = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
    out = out.replace(BLOCK_TAGS, "\n");
    out = out.replace(ANY_TAG, " ");
    for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
    return out
      .replace(/[ \t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }
}
