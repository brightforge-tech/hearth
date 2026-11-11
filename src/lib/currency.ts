// The clinic's currency, read once from clinic_settings (Settings -> Clinic).
// Currency and tax are settings, not code: nothing in the UI hard-codes a
// currency. Until the settings row has loaded, the neutral default is shown.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const DEFAULT_CURRENCY = "USD";

export function useClinicCurrency(): string {
  const { data } = useQuery({
    queryKey: ["clinic-currency"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clinic_settings")
        .select("currency_code")
        .maybeSingle();
      if (error) throw error;
      return (data?.currency_code as string | undefined) || DEFAULT_CURRENCY;
    },
  });
  return data || DEFAULT_CURRENCY;
}

// Intl formatting with a safe fallback for a code Intl does not know.
export function formatMoney(amount: number, currency: string = DEFAULT_CURRENCY): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
