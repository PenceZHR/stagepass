export const STAGEPASS_INTERACTION_RESOURCE_URI =
  "ui://stagepass/interaction-v1" as const;

export const PRESENT_TOOL_META = {
  ui: {
    resourceUri: STAGEPASS_INTERACTION_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  "openai/widgetAccessible": true,
} as const;
export const STATUS_TOOL_META = {
  ui: {
    visibility: ["model", "app"],
  },
  "openai/widgetAccessible": true,
} as const;

export const SUBMIT_TOOL_META = {
  ui: {
    resourceUri: STAGEPASS_INTERACTION_RESOURCE_URI,
    visibility: ["app"],
  },
  "openai/visibility": "private",
} as const;

export const CONTINUE_TOOL_META = {
  ui: {
    resourceUri: STAGEPASS_INTERACTION_RESOURCE_URI,
    visibility: ["app"],
  },
  "openai/visibility": "private",
} as const;
