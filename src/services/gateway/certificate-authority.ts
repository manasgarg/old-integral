import { access, readFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { atomicWrite, ensureDir } from "../../platform/files.ts";
import type { IntegralPaths } from "../../platform/deployment-paths.ts";

const exec = promisify(execFile);
const HOST_CERTIFICATE_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const certificateWork = new Map<
  string,
  Promise<{ key: string; cert: string }>
>();

export interface CaFiles {
  key: string;
  cert: string;
  bundle: string;
}

export async function ensureCa(paths: IntegralPaths): Promise<CaFiles> {
  await ensureDir(paths.ca);
  const key = join(paths.ca, "integral-ca.key"),
    cert = join(paths.ca, "integral-ca.pem"),
    bundle = join(paths.ca, "ca-bundle.pem");

  try {
    await access(key);
    await access(cert);
  } catch {
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-nodes",
      "-days",
      "3650",
      "-subj",
      "/CN=integral local gateway CA",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
  }

  const integral = await readFile(cert);
  let system = Buffer.alloc(0);
  try {
    system = await readFile("/etc/ssl/certs/ca-certificates.crt");
  } catch {
    /* platform without this bundle */
  }

  await atomicWrite(
    bundle,
    Buffer.concat([system, Buffer.from("\n"), integral]),
  );

  return { key, cert, bundle };
}

export async function certificateFor(
  paths: IntegralPaths,
  host: string,
  ca: CaFiles,
  options: { now?: () => number } = {},
): Promise<{ key: string; cert: string }> {
  const id = createHash("sha256").update(host).digest("hex");
  const workId = `${paths.ca}:${id}`;
  const active = certificateWork.get(workId);
  if (active) return active;

  const work = ensureHostCertificate(
    paths,
    host,
    ca,
    id,
    options.now ?? Date.now,
  );
  certificateWork.set(workId, work);
  try {
    return await work;
  } finally {
    certificateWork.delete(workId);
  }
}

async function ensureHostCertificate(
  paths: IntegralPaths,
  host: string,
  ca: CaFiles,
  id: string,
  now: () => number,
): Promise<{ key: string; cert: string }> {
  const dir = join(paths.ca, "hosts");
  await ensureDir(dir);
  const key = join(dir, `${id}.key`),
    cert = join(dir, `${id}.pem`);

  let hasKey = true;
  try {
    await access(key);
  } catch {
    hasKey = false;
  }

  if (hasKey) {
    try {
      const parsed = new X509Certificate(await readFile(cert)),
        observedAt = now();
      if (
        Date.parse(parsed.validFrom) <= observedAt &&
        Date.parse(parsed.validTo) - observedAt >
          HOST_CERTIFICATE_RENEWAL_WINDOW_MS
      )
        return { key, cert };
    } catch {
      /* replace a missing or invalid cached certificate */
    }
  }

  const suffix = randomUUID(),
    temporaryKey = join(dir, `.${id}.${suffix}.key`),
    csr = join(dir, `.${id}.${suffix}.csr`),
    temporaryCert = join(dir, `.${id}.${suffix}.pem`),
    ext = join(dir, `.${id}.${suffix}.ext`);
  const san = /^[\d.:]+$/.test(host) ? `IP:${host}` : `DNS:${host}`;

  try {
    await atomicWrite(
      ext,
      `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`,
    );

    await exec(
      "openssl",
      hasKey
        ? ["req", "-new", "-key", key, "-subj", `/CN=${host}`, "-out", csr]
        : [
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            `/CN=${host}`,
            "-keyout",
            temporaryKey,
            "-out",
            csr,
          ],
    );

    await exec("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca.cert,
      "-CAkey",
      ca.key,
      "-CAcreateserial",
      "-days",
      "30",
      "-sha256",
      "-extfile",
      ext,
      "-out",
      temporaryCert,
    ]);

    if (!hasKey) await rename(temporaryKey, key);
    await rename(temporaryCert, cert);
    return { key, cert };
  } finally {
    await Promise.all(
      [temporaryKey, csr, temporaryCert, ext].map((path) =>
        rm(path, { force: true }),
      ),
    );
  }
}
