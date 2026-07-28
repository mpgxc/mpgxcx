import { describe, expect, it } from "vitest";
import { Location } from "../value-objects/location.js";
import { Compensation, Money } from "../value-objects/money.js";
import { RichText } from "../value-objects/rich-text.js";
import { JobPosting, type JobPostingProps, PostingStatus } from "./job-posting.js";

const SEEN_AT = new Date("2026-07-28T00:00:00.000Z");

function makeProps(overrides: Partial<JobPostingProps> = {}): JobPostingProps {
  return {
    source: { id: "gupy", externalId: "123", url: "https://x.gupy.io/job/123" },
    company: { name: "ACME", slug: "acme" },
    title: "Desenvolvedor Backend Sênior",
    description: RichText.fromPlain("Node.js, AWS e PostgreSQL"),
    location: Location.fromRaw("São Paulo, Brasil"),
    compensation: null,
    employmentType: "FULL_TIME",
    postedAt: new Date("2026-07-01T00:00:00.000Z"),
    seenAt: SEEN_AT,
    ...overrides,
  };
}

describe("JobPosting.id — identidade determinística", () => {
  it("é estável entre execuções para a mesma (fonte, idExterno)", () => {
    // É isso que torna a ingestão idempotente: reprocessar o mesmo payload
    // (replay do S3, retry do SQS) nunca cria duplicata.
    const a = JobPosting.create(makeProps());
    const b = JobPosting.create(makeProps());

    expect(a.id).toBe(b.id);
  });

  it("não depende de campos voláteis como seenAt", () => {
    const a = JobPosting.create(makeProps({ seenAt: new Date("2026-01-01") }));
    const b = JobPosting.create(makeProps({ seenAt: new Date("2026-12-31") }));

    expect(a.id).toBe(b.id);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("difere quando a fonte difere, mesmo com o mesmo id externo", () => {
    const gupy = JobPosting.create(makeProps());
    const other = JobPosting.create(
      makeProps({ source: { id: "greenhouse", externalId: "123", url: "https://x" } }),
    );

    expect(gupy.id).not.toBe(other.id);
  });
});

describe("JobPosting.contentHash — detecção de mudança", () => {
  it("não muda quando nada relevante mudou", () => {
    const before = JobPosting.create(makeProps());
    const after = JobPosting.create(makeProps());

    expect(after.hasChangedFrom(before.contentHash)).toBe(false);
  });

  it("muda quando o título muda", () => {
    const before = JobPosting.create(makeProps());
    const after = JobPosting.create(makeProps({ title: "Desenvolvedor Backend Pleno" }));

    expect(after.hasChangedFrom(before.contentHash)).toBe(true);
  });

  it("muda quando a faixa salarial muda", () => {
    const before = JobPosting.create(makeProps());
    const after = JobPosting.create(
      makeProps({
        compensation: Compensation.create({
          min: Money.fromDecimal(15000, "BRL"),
          max: Money.fromDecimal(20000, "BRL"),
          period: "MONTH",
        }),
      }),
    );

    expect(after.hasChangedFrom(before.contentHash)).toBe(true);
  });

  it("trata ausência de hash anterior como mudança (vaga nova)", () => {
    expect(JobPosting.create(makeProps()).hasChangedFrom(null)).toBe(true);
  });
});

describe("JobPosting.fingerprint — dedup entre fontes", () => {
  it("agrupa a mesma vaga publicada em fontes diferentes", () => {
    const gupy = JobPosting.create(makeProps());
    const greenhouse = JobPosting.create(
      makeProps({
        source: { id: "greenhouse", externalId: "999", url: "https://boards.gh/999" },
        // Mesma empresa e vaga, grafia e pontuação diferentes.
        company: { name: "acme.", slug: "acme" },
        title: "desenvolvedor  backend  sênior",
      }),
    );

    expect(greenhouse.fingerprint).toBe(gupy.fingerprint);
    // Mas continuam sendo dois registros distintos: agrupa na leitura,
    // nunca destrói um dos lados.
    expect(greenhouse.id).not.toBe(gupy.id);
  });
});

describe("JobPosting.expire", () => {
  it("preserva identidade e conteúdo, muda só o status", () => {
    const active = JobPosting.create(makeProps());
    const expired = active.expire();

    expect(active.status).toBe(PostingStatus.ACTIVE);
    expect(expired.status).toBe(PostingStatus.EXPIRED);
    expect(expired.id).toBe(active.id);
    expect(expired.contentHash).toBe(active.contentHash);
  });
});

describe("Compensation", () => {
  it("recusa faixa com moedas divergentes", () => {
    const invalid = Compensation.create({
      min: Money.fromDecimal(1000, "BRL"),
      max: Money.fromDecimal(2000, "USD"),
      period: "MONTH",
    });

    expect(invalid).toBeNull();
  });

  it("recusa faixa invertida", () => {
    const invalid = Compensation.create({
      min: Money.fromDecimal(9000, "BRL"),
      max: Money.fromDecimal(3000, "BRL"),
      period: "MONTH",
    });

    expect(invalid).toBeNull();
  });

  it("aceita faixa aberta de um lado só", () => {
    const open = Compensation.create({ min: Money.fromDecimal(8000, "BRL"), period: "MONTH" });

    expect(open).not.toBeNull();
    expect(open?.currency).toBe("BRL");
  });

  it("guarda dinheiro em centavos inteiros", () => {
    // Ponto flutuante para valor monetário é bug esperando acontecer.
    expect(Money.fromDecimal(4500.5, "BRL")?.amountCents).toBe(450050);
    expect(Money.fromDecimal(4500.5, "BRL")?.decimal).toBe(4500.5);
  });
});
