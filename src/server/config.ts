import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function applyEnvFile(filePath: string, { override = false } = {}) {
  if (!existsSync(filePath)) return;

  const source = readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = rawLine.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = rawLine.slice(0, separatorIndex).trim();
    if (!key || (!override && process.env[key] !== undefined)) continue;

    let value = rawLine.slice(separatorIndex + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      value = value.slice(1);

      while (!value.endsWith(quote) && index < lines.length - 1) {
        index += 1;
        value += `\n${lines[index] ?? ""}`;
      }

      if (value.endsWith(quote)) {
        value = value.slice(0, -1);
      }
    }

    process.env[key] = value;
  }
}

applyEnvFile(resolve(process.cwd(), ".env"));
applyEnvFile(resolve(process.cwd(), ".env.local"), { override: true });
if (process.env.AEROPLANE_ENV_PATH) {
  applyEnvFile(resolve(process.env.AEROPLANE_ENV_PATH), { override: true });
}

const aeroplaneRepoUrl = "https://github.com/xt42io/aeroplane.git";
const legacyAeroplaneRepoUrls = new Set([
  "https://github.com/akinloluwami/aeroplane",
  "https://github.com/akinloluwami/aeroplane.git",
  "git@github.com:akinloluwami/aeroplane",
  "git@github.com:akinloluwami/aeroplane.git"
]);

function normalizeAeroplaneRepoUrl(repoUrl: string) {
  return legacyAeroplaneRepoUrls.has(repoUrl.trim()) ? aeroplaneRepoUrl : repoUrl;
}

function normalizeAeroplaneImage(image: string) {
  return image.trim().replace(/^ghcr\.io\/akinloluwami\/aeroplane(?=[:@]|$)/, "ghcr.io/xt42io/aeroplane");
}

const defaultAeroplaneImage = normalizeAeroplaneImage(process.env.AEROPLANE_IMAGE ?? "ghcr.io/xt42io/aeroplane:latest");
const aeroplaneInstallDir = process.env.AEROPLANE_INSTALL_DIR ?? "/opt/aeroplane";
const defaultImageUpdateCmd = `docker rm -f aeroplane-self-updater >/dev/null 2>&1 || true; docker run -d --name aeroplane-self-updater -v /var/run/docker.sock:/var/run/docker.sock -v ${aeroplaneInstallDir}:${aeroplaneInstallDir} -w ${aeroplaneInstallDir} ${defaultAeroplaneImage} sh -lc 'docker compose pull aeroplane && docker compose up -d --no-deps aeroplane'`;
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const caddyDataDir = process.env.CADDY_DATA_DIR ?? (process.env.CADDY_RELOAD_CMD === "true" ? "/data" : dataDir);

export const config = {
  port: Number(process.env.PORT ?? 4310),
  host: process.env.HOST ?? "0.0.0.0",
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:5173",
  controlPlaneHostname: process.env.CONTROL_PLANE_HOSTNAME?.trim().toLowerCase() ?? "",
  dataDir,
  deployDryRun: process.env.DEPLOY_DRY_RUN === "true",
  githubAccessToken: process.env.GITHUB_ACCESS_TOKEN ?? "",
  githubAppId: process.env.GITHUB_APP_ID ?? "",
  githubAppClientId: process.env.GITHUB_APP_CLIENT_ID ?? "",
  githubAppSlug: process.env.GITHUB_APP_SLUG ?? "",
  githubAppPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  gitlabBaseUrl: (process.env.GITLAB_BASE_URL ?? "https://gitlab.com").replace(/\/$/, ""),
  gitlabWebhookSecret: process.env.GITLAB_WEBHOOK_SECRET ?? "",
  buildkitHost: process.env.BUILDKIT_HOST ?? "tcp://127.0.0.1:1234",
  runtimeNetworkName: process.env.AEROPLANE_RUNTIME_NETWORK ?? "aeroplane-runtime",
  secretKey: process.env.AEROPLANE_SECRET_KEY ?? "",
  caddyConfigPath: resolve(process.env.CADDY_CONFIG_PATH ?? "data/Caddyfile"),
  caddyDataDir,
  caddyReloadCmd: process.env.CADDY_RELOAD_CMD ?? "caddy reload --config ./data/Caddyfile",
  updateRepoUrl: normalizeAeroplaneRepoUrl(process.env.AEROPLANE_UPDATE_REPO_URL ?? aeroplaneRepoUrl),
  updateRepoBranch: process.env.AEROPLANE_UPDATE_BRANCH ?? "main",
  updateRestartCmd: process.env.AEROPLANE_UPDATE_RESTART_CMD ?? "",
  imageCommitSha: process.env.AEROPLANE_COMMIT_SHA ?? "",
  imageUpdateCmd: process.env.AEROPLANE_IMAGE_UPDATE_CMD ?? defaultImageUpdateCmd
};
