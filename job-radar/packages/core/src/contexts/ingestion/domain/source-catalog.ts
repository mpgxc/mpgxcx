import type { BusinessError } from "../../../commons/business-error.js";
import type { Result } from "../../../commons/result.js";
import { Result as R } from "../../../commons/result.js";
import { UnknownSource } from "./ingestion.errors.js";
import type { JobSourcePort } from "./ports/job-source.port.js";

/**
 * Resolve `sourceId` -> adapter. É o único lugar que conhece todos os adapters;
 * o resto do pipeline fala só com a porta.
 */
export class SourceCatalog {
  private readonly bySourceId: ReadonlyMap<string, JobSourcePort>;

  constructor(sources: readonly JobSourcePort[]) {
    this.bySourceId = new Map(sources.map((source) => [source.id, source]));
  }

  get(sourceId: string): Result<JobSourcePort, BusinessError> {
    const source = this.bySourceId.get(sourceId);
    return source ? R.ok(source) : R.err(UnknownSource.create(sourceId));
  }

  get ids(): string[] {
    return [...this.bySourceId.keys()];
  }
}
