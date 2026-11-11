import type { IntegralPaths } from "../platform/deployment-paths.ts";
import {
  adoptResourceIdentity,
  previewAdoption,
  type BackingIdentity,
} from "../stores/resource-store.ts";

/** The terminal `integral connection adopt` talks to. */
export interface AdoptTerminal {
  write(text: string): void;
  ask(question: string): Promise<string>;
}

const describe = (identity: BackingIdentity) =>
  `device ${identity.device}, inode ${identity.inode}`;

/**
 * Show what adopting `name`'s replaced backing directory would change, ask for
 * confirmation, and adopt it. Returns the process exit code.
 */
export async function adoptConnection(
  paths: IntegralPaths,
  name: string,
  terminal: AdoptTerminal,
  sessionRunning: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const { record, current } = await previewAdoption(paths, name);

  terminal.write(
    `${name} is unavailable because the directory at its recorded path was replaced.\n` +
      `  path:     ${record.path}\n` +
      `  recorded: ${describe(record.identity)}\n` +
      `  now:      ${describe(current)}\n` +
      `Adopting trusts the directory now at that path as ${name}'s content. ` +
      `Adopt only if you know why it changed, for example a restore from a backup.\n`,
  );

  const answer = await terminal.ask(
    `Adopt the directory now at that path as ${name}? [y/N] `,
  );
  if (!/^(y|yes)$/i.test(answer.trim())) {
    terminal.write("Connection unchanged.\n");
    return 0;
  }

  const adopted = await adoptResourceIdentity(
    paths,
    name,
    { revision: record.revision, identity: current },
    sessionRunning,
  );
  terminal.write(
    `Adopted ${name} at revision ${adopted.revision}; sessions started from now on use it.\n`,
  );
  return 0;
}
