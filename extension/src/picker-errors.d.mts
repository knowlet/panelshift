export type PickerFailureStage = "no-tab" | "inject" | "bridge" | "validate";

export class PickerStartFailure extends Error {
  readonly stage: PickerFailureStage;
  constructor(stage: PickerFailureStage, cause?: unknown);
}

export function pickerFailureMessage(error: unknown, url?: string): string;
