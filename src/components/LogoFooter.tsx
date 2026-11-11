import { BRAND } from "@/lib/brand";

interface LogoProps {
  className?: string;
  showText?: boolean;
}

export const LogoFooter = ({ className = "h-8 w-auto", showText = true }: LogoProps) => {
  return (
    <div className="flex items-center gap-3">
      <img src={BRAND.logoWhite} alt={BRAND.name} className={className} />
      {showText && <span className="font-semibold">{BRAND.name}</span>}
    </div>
  );
};
