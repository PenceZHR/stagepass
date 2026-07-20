import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        outline: "border border-border text-foreground",
        success: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
        warning: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
        destructive: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
        info: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
        pending: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
        blocked: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
