import { useMutation } from "@tanstack/react-query";

/**
 * Runs one-off async work that is not a single oRPC mutation (better-auth calls, multi-step flows,
 * dialog callbacks) as a React Query mutation, so TopProgress shows it like every other mutation.
 * `pending` drives the button's Spinner; `run` resolves or rejects exactly like the work itself.
 */
export function useAction() {
  const { mutateAsync, isPending } = useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
  });
  return {
    pending: isPending,
    run: <T>(work: () => Promise<T>) => mutateAsync(work) as Promise<T>,
  };
}
