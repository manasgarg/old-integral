import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditLifecycleSpecs } from "../scripts/check-lifecycle-specs.ts";

const behavior = `# Sample

## SAMPLE-1234ABCD — Start the sample

\`\`\`text
Given nothing is running
	When the sample starts
		Then it runs
\`\`\`
`;

function lifecycle(transitions: string, diagram: string): string {
  return `# Sample lifecycle

## Ownership

- **Owner:** the sample component.

## States

| State | Meaning | Recorded in | After a crash |
| --- | --- | --- | --- |
| \`absent\` | Nothing runs. | Nothing. | Nothing. |
| \`running\` | It runs. | Memory. | Nothing. |

## Events

| Event | Source |
| --- | --- |
| \`start\` | A command. |
| \`stop\` | A command. |

## Transitions

| From | Event | To | Outcome | Contract |
| --- | --- | --- | --- | --- |
${transitions}

## Invariants

- At most one sample runs. open

## Restart reconciliation

- Nothing survives.

## Diagram

\`\`\`mermaid
stateDiagram-v2
${diagram}
\`\`\`
`;
}

async function fixture(t: test.TestContext, spec: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "integral-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "behavior", "lifecycle"), { recursive: true });
  await writeFile(join(root, "behavior", "sample.md"), behavior);
  await writeFile(join(root, "behavior", "lifecycle", "sample.md"), spec);
  return root;
}

test("the repository's lifecycle specifications are complete and consistent", async () => {
  const audit = await auditLifecycleSpecs();
  assert.deepEqual(audit.errors, []);
  assert.ok(audit.resourceCount > 0);
  assert.equal(
    audit.pairCount,
    audit.specifiedPairCount +
      audit.impossiblePairCount +
      audit.ignoredPairCount +
      audit.openPairCount,
  );
});

test("lifecycle check accepts a table that settles every state and event pair", async (t) => {
  const root = await fixture(
    t,
    lifecycle(
      [
        "| `absent` | `start` | `running` | It runs. | SAMPLE-1234ABCD |",
        "| `running` | `start` | — | Already running. | ignored |",
        "| `absent` | `stop` | — | Nothing to stop. | ignored |",
        "| `running` | `stop` | ? | Should it drain first? | open |",
      ].join("\n"),
      "  absent --> running : start",
    ),
  );
  const audit = await auditLifecycleSpecs(root);

  assert.deepEqual(audit.errors, []);
  assert.equal(audit.pairCount, 4);
  assert.equal(audit.specifiedPairCount, 1);
  assert.equal(audit.ignoredPairCount, 2);
  assert.equal(audit.openPairCount, 1);
});

test("lifecycle check reports missing pairs, unknown behaviors, and diagram drift", async (t) => {
  const root = await fixture(
    t,
    lifecycle(
      [
        "| `absent` | `start` | `running` | It runs. | SAMPLE-FFFFFFFF |",
        "| `absent`, `running` | `stop` | — | Nothing to stop. | ignored |",
      ].join("\n"),
      "  running --> absent : stop",
    ),
  );
  const { errors } = await auditLifecycleSpecs(root);

  assert.ok(
    errors.some((error) =>
      error.includes("no transition for running on start"),
    ),
  );
  assert.ok(
    errors.some((error) => error.includes("unknown behavior SAMPLE-FFFFFFFF")),
  );
  assert.ok(
    errors.some((error) =>
      error.includes("diagram is missing absent -> running on start"),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes("diagram draws running -> absent on stop"),
    ),
  );
});

test("lifecycle check rejects a pair specified twice or a contract without a decision", async (t) => {
  const root = await fixture(
    t,
    lifecycle(
      [
        "| `absent` | `start` | `running` | It runs. | SAMPLE-1234ABCD |",
        "| `absent` | `start` | — | Duplicate. | ignored |",
        "| `running` | `start` | — | Unclear. | maybe |",
        "| `absent`, `running` | `stop` | `absent` | Stops. | impossible |",
      ].join("\n"),
      "  absent --> running : start",
    ),
  );
  const { errors } = await auditLifecycleSpecs(root);

  assert.ok(
    errors.some((error) =>
      error.includes("absent on start is specified more than once"),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        "must cite behavior IDs or say impossible, ignored, or open",
      ),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes("impossible transition on stop must use —"),
    ),
  );
});
