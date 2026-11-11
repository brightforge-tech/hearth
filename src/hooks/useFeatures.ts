// The server's optional features (GET /api/auth/features, public). Anything
// that is off — or a failed lookup — hides the matching control.
import { useQuery } from "@tanstack/react-query";
import { apiFeatures, NO_FEATURES, type Features } from "@/lib/api";

export function useFeatures(): Features {
  const { data } = useQuery({
    queryKey: ["auth-features"],
    queryFn: apiFeatures,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return data ?? NO_FEATURES;
}
