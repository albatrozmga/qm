import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider, dockerDaemonFailure } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";

test("Docker deployments use isolated networks and remove them on destroy", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49153\n", stderr: "" };
    return {
      code: args[1] === "inspect" ? 1 : 0,
      stdout: "",
      stderr: args[1] === "inspect" ? "No such network" : "",
    };
  };
  const store = createDeployStore();
  const first = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/one",
  });
  const second = await store.create({
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    entrypoint: "node server.js",
    snapshotDir: "/snap/two",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await provider.apply(first, first.versions[0]!);
  await provider.apply(second, second.versions[0]!);
  await provider.destroy(first);

  const firstName = `agent-deploy-${first.id.slice(0, 12)}`;
  const secondName = `agent-deploy-${second.id.slice(0, 12)}`;
  assert.ok(calls.some((args) => args.join(" ") === `network create ${firstName}-net`));
  assert.ok(calls.some((args) => args.join(" ") === `network create ${secondName}-net`));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${firstName} --network ${firstName}-net`)));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${secondName} --network ${secondName}-net`)));
  assert.ok(calls.some((args) => args.join(" ") === `network rm ${firstName}-net`));
});

test("Docker provider migrates running deployments off the legacy shared network", async () => {
  const calls: string[][] = [];
  let containerName = "";
  let connectAttempts = 0;
  let targetAttached = false;
  let legacyAttached = true;
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 0, stdout: legacyAttached ? `${containerName}\n` : "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "network" && args[1] === "connect" && ++connectAttempts === 1) {
      return { code: 1, stdout: "", stderr: "transient" };
    }
    if (args[0] === "network" && args[1] === "connect") targetAttached = true;
    if (args[0] === "network" && args[1] === "disconnect") legacyAttached = false;
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:9200\n", stderr: "" };
    if (args[0] === "inspect") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ...(legacyAttached ? { "agent-deploynet": {} } : {}),
          ...(targetAttached ? { [`${containerName}-net`]: {} } : {}),
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/legacy",
  });
  containerName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), running.endpoint);
  assert.equal(connectAttempts, 2);
  assert.ok(calls.some((args) => args.join(" ") === `network connect ${containerName}-net ${containerName}`));
  assert.ok(calls.some((args) => args.join(" ") === `network disconnect agent-deploynet ${containerName}`));
});

test("constructing a Docker provider does not inspect or migrate unrelated deployments", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };

  createDockerDeployProvider({ dockerExec });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test("an unrelated legacy migration failure does not block a new deployment", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 0, stdout: "agent-deploy-broken\n", stderr: "" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "daemon unavailable" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49153\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/new",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.doesNotReject(provider.apply(deployment, deployment.versions[0]!));
});

test("a transient target inspection failure does not report the deployment missing", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 1, stdout: "", stderr: "No such network" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "daemon unavailable" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/running",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.resolveEndpoint!(running, running.versions[0]!), /daemon unavailable/);
});

test("the daemon probe reports nothing when Docker answers", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "29.1.3\n", stderr: "" };
  };

  assert.equal(await dockerDaemonFailure({ dockerExec }), null);
  assert.deepEqual(calls, [["version", "-f", "{{.Server.Version}}"]]);
});

test("the daemon probe reports why Docker is unreachable", async () => {
  const dockerExec: DockerExec = async () => ({
    code: 1,
    stdout: "",
    stderr: "dial unix /var/run/docker.sock: connect: no such file or directory\n",
  });

  assert.equal(
    await dockerDaemonFailure({ dockerExec }),
    "dial unix /var/run/docker.sock: connect: no such file or directory",
  );
});

test("the daemon probe reports a failed probe rather than throwing", async () => {
  const dockerExec: DockerExec = async () => {
    throw new Error("spawn docker ENOENT");
  };

  assert.equal(await dockerDaemonFailure({ dockerExec }), "spawn docker ENOENT");
});

test("the daemon probe reports the exit code when Docker is silent", async () => {
  const dockerExec: DockerExec = async () => ({ code: 7, stdout: "", stderr: "" });

  assert.equal(await dockerDaemonFailure({ dockerExec }), "exit 7");
});

test("the daemon probe reports a hung daemon as a timeout", async () => {
  const dockerExec: DockerExec = async () => ({ code: -1, stdout: "", stderr: "" });

  assert.equal(await dockerDaemonFailure({ dockerExec }), "no response within 10s");
});

test("Docker deployments let the daemon pick a free host port instead of a fixed range", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49321\n[::1]:49321\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/port",
  });
  const provider = createDockerDeployProvider({ dockerExec });
  const containerName = `agent-deploy-${deployment.id.slice(0, 12)}`;

  assert.deepEqual(await provider.apply(deployment, deployment.versions[0]!), { host: "127.0.0.1", port: 49321 });
  const run = calls.find((args) => args[0] === "run")!;
  assert.equal(run[run.indexOf("-p") + 1], "127.0.0.1::8080");
  assert.ok(calls.some((args) => args.join(" ") === `port ${containerName} 8080/tcp`));
});

test("a Docker deployment that exits before publishing its port is rejected with its logs kept", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "port") return { code: 1, stdout: "", stderr: "Error: No public port '8080/tcp' published" };
    if (args[0] === "logs") return { code: 0, stdout: "", stderr: "Cannot find module 'express'\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/noport",
  });
  const provider = createDockerDeployProvider({ dockerExec });
  const containerName = `agent-deploy-${deployment.id.slice(0, 12)}`;

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /Cannot find module 'express'/);
  const portCall = calls.findIndex((args) => args[0] === "port");
  assert.ok(!calls.slice(portCall).some((args) => args.join(" ") === `rm -f ${containerName}`));
});

test("Docker endpoint resolution follows the port the running container is published on", async () => {
  let published = "127.0.0.1:49400\n";
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify({ [`${args[3]}-net`]: {} }), stderr: "" };
    if (args[0] === "port") {
      return published
        ? { code: 0, stdout: published, stderr: "" }
        : { code: 1, stdout: "", stderr: "Error: No public port '8080/tcp' published" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/restart",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 49153 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), { host: "127.0.0.1", port: 49400 });
  published = "";
  assert.equal(await provider.resolveEndpoint!(running, running.versions[0]!), null);
});

test("a transient docker port failure does not report the deployment missing", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify({ [`${args[3]}-net`]: {} }), stderr: "" };
    if (args[0] === "port") return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/daemon",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 49153 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.resolveEndpoint!(running, running.versions[0]!), /Cannot connect to the Docker daemon/);
});

test("Docker deployments get a durable data volume that outlives destroy", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49500\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/data",
    env: { DATA_DIR: "./data", PORT: "3000" },
  });
  const provider = createDockerDeployProvider({ dockerExec });

  assert.equal(provider.profile.dataDir, "/data");
  await provider.apply(deployment, deployment.versions[0]!);
  const run = calls.find((args) => args[0] === "run")!.join(" ");
  assert.ok(run.includes(`-v /snap/data:/app:ro -v agent-deploy-data-${deployment.id}:/data`));
  assert.ok(run.endsWith(`-e PORT=8080 -e DATA_DIR=/data node:24-alpine sh -c node server.js`));
  await provider.destroy(deployment);
  assert.ok(!calls.some((args) => args[0] === "volume"));
});

test("a Docker deployment that crashes on boot points the author at the data directory", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "port") return { code: 1, stdout: "", stderr: "Error: No public port '8080/tcp' published" };
    if (args[0] === "logs")
      return { code: 0, stdout: "", stderr: "Error: EROFS: read-only file system, mkdir '/app/.data'\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/ro",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /\$DATA_DIR=\/data.*EROFS/s);
});
