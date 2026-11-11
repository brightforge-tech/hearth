// api/lib/brand.mjs — names the API puts into e-mails and pages.
//
// PRODUCT_NAME is the software (Hearth). CLINIC_NAME is the practice that runs
// it: set CLINIC_NAME in the environment (and VITE_CLINIC_NAME for the web
// build, see src/lib/brand.ts). The default is a fictional demo clinic.
export const PRODUCT_NAME = 'Hearth';
export const DEMO_CLINIC_NAME = 'Harbourview Medical Centre';
export const CLINIC_NAME = (process.env.CLINIC_NAME ?? '').trim() || DEMO_CLINIC_NAME;
