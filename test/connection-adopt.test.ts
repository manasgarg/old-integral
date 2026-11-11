import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  adoptConnection,
  type AdoptTerminal,
} from "../src/cli/connection-adopt.ts";
import type { IntegralPaths } from "../src/platform/deployment-paths.ts";
import { loadConfig } from "../src/stores/config.ts";
import { validateConnection } from "../src/stores/connection-store.ts";
import {
  addHostResource,
  readResource,
  refreshResource,
  type ResourceRecord,
} from "../src/stores/resource-store.ts";
import { fixture } from "./helpers.ts";

/** A host store whose backing directory was replaced, so it is `identity_changed`. */
async function replacedStore(t: TestContext) {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    backing = `${paths.root}-adopt-store`;
  t.after(() => rm(backing, { recursive: true, force: true }));
  t.after(() => rm(`${backing}.original`, { recursive: true, force: true }));
  await mkdir(backing);
  const added = await addHostResource(
    paths,
    validateConnection({
      name: "notes",
      kind: "host-store",
      auth: "none",
      path: backing,
      mount: "/home/pi/notes",
    }),
    config,
  );
  await replace(backing);
  const record = await refreshResource(paths, added);
  assert.equal(record.availabilityReason, "identity_changed");
  return { paths, backing, record };
}

/** Swap in a new directory at `backing`, keeping the old one alive so its inode differs. */
async function replace(backing: string) {
  await rm(`${backing}.original`, { recursive: true, force: true });
  await rename(backing, `${backing}.original`);
  await mkdir(backing);
}

async function identityOf(path: string) {
  const value = await stat(path, { bigint: true });
  return { device: String(value.dev), inode: String(value.ino) };
}

function terminal(answer: string, onAsk?: () => Promise<void>) {
  const shown: string[] = [];
  const io: AdoptTerminal = {
    write: (text) => shown.push(text),
    ask: async (question) => {
      shown.push(question);
      await onAsk?.();
      return answer;
    },
  };
  return { io, shown: () => shown.join("") };
}

const generation = async (paths: IntegralPaths) =>
  (await readFile(join(paths.state, "connection-generation"), "utf8")).trim();

const noSessions = async () => false;

/* @covers CONNECTION-7F9EFE1D
Given a host-repository or host-store connection is unavailable with `identity_changed`
	When the operator runs `integral connection adopt <name>`
		Then integral shows the recorded path and the recorded and current filesystem identities
			And warns that adoption trusts the directory now at that path
			And asks for confirmation before changing anything
	When the operator declines
		Then integral leaves the resource unchanged
	When the operator confirms
		And the directory now at the recorded path passes every other availability check
		And no running session still uses the resource
		Then integral records the current filesystem identity for the resource
			And returns it to active for sessions started afterward
			And advances its lifecycle revision and the connection generation
*/
test("[CONNECTION-7F9EFE1D] adopt shows both identities, changes nothing when declined, and activates the replacement when confirmed", async (t) => {
  const { paths, backing, record } = await replacedStore(t),
    current = await identityOf(backing);

  const declined = terminal("n");
  let unchangedWhileAsking: ResourceRecord | undefined;
  const asked = terminal("", async () => {
    unchangedWhileAsking = await readResource(paths, "notes");
  });
  assert.equal(await adoptConnection(paths, "notes", asked.io, noSessions), 0);
  assert.deepEqual(unchangedWhileAsking, record);
  assert.equal(
    await adoptConnection(paths, "notes", declined.io, noSessions),
    0,
  );
  assert.deepEqual(await readResource(paths, "notes"), record);
  const text = declined.shown();
  assert.ok(text.includes(backing));
  assert.ok(text.includes(`inode ${record.identity.inode}`));
  assert.ok(text.includes(`inode ${current.inode}`));
  assert.match(text, /trusts the directory now at that path/);
  assert.match(
    text,
    /Adopt the directory now at that path as notes\? \[y\/N\]/,
  );
  assert.match(text, /Connection unchanged/);

  const before = await generation(paths),
    confirmed = terminal("y");
  assert.equal(
    await adoptConnection(paths, "notes", confirmed.io, noSessions),
    0,
  );
  const adopted = await readResource(paths, "notes");
  assert.equal(adopted?.state, "active");
  assert.equal(adopted?.availabilityReason, undefined);
  assert.ok(adopted);
  assert.deepEqual(adopted.identity, current);
  assert.equal(adopted.revision, record.revision + 1);
  assert.equal(Number(await generation(paths)), Number(before) + 1);
  assert.match(confirmed.shown(), /Adopted notes/);
  assert.deepEqual(await refreshResource(paths, adopted), adopted);
});

/* @covers CONNECTION-7F9EFE1D
Given a host-repository or host-store connection is unavailable with `identity_changed`
	When the directory now at the recorded path fails another availability check
		Then integral reports that reason without changing the resource
	When a running session still uses the resource
		Then integral rejects the adoption until that session ends
	When the resource changes while confirmation is pending
		Then integral rejects the stale confirmation without changing the resource
*/
test("[CONNECTION-7F9EFE1D] adopt refuses an otherwise unavailable directory, a running session, and a stale confirmation", async (t) => {
  const { paths, backing, record } = await replacedStore(t);

  await chmod(backing, 0o500);
  t.after(() => chmod(backing, 0o700).catch(() => undefined));
  await assert.rejects(
    adoptConnection(paths, "notes", terminal("y").io, noSessions),
    /cannot adopt notes: its directory is read only/,
  );
  assert.deepEqual(await readResource(paths, "notes"), record);
  await chmod(backing, 0o700);

  const leases = join(paths.resourceSessions, record.id);
  await mkdir(leases, { recursive: true });
  await writeFile(join(leases, "live-session.json"), "{}\n");
  await writeFile(join(leases, "ended-session.json"), "{}\n");
  const running = async (sessionId: string) => sessionId === "live-session";
  await assert.rejects(
    adoptConnection(paths, "notes", terminal("y").io, running),
    /while session live-session is still running/,
  );
  assert.deepEqual(await readResource(paths, "notes"), record);

  await assert.rejects(
    adoptConnection(
      paths,
      "notes",
      terminal("y", () => replace(backing)).io,
      noSessions,
    ),
    /changed while adoption was pending/,
  );
  assert.deepEqual(await readResource(paths, "notes"), record);

  await rm(join(leases, "live-session.json"));
  assert.equal(
    await adoptConnection(paths, "notes", terminal("y").io, noSessions),
    0,
  );
  assert.equal((await readResource(paths, "notes"))?.state, "active");
  assert.ok((await stat(join(leases, "ended-session.json"))).isFile());
});

/* @covers CONNECTION-7F9EFE1D
Given a host-repository or host-store connection is unavailable with `identity_changed`
	When the named connection is not a host resource that is unavailable with `identity_changed`
		Then integral rejects the adoption without changing anything
*/
test("[CONNECTION-7F9EFE1D] adopt rejects anything but an identity_changed host resource", async (t) => {
  const { paths, backing } = await replacedStore(t);
  await assert.rejects(
    adoptConnection(paths, "missing", terminal("y").io, noSessions),
    /resource not found: missing/,
  );

  await rm(backing, { recursive: true });
  await rename(`${backing}.original`, backing);
  const recovered = await refreshResource(
    paths,
    (await readResource(paths, "notes"))!,
  );
  assert.equal(recovered.state, "active");
  const asked = terminal("y");
  await assert.rejects(
    adoptConnection(paths, "notes", asked.io, noSessions),
    /notes is not waiting for adoption/,
  );
  assert.equal(asked.shown(), "");
  assert.deepEqual(await readResource(paths, "notes"), recovered);
});
