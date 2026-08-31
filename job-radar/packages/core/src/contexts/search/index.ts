export {
  IndexedJob,
  type IndexedJobProps,
  type IndexedSalary,
} from "./domain/entities/indexed-job.js";
export {
  type SearchHit,
  SearchIndexPort,
  type SearchIndexStatus,
  type SearchPage,
} from "./domain/ports/search-index.port.js";
export { InvalidSearchQuery, SearchWindowExceeded } from "./domain/search.errors.js";
export {
  DEFAULT_PAGE_SIZE,
  JobQuery,
  type JobQueryInput,
  MAX_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  type SalaryFilter,
  type SalaryFilterInput,
  type SearchSort,
} from "./domain/value-objects/job-query.js";
export {
  type JobChange,
  type ProjectJobChangesOutput,
  ProjectJobChangesUseCase,
} from "./use-cases/project-job-changes.use-case.js";
export { type SearchJobsOutput, SearchJobsUseCase } from "./use-cases/search-jobs.use-case.js";
