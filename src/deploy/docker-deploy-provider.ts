import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import {
  dockerContainerNetworks,
  ensureDockerNetwork,
  spawnDockerExec,
  type DockerExec,
} from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";
import {
  appBoot,
  appGone,
  appLogs,
  appReporter,
  recentAppChecks,
  waitAppReady,
  type AppErrorSink,
  type Exec,
} from "./shared-deploy-provider.ts";

const APP_PORT = 8080;
const DATA_DIR = "/data";
const APP_READY_WINDOW_SEC = 60;
const RUN_TIMEOUT_MS = 300_000;
const DAEMON_PROBE_TIMEOUT_MS = 10_000;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
  onError?: AppErrorSink;
}

export interface DockerDaemonProbeOptions {
  docker?: string;
  dockerExec?: DockerExec;
}

export async function dockerDaemonFailure(opts: DockerDaemonProbeOptions = {}): Promise<string | null> {
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.docker ?? "docker");
  try {
    const r = await dexec(["version", "-f", "{{.Server.Version}}"], DAEMON_PROBE_TIMEOUT_MS);
    if (r.code === 0) return null;
    const stderr = r.stderr.trim();
    if (stderr) return stderr;
    return r.code < 0 ? `no response within ${DAEMON_PROBE_TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
  } catch (e) {
    return errMessage(e);
  }
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24";
  const dexec = opts.dockerExec ?? spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const execIn =
    (d: Deployment): Exec =>
    (script, timeoutSec) =>
      dexec(["exec", name(d), "sh", "-c", script], timeoutSec * 1000);
  const checked = recentAppChecks<DeployEndpoint>();
  const network = (d: Deployment) => `${name(d)}-net`;
  const dataVolume = (d: Deployment) => `agent-deploy-data-${d.id}`;
  const exists = async (d: Deployment): Promise<boolean> => (await dockerContainerNetworks(dexec, name(d))) !== null;
  const publishedPort = async (container: string): Promise<number | null> => {
    const r = await dexec(["port", container, `${APP_PORT}/tcp`]);
    if (r.code !== 0 && /no public port|no such container/i.test(r.stderr)) return null;
    const port = Number(/^127\.0\.0\.1:(\d+)$/m.exec(r.stdout)?.[1]);
    if (r.code !== 0 || !(port > 0))
      throw new Error(`docker port ${container} failed: ${(r.stderr || r.stdout).trim()}`);
    return port;
  };

  return {
    profile: { managedScaleToZero: false, dataDir: DATA_DIR },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const net = await ensureDockerNetwork(dexec, network(d));
      await dexec(["rm", "-f", name(d)]);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec(
        [
          "run",
          "-d",
          "--restart",
          "unless-stopped",
          "--name",
          name(d),
          "--network",
          net,
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "256",
          "-p",
          `127.0.0.1::${APP_PORT}`,
          "-v",
          `${version.snapshotDir}:/app:ro`,
          "-v",
          `${dataVolume(d)}:${DATA_DIR}`,
          "-w",
          "/app",
          ...envArgs,
          "-e",
          `PORT=${APP_PORT}`,
          "-e",
          `DATA_DIR=${DATA_DIR}`,
          image,
          "sh",
          "-c",
          appBoot(`cd /app; ${version.entrypoint}`, APP_PORT),
        ],
        RUN_TIMEOUT_MS,
      );
      try {
        if (r.code !== 0) throw new Error(`deploy run failed: ${r.stderr.trim()}`);
        await waitAppReady(execIn(d), {
          appPort: APP_PORT,
          windowSec: APP_READY_WINDOW_SEC,
          report: appReporter(opts.onError, d, version.env),
        });
        const port = await publishedPort(name(d));
        if (port === null) {
          const logs = await dexec(["logs", "--tail", "50", name(d)]);
          throw new Error(
            `deploy has no host port published for ${APP_PORT} (app files are read-only; write runtime state under $DATA_DIR=${DATA_DIR}): ${`${logs.stdout}${logs.stderr}`.trim()}`,
          );
        }
        return { host: "127.0.0.1", port };
      } catch (e) {
        await dexec(["rm", "-f", name(d)]);
        await dexec(["network", "rm", net]);
        throw e;
      }
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      if (!(await exists(d))) return null;
      return appLogs(execIn(d), opts.tailLines);
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await dexec(["network", "rm", network(d)]);
    },

    async resolveEndpoint(d, version): Promise<DeployEndpoint | null> {
      const cached = checked.get(d.id);
      if (cached) return cached;
      if (!(await exists(d))) return null;
      const report = appReporter(opts.onError, d, version.env);
      if (await appGone(execIn(d), { appPort: APP_PORT, report })) return null;
      const port = await publishedPort(name(d));
      if (port === null) return null;
      const endpoint = { host: "127.0.0.1", port };
      checked.set(d.id, endpoint);
      return endpoint;
    },
  };
}
