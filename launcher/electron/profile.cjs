const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const PRODUCTION_PROFILE = "production";
const DEVELOPMENT_PROFILE = "development";

function sameResolvedPath(left, right) {
  const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function resolveUserPath(value, homeDir = os.homedir()) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homeDir, value.slice(2));
  }
  return path.resolve(value);
}

function resolveLauncherProfile({
  argv = process.argv,
  env = process.env,
  homeDir = os.homedir(),
  appData,
} = {}) {
  if (typeof appData !== "string" || !path.isAbsolute(appData)) {
    throw new Error("Launcher profile resolution requires an absolute appData path");
  }
  const development = argv.includes("--dev-profile");
  if (!development) {
    const defaultCoreHome = path.join(homeDir, ".codex-chatgpt-web");
    const defaultUserData = path.join(appData, "Codex Web GPT");
    const explicitUserData = env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR?.trim()
      ? resolveUserPath(env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR.trim(), homeDir) : null;
    const coreHome = env.CODEX_CHATGPT_WEB_HOME?.trim()
      ? resolveUserPath(env.CODEX_CHATGPT_WEB_HOME.trim(), homeDir)
      : explicitUserData && !sameResolvedPath(explicitUserData, defaultUserData)
        ? path.join(explicitUserData, "core") : defaultCoreHome;
    const userData = explicitUserData
      ?? (sameResolvedPath(coreHome, defaultCoreHome) ? defaultUserData : path.join(coreHome, "launcher"));
    if (sameResolvedPath(coreHome, defaultCoreHome) !== sameResolvedPath(userData, defaultUserData)) {
      throw new Error("Custom launcher profiles require separate core and launcher data homes");
    }
    const custom = !sameResolvedPath(coreHome, defaultCoreHome);
    const namespace = createHash("sha256").update(`${coreHome.toLowerCase()}\n${userData.toLowerCase()}`).digest("hex").slice(0, 16);
    return {
      kind: PRODUCTION_PROFILE,
      displayName: "Codex Web GPT",
      coreHome,
      codexHome: env.CODEX_HOME?.trim()
        ? resolveUserPath(env.CODEX_HOME.trim(), homeDir)
        : path.join(homeDir, ".codex"),
      userData,
      browserPartition: custom ? `persist:codex-web-gpt-custom-${namespace}-chatgpt` : "persist:codex-web-gpt-chatgpt",
    };
  }

  const coreHome = env.CODEX_WEB_GPT_DEV_HOME?.trim()
    ? resolveUserPath(env.CODEX_WEB_GPT_DEV_HOME.trim(), homeDir)
    : path.join(homeDir, ".codex-chatgpt-web-dev");
  const productionHome = env.CODEX_CHATGPT_WEB_HOME?.trim()
    ? resolveUserPath(env.CODEX_CHATGPT_WEB_HOME.trim(), homeDir)
    : path.join(homeDir, ".codex-chatgpt-web");
  if (sameResolvedPath(coreHome, productionHome)) {
    throw new Error("DEV profile home must differ from the production codex-chatgpt-web home");
  }
  return {
    kind: DEVELOPMENT_PROFILE,
    displayName: "Codex Web GPT DEV",
    coreHome,
    codexHome: path.join(coreHome, "codex-home"),
    userData: path.join(coreHome, "launcher"),
    browserPartition: "persist:codex-web-gpt-dev-chatgpt",
  };
}

module.exports = {
  DEVELOPMENT_PROFILE,
  PRODUCTION_PROFILE,
  resolveLauncherProfile,
};
