import { Skeleton } from "@/components/ui/skeleton";

export function ConversationLoadingSkeleton() {
  return (
    <section
      aria-label="Loading conversation"
      aria-busy="true"
      className="w-full px-3 pb-24 sm:px-6 lg:pb-10"
    >
      <div className="mx-auto max-w-4xl py-8 sm:py-12">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-10 w-2/3 max-w-xl" />
        <div className="mt-12 space-y-10">
          <div className="flex items-start gap-3">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="w-full max-w-2xl">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="mt-4 h-28 w-full" />
            </div>
          </div>
          <div className="ml-auto w-3/4 max-w-xl">
            <Skeleton className="ml-auto h-3 w-32" />
            <Skeleton className="mt-4 h-20 w-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
