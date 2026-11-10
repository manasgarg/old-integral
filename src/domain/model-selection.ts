export interface ModelSelection {
  connection: string;
  provider: string;
  model: string;
  piVersion: string;
  piImage: string;
}

export type ModelChoice = ModelSelection;

export function sameSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.connection === right?.connection &&
    left?.provider === right?.provider &&
    left?.model === right?.model &&
    left?.piVersion === right?.piVersion &&
    left?.piImage === right?.piImage
  );
}

export function sameModel(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.connection === right?.connection &&
    left?.provider === right?.provider &&
    left?.model === right?.model
  );
}

export function matchModelChoices(
  choices: readonly ModelChoice[],
  terms: readonly string[],
): ModelChoice[] {
  const normalized = terms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  if (!normalized.length) return [...choices];

  return choices.filter((choice) => {
    const fields = [choice.connection, choice.provider, choice.model].map(
      (field) => field.toLowerCase(),
    );
    return normalized.every((term) =>
      fields.some((field) => field.includes(term)),
    );
  });
}
