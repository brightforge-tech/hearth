// Product and clinic naming, in one place. "Hearth" is the software; the clinic
// details are the practice that runs it and are set at build time with the
// VITE_CLINIC_* variables (see .env.example). The defaults are a fictional demo
// clinic — 555 numbers and example.test addresses only. The API's e-mails take
// the clinic name from CLINIC_NAME (api/lib/brand.mjs); keep the two in step.
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const pick = (value: string | undefined, fallback: string) => (value && value.trim() ? value.trim() : fallback);

export const PRODUCT = {
  name: "Hearth",
  vendor: "BrightForge Labs",
  url: "https://github.com/brightforge-tech/hearth",
} as const;

export const BRAND = {
  name: pick(env.VITE_CLINIC_NAME, "Harbourview Medical Centre"),
  shortName: pick(env.VITE_CLINIC_SHORT_NAME, "Harbourview"),
  logo: "/brand/logo.svg",
  logoWhite: "/brand/logo-white.svg",
  // contact details shown on the public landing page
  phone: pick(env.VITE_CLINIC_PHONE, "(555) 010-0142"),
  email: pick(env.VITE_CLINIC_EMAIL, "hello@harbourview.example.test"),
  address: pick(env.VITE_CLINIC_ADDRESS, "12 Harbour Road, Example Town"),
  hours: pick(env.VITE_CLINIC_HOURS, "Mon-Fri: 9AM-5PM"),
};
