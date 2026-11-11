import { PASSWORD_RULES } from "@/lib/passwordRules";

export function PasswordRules({ className = "" }: { className?: string }) {
  return (
    <div className={`text-xs text-muted-foreground ${className}`}>
      <p className="font-medium">Password rules:</p>
      <ul className="list-disc pl-5">
        {PASSWORD_RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
    </div>
  );
}

export default PasswordRules;
