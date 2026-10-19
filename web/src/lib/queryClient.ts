import { QueryClient, type InvalidateOptions, type InvalidateQueryFilters, type QueryKey } from '@tanstack/react-query'

// After a change, pages invalidate the lists it touches so they're read again. TanStack Query restarts a read already
// under way only for a list that has loaded before; a first load still under way is joined instead, and its answer, read
// before the change, counts as the fresh one: Footage added while the Footage page was first loading never appeared. So
// invalidating cancels such a first load and reads the list again from the start.
export class WorkstationQueryClient extends QueryClient {
  override async invalidateQueries<TTaggedQueryKey extends QueryKey = QueryKey>(
    filters?: InvalidateQueryFilters<TTaggedQueryKey>,
    options?: InvalidateOptions,
  ): Promise<void> {
    if (filters?.refetchType !== 'none') {
      await this.cancelQueries({
        ...filters,
        fetchStatus: 'fetching',
        predicate: (query) => query.state.data === undefined && (filters?.predicate?.(query) ?? true),
      })
    }
    return super.invalidateQueries(filters, options)
  }
}
