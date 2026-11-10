import type { IntegralPaths } from "../platform/deployment-paths.ts";

/**
 * One step that rewrites a deployment's files from format `from` to
 * `from + 1`. `apply` must finish correctly when it runs again after a crash
 * stopped it partway, because the format only advances once it returns.
 */
export interface DeploymentMigration {
  from: number;
  name: string;
  apply(paths: IntegralPaths): Promise<void>;
}

export const DEPLOYMENT_MIGRATIONS: readonly DeploymentMigration[] = [
  {
    // Format 0 is every deployment created before deployment formats
    // existed. Its files already match format 1; only the format file is new,
    // and the migration runner writes that after each step.
    from: 0,
    name: "record-deployment-format",
    apply: async () => undefined,
  },
];
