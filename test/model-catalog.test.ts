import assert from "node:assert/strict";
import test from "node:test";
import {
  saveConnection,
  validateConnection,
} from "../src/stores/connection-store.ts";
import { listModelChoices } from "../src/integrations/pi/model-catalog.ts";
import {
  matchModelChoices,
  type ModelChoice,
} from "../src/domain/model-selection.ts";
import { ModelSelectionStore } from "../src/stores/conversation-store.ts";
import { fixture } from "./helpers.ts";
import { atomicWrite } from "../src/platform/files.ts";
import { readFile } from "node:fs/promises";

const choices: ModelChoice[] = [
  {
    connection: "work-codex",
    provider: "openai-codex",
    model: "gpt-5.5",
  },
  {
    connection: "work-codex",
    provider: "openai-codex",
    model: "gpt-5.4-mini",
  },
  {
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  },
];

test("[CHAT-C53A90D2] model search matches case-insensitive terms across connection, provider, and model fields", () => {
  assert.deepEqual(matchModelChoices(choices, ["CODEX", "5.5"]), [choices[0]]);
  assert.deepEqual(matchModelChoices(choices, ["anth", "sonnet"]), [
    choices[2],
  ]);
  assert.deepEqual(matchModelChoices(choices, ["gpt"]), choices.slice(0, 2));
  assert.deepEqual(matchModelChoices(choices, ["missing"]), []);
});

/* @covers BOX-E1F472A1
Given the integral release ships the Dockerfile for its Pi image
	When the model chooser lists models
		Then it discovers providers and models from the release's Pi image
*/
test("[BOX-E1F472A1] [CHAT-C53A90D2] [LOG-28BE37DE] active model connections expose choices and report discovery progress without credentials", async (t) => {
  const paths = await fixture(t);
  await saveConnection(
    paths,
    validateConnection({
      name: "personal",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  const progress: string[] = [],
    catalog = await listModelChoices(
      paths,
      {
        ensureRuntime: async () => ({
          version: "1.2.3",
          packageRoot: "/unused",
        }),
        ensureImage: () => "sha256:catalog",
        discoverModels: async () => [
          { provider: "anthropic", model: "claude-sonnet-4-6" },
        ],
      },
      (stage) => progress.push(stage),
    ),
    available = catalog.choices;
  assert.deepEqual(progress, [
    "runtime.resolve",
    "runtime.ready",
    "image.resolve",
    "image.ready",
    "models.discover",
    "models.ready",
  ]);
  assert.equal(catalog.piVersion, "1.2.3");
  assert.ok(available.length > 0);
  assert.ok(
    available.every(
      (choice) =>
        choice.connection === "personal" && choice.provider === "anthropic",
    ),
  );
  assert.ok(available.some((choice) => /claude/i.test(choice.model)));
  assert.ok(
    available.every((choice) => !Object.values(choice).includes("secret")),
  );
});

test("[CHAT-6E91B4C7] conversation model selection is durable outside main configuration", async (t) => {
  const paths = await fixture(t),
    selection = {
      connection: "personal",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
    first = new ModelSelectionStore(paths.modelSelection);
  await first.set(selection);
  const restored = new ModelSelectionStore(paths.modelSelection);
  await restored.load();
  assert.deepEqual(restored.get(), selection);
  assert.notEqual(paths.modelSelection, paths.mainConfig);
});

/* @covers BOX-E1F472A1
Given the conversation has a model selection
	When integral records the model selection
		Then it records only the model connection, provider, and model
			And ignores a Pi version or image that an earlier release recorded with the selection
*/
test("[BOX-E1F472A1] [CHAT-6E91B4C7] a model selection never records a Pi version or image", async (t) => {
  const paths = await fixture(t),
    store = new ModelSelectionStore(paths.modelSelection);
  await store.set({
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    piVersion: "0.85.1",
    piImage: "sha256:older-release",
  } as ModelChoice);
  assert.deepEqual(JSON.parse(await readFile(paths.modelSelection, "utf8")), {
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });

  await atomicWrite(
    paths.modelSelection,
    `${JSON.stringify({
      connection: "personal",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      piVersion: "0.85.1",
      piImage: "sha256:older-release",
    })}\n`,
  );
  const restored = new ModelSelectionStore(paths.modelSelection);
  await restored.load();
  assert.deepEqual(restored.get(), {
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
});
