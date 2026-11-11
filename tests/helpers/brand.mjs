// tests/helpers/brand.mjs — the reference builders in tests/legacy/ are written
// with the fictional demo clinic name; rebrand() swaps in whatever CLINIC_NAME
// the API was configured with, so the byte-for-byte comparisons hold either way.
import { CLINIC_NAME, DEMO_CLINIC_NAME } from '../../api/lib/brand.mjs';

export { CLINIC_NAME };

export function rebrand(text) {
  return String(text).split(DEMO_CLINIC_NAME).join(CLINIC_NAME);
}
