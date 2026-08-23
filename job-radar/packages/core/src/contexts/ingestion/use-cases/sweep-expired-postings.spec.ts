import { describe, expect, it } from "vitest";
import type { JobPosting } from "../domain/entities/job-posting.js";
import {
  JobRepository,
  type RunCounters,
  RunRegistry,
  type UpsertOutcome,
} from "../domain/ports/repositories.port.js";
import { SweepExpiredPostingsUseCase } from "./sweep-expired-postings.use-case.js";

const RUN_ID = "2026-08-23T06:00:00-a1b2c3d4";
const SOURCE_ID = "gupy";

/** Registra o que foi pedido em vez de expirar de verdade — a asserção é a chamada. */
class SpyJobRepository extends JobRepository {
  readonly expireCalls: Array<{ sourceId: string; runId: string }> = [];

  constructor(private readonly expiredCount = 0) {
    super();
  }

  async upsert(_posting: JobPosting, _runId: string): Promise<UpsertOutcome> {
    throw new Error("o sweeper não escreve vagas");
  }

  async expireNotSeenIn(sourceId: string, runId: string): Promise<number> {
    this.expireCalls.push({ sourceId, runId });
    return this.expiredCount;
  }
}

class FakeRunRegistry extends RunRegistry {
  constructor(private readonly counters: RunCounters | null) {
    super();
  }

  async startRun(): Promise<void> {}
  async recordSuccess(): Promise<void> {}
  async recordFailure(): Promise<void> {}

  async get(): Promise<RunCounters | null> {
    return this.counters;
  }

  async lastRunId(): Promise<string | null> {
    return RUN_ID;
  }
}

function countersOf(completed: number, failed: number): RunCounters {
  return { completed, failed, startedAt: "2026-08-23T06:00:00.000Z" };
}

describe("SweepExpiredPostingsUseCase — rodada íntegra", () => {
  it("expira o que a rodada não devolveu quando nada falhou", async () => {
    const repository = new SpyJobRepository(7);
    const useCase = new SweepExpiredPostingsUseCase(
      new FakeRunRegistry(countersOf(12, 0)),
      repository,
    );

    const result = await useCase.execute({ runId: RUN_ID, sourceId: SOURCE_ID });

    expect(result.isOk()).toBe(true);
    expect(result.unwrapOrThrow()).toEqual({ expired: 7, skipped: false });
    expect(repository.expireCalls).toEqual([{ sourceId: SOURCE_ID, runId: RUN_ID }]);
  });
});

describe("SweepExpiredPostingsUseCase — a guarda", () => {
  it("NÃO expira nada quando qualquer tarefa da rodada falhou", async () => {
    // O erro clássico de agregador: a fonte oscila, metade das páginas falha, e
    // expirar "o que não foi visto" apaga o catálogo inteiro. Uma falha basta
    // para bloquear — a assimetria de custo entre não expirar e expirar errado
    // não deixa espaço para heurística de percentual.
    const repository = new SpyJobRepository(999);
    const useCase = new SweepExpiredPostingsUseCase(
      new FakeRunRegistry(countersOf(10, 1)),
      repository,
    );

    const result = await useCase.execute({ runId: RUN_ID, sourceId: SOURCE_ID });

    const output = result.unwrapOrThrow();
    expect(output.skipped).toBe(true);
    expect(output.expired).toBe(0);
    expect(output.reason).toContain("1 tarefa(s) com falha");
    expect(repository.expireCalls).toEqual([]);
  });

  it("continua bloqueando mesmo quando a rodada foi quase toda bem", async () => {
    // 199 de 200 páginas OK ainda pode ser a página que faltou concentrando
    // todas as vagas de uma empresa. Não há limiar "seguro".
    const repository = new SpyJobRepository(999);
    const useCase = new SweepExpiredPostingsUseCase(
      new FakeRunRegistry(countersOf(199, 1)),
      repository,
    );

    const output = (await useCase.execute({ runId: RUN_ID, sourceId: SOURCE_ID })).unwrapOrThrow();

    expect(output.skipped).toBe(true);
    expect(repository.expireCalls).toEqual([]);
  });

  it("NÃO expira quando a rodada não concluiu nenhuma tarefa", async () => {
    // `failed === 0 && completed === 0` é a rodada que nem começou de verdade.
    // Sem essa cláusula, uma fila que nunca foi drenada expiraria TUDO.
    const repository = new SpyJobRepository(999);
    const useCase = new SweepExpiredPostingsUseCase(
      new FakeRunRegistry(countersOf(0, 0)),
      repository,
    );

    const output = (await useCase.execute({ runId: RUN_ID, sourceId: SOURCE_ID })).unwrapOrThrow();

    expect(output.skipped).toBe(true);
    expect(output.expired).toBe(0);
    expect(output.reason).toContain("nenhuma tarefa");
    expect(repository.expireCalls).toEqual([]);
  });

  it("NÃO expira quando não existe registro da rodada", async () => {
    // Registro ausente (TTL passou, runId errado, rodada de outro ambiente) é
    // "não sei se foi íntegra" — e "não sei" nunca autoriza destruir catálogo.
    const repository = new SpyJobRepository(999);
    const useCase = new SweepExpiredPostingsUseCase(new FakeRunRegistry(null), repository);

    const output = (await useCase.execute({ runId: RUN_ID, sourceId: SOURCE_ID })).unwrapOrThrow();

    expect(output.skipped).toBe(true);
    expect(output.expired).toBe(0);
    expect(output.reason).toContain("não tem registro");
    expect(repository.expireCalls).toEqual([]);
  });
});
