import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import type { LlmCallDetail } from "@/types/api"

export function useLlmCallDetail(id: string | null) {
  return useQuery({
    queryKey: ["llm-call-detail", id],
    // Carries both bodies, and CallCard enables/disables it as cards expand and
    // collapse — so abandoned fetches are the normal case, not the edge one.
    queryFn: ({ signal }) => apiFetch<LlmCallDetail>(`/api/spans/${id}`, undefined, { signal }),
    enabled: id != null,
  })
}
