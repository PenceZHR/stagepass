"use client";

interface ValidationIssue {
  field: string;
  severity: string;
  message: string;
}

interface PrdEditorProps {
  prdStatus: string;
  prdContent: string | null;
  structured: Record<string, unknown> | null;
  validation: { valid: boolean; issues: ValidationIssue[] } | null;
  /** The Codex thread this PRD is discussed in, once one exists. */
  codexThreadId?: string | null;
}

/**
 * Project PRD is an artifact surface. Questions, confirmation and revision
 * decisions happen in the bound Codex task; Web only presents the durable
 * Server document and validation evidence.
 *
 * That division only works if this page can say WHICH task. It used to tell the
 * user to continue in Codex and offer no way to get there, so a project whose
 * PRD needed one more answer had nowhere to go from here.
 */
export function PrdEditor({
  prdStatus,
  prdContent,
  structured,
  validation,
  codexThreadId,
}: PrdEditorProps) {
  return (
    <section className="flex h-full flex-col rounded-lg border" data-prd-document-viewer>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <div>
          <h3 className="text-sm font-medium">PRD</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            状态：{prdStatus}。交互与确认请在绑定的 Codex task 中完成。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {structured && (
            <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900 dark:text-green-200">
              结构化
            </span>
          )}
          {codexThreadId && (
            // A plain anchor, not a fetch: `codex://` is handled by the OS, so
            // the browser hands it to Codex Desktop and the user lands in the
            // task this page keeps telling them to use.
            <a
              className="inline-flex items-center rounded border px-2 py-1 text-xs hover:bg-accent"
              href={`codex://threads/${codexThreadId}`}
              data-prd-open-in-codex
            >
              在 Codex 中打开
            </a>
          )}
        </div>
      </header>

      {validation && !validation.valid && (
        <div className="border-b bg-yellow-50 p-3 text-xs dark:bg-yellow-900/20">
          <p className="font-medium text-yellow-800 dark:text-yellow-200">校验问题：</p>
          <ul className="mt-1 list-disc pl-4">
            {validation.issues.map((issue, index) => (
              <li
                key={`${issue.field}:${index}`}
                className={issue.severity === "error" ? "text-red-600" : "text-yellow-700"}
              >
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {prdContent ? (
          <pre className="whitespace-pre-wrap text-xs">{prdContent}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            {codexThreadId
              ? "暂无 PRD 内容。用上方「在 Codex 中打开」继续这个 task。"
              : "暂无 PRD 内容，也还没有绑定的 Codex task。启动 PRD 后这里会出现打开入口。"}
          </p>
        )}
      </div>
    </section>
  );
}
