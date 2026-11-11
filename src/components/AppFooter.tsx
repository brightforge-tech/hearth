import { PRODUCT } from "@/lib/brand";

/** The disclaimer line shown at the bottom of every staff page. */
export function AppFooter() {
  return (
    <footer className="border-t mt-8">
      <div className="container mx-auto px-4 py-3 text-xs text-muted-foreground text-center">
        {PRODUCT.name} by BrightForge · Not a medical device — no clinical decision support.
      </div>
    </footer>
  );
}

export default AppFooter;
