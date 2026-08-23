export {
  type Company,
  JobPosting,
  type JobPostingProps,
  PostingStatus,
  type SourceId,
  type SourceRef,
} from "./domain/entities/job-posting.js";
export {
  InvalidSourceConfig,
  SourceContractDrift,
  SourceUnavailable,
  UnknownSource,
} from "./domain/ingestion.errors.js";
export {
  type CacheMetadata,
  type FetchOutcome,
  type FetchTask,
  JobSourcePort,
  type RawBatch,
  type SourceConfig,
} from "./domain/ports/job-source.port.js";
export {
  FetchCacheStore,
  JobRepository,
  type RawObjectRef,
  RawStorage,
  type RunCounters,
  RunRegistry,
  SourceRegistry,
  type UpsertOutcome,
  WorkQueue,
} from "./domain/ports/repositories.port.js";
export { SourceCatalog } from "./domain/source-catalog.js";
export { Location, RemoteMode } from "./domain/value-objects/location.js";
export {
  Compensation,
  type Currency,
  Money,
  type SalaryPeriod,
} from "./domain/value-objects/money.js";
export { RichText } from "./domain/value-objects/rich-text.js";
export { inferSeniority, Seniority } from "./domain/value-objects/seniority.js";
export { extractStack } from "./domain/value-objects/tech.js";
export {
  type DiscoverSourceWorkInput,
  type DiscoverSourceWorkOutput,
  DiscoverSourceWorkUseCase,
} from "./use-cases/discover-source-work.use-case.js";
export {
  type FetchSourceBatchInput,
  type FetchSourceBatchOutput,
  FetchSourceBatchUseCase,
} from "./use-cases/fetch-source-batch.use-case.js";
export {
  type NormalizeAndStoreInput,
  type NormalizeAndStoreOutput,
  NormalizeAndStoreUseCase,
} from "./use-cases/normalize-and-store.use-case.js";
export {
  type SweepExpiredPostingsInput,
  type SweepExpiredPostingsOutput,
  SweepExpiredPostingsUseCase,
} from "./use-cases/sweep-expired-postings.use-case.js";
