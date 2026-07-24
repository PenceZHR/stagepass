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
}

/**
 * Project PRD is an artifact surface. Questions, confirmation and revision
 * decisions happen in the bound Codex task; Web only presents the durable
 * Server document and validation evidence.
 */
export function PrdEditor({
  prdStatus,
  prdContent,
  structured,
  validation,
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
        {structured && (
          <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900 dark:text-green-200">
            结构化
          </span>
        )}
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
            暂无 PRD 内容。打开项目对应的 Codex task 继续。
          </p>
        )}
      </div>
    </section>
  );
}
