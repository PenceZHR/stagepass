"use client";

import type { ChangeEvent } from "react";
import { Label } from "@/components/ui/label";
import type { AiProvider } from "./pipeline-action-contract";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  codex: "Codex",
  claude: "Claude",
};

export function ProviderPicker({
  value,
  onChange,
  disabled = false,
  id = "provider-picker",
  label = "本次运行 Provider",
}: {
  value: AiProvider;
  onChange: (provider: AiProvider) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (next === "codex" || next === "claude") onChange(next);
  };

  return (
    <div className="inline-flex items-center gap-2 text-xs" data-provider-picker>
      <Label htmlFor={id} className="text-muted-foreground">{label}</Label>
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        data-provider={value}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground shadow-sm outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((provider) => (
          <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>
        ))}
      </select>
    </div>
  );
}

