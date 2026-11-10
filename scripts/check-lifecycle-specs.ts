import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const behaviorIdPattern = /\b[A-Z]+-[0-9A-F]{8}\b/g;
const namePattern = /^`([a-z][a-z0-9-]*)`$/;
const contractKeywords = new Set(["impossible", "ignored", "open"]);
const requiredSections = [
  "Ownership",
  "States",
  "Events",
  "Transitions",
  "Invariants",
  "Restart reconciliation",
  "Diagram",
];

export interface LifecycleAudit {
  resourceCount: number;
  pairCount: number;
  specifiedPairCount: number;
  impossiblePairCount: number;
  ignoredPairCount: number;
  openPairCount: number;
  errors: string[];
}

interface Transition {
  from: string[];
  event: string;
  to: string;
  contract: string;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await markdownFiles(path);
      return entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

async function knownBehaviorIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of await markdownFiles(join(root, "behavior"))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/^## ([A-Z]+-[0-9A-F]{8}) —/gm))
      ids.add(match[1]!);
  }
  return ids;
}

function section(text: string, heading: string): string | undefined {
  const start = text.search(new RegExp(`^## ${heading}$`, "m"));
  if (start < 0) return undefined;
  const rest = text.slice(start + heading.length + 4);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function tableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

function names(
  body: string | undefined,
  kind: string,
  where: string,
  errors: string[],
): Set<string> {
  const found = new Set<string>();
  if (body === undefined) {
    errors.push(`${where}: missing "## ${kind}" section`);
    return found;
  }
  for (const row of tableRows(body)) {
    const name = namePattern.exec(row[0] ?? "")?.[1];
    if (!name) errors.push(`${where}: malformed ${kind} name ${row[0]}`);
    else if (found.has(name))
      errors.push(`${where}: duplicate ${kind} name ${name}`);
    else found.add(name);
  }
  if (!found.size) errors.push(`${where}: "## ${kind}" lists nothing`);
  return found;
}

function transitions(
  body: string | undefined,
  where: string,
  errors: string[],
): Transition[] {
  if (body === undefined) {
    errors.push(`${where}: missing "## Transitions" section`);
    return [];
  }
  return tableRows(body).map((row) => {
    if (row.length !== 5)
      errors.push(`${where}: a transition row needs five cells: ${row[0]}`);
    const [from = "", event = "", to = "", outcome = "", contract = ""] = row;
    if (!outcome)
      errors.push(`${where}: transition ${from} on ${event} has no outcome`);
    return {
      from: from.split(",").map((part) => part.trim()),
      event,
      to,
      contract,
    };
  });
}

function diagramEdges(
  body: string | undefined,
  where: string,
  errors: string[],
): Set<string> {
  const edges = new Set<string>();
  if (body === undefined) {
    errors.push(`${where}: missing "## Diagram" section`);
    return edges;
  }
  for (const match of body.matchAll(
    /^\s*([a-z][a-z0-9-]*) --> ([a-z][a-z0-9-]*) : ([a-z][a-z0-9-]*)\s*$/gm,
  ))
    edges.add(`${match[1]} -> ${match[2]} on ${match[3]}`);
  return edges;
}

function auditResource(
  file: string,
  text: string,
  behaviorIds: Set<string>,
  audit: LifecycleAudit,
) {
  const errors = audit.errors;
  for (const heading of requiredSections)
    if (section(text, heading) === undefined)
      errors.push(`${file}: missing "## ${heading}" section`);

  const states = names(section(text, "States"), "States", file, errors),
    events = names(section(text, "Events"), "Events", file, errors),
    rows = transitions(section(text, "Transitions"), file, errors),
    drawn = diagramEdges(section(text, "Diagram"), file, errors),
    specified = new Set<string>(),
    seen = new Set<string>();

  for (const row of rows) {
    const event = namePattern.exec(row.event)?.[1],
      targets = row.to
        .split(" or ")
        .map((part) => namePattern.exec(part.trim())?.[1]),
      ids = [...row.contract.matchAll(behaviorIdPattern)].map((m) => m[0]),
      keyword = row.contract.toLowerCase();
    if (!event || !events.has(event)) {
      errors.push(`${file}: unknown event ${row.event}`);
      continue;
    }
    if (ids.length) {
      for (const id of ids)
        if (!behaviorIds.has(id))
          errors.push(`${file}: transition cites unknown behavior ${id}`);
      if (targets.some((to) => !to || !states.has(to)))
        errors.push(
          `${file}: transition on ${event} with a contract must name known target states, not ${row.to}`,
        );
    } else if (!contractKeywords.has(keyword))
      errors.push(
        `${file}: contract for ${row.from.join(", ")} on ${event} must cite behavior IDs or say impossible, ignored, or open`,
      );
    else if (keyword !== "open" && row.to !== "—")
      errors.push(
        `${file}: an ${keyword} transition on ${event} must use — as its target`,
      );
    else if (keyword === "open" && row.to !== "?")
      errors.push(
        `${file}: an open transition on ${event} must use ? as its target`,
      );

    for (const cell of row.from) {
      const from = namePattern.exec(cell)?.[1];
      if (!from || !states.has(from)) {
        errors.push(`${file}: unknown state ${cell} on ${event}`);
        continue;
      }
      const pair = `${from} on ${event}`;
      if (seen.has(pair))
        errors.push(`${file}: ${pair} is specified more than once`);
      seen.add(pair);
      if (ids.length) {
        audit.specifiedPairCount++;
        for (const to of targets)
          if (to && to !== from) specified.add(`${from} -> ${to} on ${event}`);
      } else if (keyword === "impossible") audit.impossiblePairCount++;
      else if (keyword === "ignored") audit.ignoredPairCount++;
      else if (keyword === "open") audit.openPairCount++;
    }
  }

  for (const state of states)
    for (const event of events) {
      audit.pairCount++;
      if (!seen.has(`${state} on ${event}`))
        errors.push(`${file}: no transition for ${state} on ${event}`);
    }

  for (const edge of specified)
    if (!drawn.has(edge)) errors.push(`${file}: diagram is missing ${edge}`);
  for (const edge of drawn)
    if (!specified.has(edge))
      errors.push(
        `${file}: diagram draws ${edge} without a specified transition`,
      );
}

export async function auditLifecycleSpecs(root = "."): Promise<LifecycleAudit> {
  const audit: LifecycleAudit = {
      resourceCount: 0,
      pairCount: 0,
      specifiedPairCount: 0,
      impossiblePairCount: 0,
      ignoredPairCount: 0,
      openPairCount: 0,
      errors: [],
    },
    behaviorIds = await knownBehaviorIds(root);

  let files: string[];
  try {
    files = (await markdownFiles(join(root, "behavior", "lifecycle"))).filter(
      (file) => !file.endsWith("README.md"),
    );
  } catch {
    return audit;
  }

  for (const file of files) {
    audit.resourceCount++;
    auditResource(
      relative(root, file),
      await readFile(file, "utf8"),
      behaviorIds,
      audit,
    );
  }

  audit.errors = [...new Set(audit.errors)].sort();
  return audit;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const audit = await auditLifecycleSpecs();
  if (audit.errors.length) {
    process.stderr.write(`${audit.errors.join("\n")}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Lifecycle inventory: ${audit.resourceCount} resources with ${audit.pairCount} state-event pairs: ${audit.specifiedPairCount} specified, ${audit.impossiblePairCount} impossible, ${audit.ignoredPairCount} ignored, ${audit.openPairCount} open.\n`,
    );
}
