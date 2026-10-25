import { MutationCache, QueryCache, QueryClient, type QueryKey } from "@tanstack/react-query";
import { errorMessage } from "@/lib/orpc";
import { toast } from "@/lib/toast";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /**
       * Queries refreshed after a success, before `mutateAsync` resolves: query key prefixes, or
       * "all" for changes that many views show (a revision, a node, a certificate).
       */
      invalidates?: readonly QueryKey[] | "all";
      /** Toast after a success, e.g. `m.common_saved`. */
      success?: () => string;
      /** Toasts the error; forms that show it inline leave this off. */
      toastError?: boolean;
    };
  }
}

/**
 * The console's query client. Mutations declare what they refresh and announce in `meta`, so the
 * cache does it once for all of them; `onError` sees every failed query and mutation (sign-in).
 */
export function createQueryClient({
  onError,
  retry,
}: {
  onError: (error: unknown) => void;
  retry: (count: number, error: unknown) => boolean;
}) {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        onError(error);
        if (mutation.meta?.toastError) toast.error(errorMessage(error));
      },
      onSuccess: async (_data, _variables, _context, mutation) => {
        const meta = mutation.meta;
        if (meta?.invalidates === "all") await queryClient.invalidateQueries();
        else if (meta?.invalidates)
          await Promise.all(
            meta.invalidates.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
          );
        if (meta?.success) toast.success(meta.success());
      },
    }),
    defaultOptions: { queries: { staleTime: 5_000, retry } },
  });
  return queryClient;
}
