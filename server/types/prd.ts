import { z } from "zod";

// --- 结构化 PRD Schema ---

export const PrdOpenQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  blocking: z.boolean().default(false),
  answer: z.string().nullable().optional(),
});
export type PrdOpenQuestion = z.infer<typeof PrdOpenQuestionSchema>;

export const PrdUserStorySchema = z.object({
  id: z.string(),
  persona: z.string(),
  action: z.string(),
  benefit: z.string(),
});
export type PrdUserStory = z.infer<typeof PrdUserStorySchema>;

export const PrdAcceptanceCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  testable: z.boolean().default(true),
});
export type PrdAcceptanceCriterion = z.infer<typeof PrdAcceptanceCriterionSchema>;

export const PrdFunctionalRequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(["must", "should", "could"]).default("must"),
  acceptanceCriteria: z.array(PrdAcceptanceCriterionSchema).default([]),
});
export type PrdFunctionalRequirement = z.infer<typeof PrdFunctionalRequirementSchema>;

export const PrdSourceReferenceSchema = z.object({
  name: z.string(),
  url: z.string(),
  adopted: z.array(z.string()).default([]),
  rejected: z.array(z.string()).default([]),
  rejectionReasons: z.array(z.string()).default([]),
});
export type PrdSourceReference = z.infer<typeof PrdSourceReferenceSchema>;

// 产品正文部分
export const PrdBodySchema = z.object({
  title: z.string().min(1),
  overview: z.string().min(1),
  targetUsers: z.string().min(1),
  userStories: z.array(PrdUserStorySchema).default([]),
  functionalRequirements: z.array(PrdFunctionalRequirementSchema).default([]),
  nonFunctionalRequirements: z.string().default(""),
  outOfScope: z.string().default(""),
  successMetrics: z.string().default(""),
  risks: z.string().default(""),
  openQuestions: z.array(PrdOpenQuestionSchema).default([]),
});
export type PrdBody = z.infer<typeof PrdBodySchema>;

// AI 执行附录
export const PrdAiAppendixSchema = z.object({
  implementationConstraints: z.string().default(""),
  affectedModules: z.array(z.string()).default([]),
  interfaceContracts: z.string().default(""),
  testStrategy: z.string().default(""),
  boundaryConditions: z.string().default(""),
  phaseConstraints: z.string().default(""),
});
export type PrdAiAppendix = z.infer<typeof PrdAiAppendixSchema>;

// 完整结构化 PRD
export const StructuredPrdSchema = z.object({
  version: z.literal(1),
  body: PrdBodySchema,
  aiAppendix: PrdAiAppendixSchema,
  sources: z.array(PrdSourceReferenceSchema).default([]),
});
export type StructuredPrd = z.infer<typeof StructuredPrdSchema>;

// --- 校验 ---

export const PrdValidationIssueSchema = z.object({
  field: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
});
export type PrdValidationIssue = z.infer<typeof PrdValidationIssueSchema>;

export const PrdValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(PrdValidationIssueSchema),
});
export type PrdValidationResult = z.infer<typeof PrdValidationResultSchema>;
