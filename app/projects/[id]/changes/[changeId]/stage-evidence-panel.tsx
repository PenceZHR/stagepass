import type { ReactNode } from "react";

export interface StageEvidenceSection {
  id: string;
  title: string;
  count?: number;
  emptyLabel?: string;
  children: ReactNode;
}

export function StageEvidencePanel({
  title,
  description,
  actionSlot,
  loading = false,
  error = null,
  actionError = null,
  sections,
}: {
  title: string;
  description?: ReactNode;
  actionSlot?: ReactNode;
  loading?: boolean;
  error?: ReactNode;
  actionError?: ReactNode;
  sections: StageEvidenceSection[];
}) {
  const shouldRenderSections = !loading && !error;

  return (
    <section className="rounded-lg border bg-background p-4" aria-label={title} data-stage-evidence-panel>
      <header className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-medium">{title}</h3>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actionSlot ? <div className="flex flex-wrap items-center gap-2">{actionSlot}</div> : null}
      </header>

      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading...
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}
        {actionError ? (
          <p className="text-sm text-red-500" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      {shouldRenderSections ? (
        <div className="mt-4 grid gap-4">
          {sections.map((section) => (
            <section key={section.id} className="rounded-md border bg-muted/10 p-3" aria-label={section.title}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{section.title}</h4>
                {typeof section.count === "number" ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {section.count}
                  </span>
                ) : null}
              </div>
              {section.count === 0 ? (
                <StageEvidenceEmpty label={section.emptyLabel ?? "No evidence for this section yet."} />
              ) : (
                section.children
              )}
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function StageEvidenceEmpty({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed bg-background px-3 py-2 text-sm text-muted-foreground">
      {label}
    </p>
  );
}
