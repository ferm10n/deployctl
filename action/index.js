import * as core from "@actions/core";
import * as github from "@actions/github";
import "./shim.js";
import {
  API,
  APIError,
  convertPatternToRegExp,
  fromFileUrl,
  parseEntrypoint,
  resolve,
  walk,
} from "./deps.js";
import process from "node:process";

// The origin of the server to make Deploy requests to.
const ORIGIN = process.env.DEPLOY_API_ENDPOINT ?? "https://dash.deno.com";

// Parse environment variables from env input (KEY=VALUE format)
function parseEnvVars(envInput) {
  if (!envInput || envInput.length === 0) {
    return null;
  }
  
  const envVars = {};
  const envLines = envInput.flatMap((line) => line.split(",")).map((line) => line.trim()).filter(Boolean);
  
  for (const line of envLines) {
    const equalIndex = line.indexOf("=");
    if (equalIndex === -1) {
      throw new Error(`Invalid environment variable format: ${line}. Expected KEY=VALUE format.`);
    }
    const key = line.slice(0, equalIndex).trim();
    const value = line.slice(equalIndex + 1);
    if (!key) {
      throw new Error(`Invalid environment variable format: ${line}. Key cannot be empty.`);
    }
    envVars[key] = value;
  }
  
  return Object.keys(envVars).length > 0 ? envVars : null;
}

async function main() {
  const projectId = core.getInput("project", { required: true });
  const entrypoint = core.getInput("entrypoint", { required: true });
  const importMap = core.getInput("import-map", {});
  const include = core.getMultilineInput("include", {});
  const exclude = core.getMultilineInput("exclude", {});
  const env = core.getMultilineInput("env", {});
  const cwd = resolve(process.cwd(), core.getInput("root", {}));

  // Parse environment variables
  const envVars = parseEnvVars(env);

  if (github.context.eventName === "pull_request") {
    const pr = github.context.payload.pull_request;
    const isPRFromFork = pr.head.repo.id !== pr.base.repo.id;
    if (isPRFromFork) {
      core.setOutput("deployment-id", "");
      core.setOutput("url", "");
      core.notice(
        "Deployments from forks are currently not supported by Deno Deploy. The deployment was skipped.",
        {
          title: "Skipped deployment on fork",
        },
      );
      return;
    }
  }

  const aud = new URL(`/projects/${projectId}`, ORIGIN);
  let token;
  try {
    token = await core.getIDToken(aud);
  } catch {
    throw "Failed to get the GitHub OIDC token. Make sure that this job has the required permissions for getting GitHub OIDC tokens (see https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#adding-permissions-settings ).";
  }
  core.info(`Project: ${projectId}`);

  let url = await parseEntrypoint(entrypoint, cwd);
  if (url.protocol === "file:") {
    const path = fromFileUrl(url);
    if (!path.startsWith(cwd)) {
      throw "Entrypoint must be in the working directory (cwd, or specified root directory).";
    }
    const entrypoint = path.slice(cwd.length);
    url = new URL(`file:///src${entrypoint}`);
  }
  core.info(`Entrypoint: ${url.href}`);

  let importMapUrl = null;
  if (importMap) {
    importMapUrl = await parseEntrypoint(importMap, cwd, "import map");
    if (importMapUrl.protocol === "file:") {
      const path = fromFileUrl(importMapUrl);
      if (!path.startsWith(cwd)) {
        throw "Import map must be in the working directory (cwd, or specified root directory).";
      }
      const importMap = path.slice(cwd.length);
      importMapUrl = new URL(`file:///src${importMap}`);
    }
    core.info(`Import map: ${importMapUrl.href}`);
  }

  core.debug(`Discovering assets in "${cwd}"`);
  const includes = include.flatMap((i) => i.split(",")).map((i) => i.trim());
  const excludes = exclude.flatMap((e) => e.split(",")).map((i) => i.trim());
  // Exclude node_modules by default unless explicitly specified
  if (!includes.some((i) => i.includes("node_modules"))) {
    excludes.push("**/node_modules");
  }
  const { manifestEntries: entries, hashPathMap: assets } = await walk(
    cwd,
    cwd,
    {
      include: includes.map(convertPatternToRegExp),
      exclude: excludes.map(convertPatternToRegExp),
    },
  );
  core.debug(`Discovered ${assets.size} assets`);

  const api = new API(`GitHubOIDC ${token}`, ORIGIN, {
    alwaysPrintDenoRay: true,
    logger: core,
  });

  const neededHashes = await api.projectNegotiateAssets(projectId, {
    entries,
  });
  core.debug(`Determined ${neededHashes.length} need to be uploaded`);

  const files = [];
  for (const hash of neededHashes) {
    const path = assets.get(hash);
    if (path === undefined) {
      throw `Asset ${hash} not found.`;
    }
    const data = await Deno.readFile(path);
    files.push(data);
  }
  const totalSize = files.reduce((acc, file) => acc + file.length, 0);
  core.info(
    `Uploading ${neededHashes.length} file(s) (total ${totalSize} bytes)`,
  );

  const manifest = { entries };
  core.debug(`Manifest: ${JSON.stringify(manifest, null, 2)}`);

  const req = {
    url: url.href,
    importMapUrl: importMapUrl?.href ?? null,
    manifest,
    event: github.context.payload,
  };
  
  // Try to include env vars in initial request if supported by API
  if (envVars) {
    req.env_vars = envVars;
  }
  const progress = await api.gitHubActionsDeploy(projectId, req, files);
  let deployment;
  for await (const event of progress) {
    switch (event.type) {
      case "staticFile": {
        const percentage = (event.currentBytes / event.totalBytes) * 100;
        core.info(
          `Uploading ${files.length} asset(s) (${percentage.toFixed(1)}%)`,
        );
        break;
      }
      case "load": {
        const progress = event.seen / event.total * 100;
        core.info(`Deploying... (${progress.toFixed(1)}%)`);
        break;
      }
      case "uploadComplete":
        core.info("Finishing deployment...");
        break;
      case "success":
        core.info("Deployment complete.");
        core.info("\nView at:");
        for (const { domain } of event.domainMappings) {
          core.info(` - https://${domain}`);
        }
        deployment = event;
        break;
      case "error":
        throw event.ctx;
    }
  }

  // Handle environment variables if not set during initial deployment
  // Note: This is a fallback while Deno Deploy API may not support env vars in GitHub Actions deployments
  if (envVars && deployment && !deployment.envVars?.length) {
    core.info("Setting environment variables...");
    try {
      const originalDeploymentId = deployment.id;
      const redeployed = await api.redeployDeployment(originalDeploymentId, {
        prod: false, // GitHub actions deployments are typically preview deployments
        env_vars: envVars,
      });
      if (redeployed) {
        // Update deployment reference and domains
        deployment = redeployed;
        core.info("Environment variables set successfully.");
        core.info("\nUpdated deployment view at:");
        for (const { domain } of redeployed.domains) {
          core.info(` - https://${domain}`);
        }
        // Clean up the original deployment without env vars
        await api.deleteDeployment(originalDeploymentId);
      }
    } catch (error) {
      core.warning(`Failed to set environment variables: ${error}`);
      // Continue with the original deployment
    }
  }

  core.setOutput("deployment-id", deployment.id);
  // Handle different domain structure based on deployment type
  const domain = deployment.domainMappings 
    ? deployment.domainMappings[0].domain 
    : deployment.domains[0];
  core.setOutput("url", `https://${domain}/`);
}

try {
  await main();
} catch (error) {
  if (error instanceof APIError) {
    core.setFailed(error.toString());
  } else {
    core.setFailed(error);
  }
}
