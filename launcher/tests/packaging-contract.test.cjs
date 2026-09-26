const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const vm = require("node:vm");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("the public launcher command uses the Electron bootstrap", () => {
  assert.equal(repositoryManifest.scripts.launcher, "bun run scripts/start-launcher.ts");
  assert.equal(repositoryManifest.scripts.launcher, repositoryManifest.scripts.app);
});

test("the full verification gate audits launcher dependencies", () => {
  const verify = fs.readFileSync(path.join(repositoryRoot, "scripts", "verify.ts"), "utf8");
  assert.equal(manifest.scripts.audit, "bun audit");
  assert.equal(repositoryManifest.scripts["launcher:audit"], "bun run --cwd launcher audit");
  assert.match(verify, /await run\(\["run", "launcher:audit"\]\);/);
});

test("launcher publishes native packages for all supported desktop operating systems", () => {
  assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");
  assert.equal(manifest.build.artifactName, "codex-web-gpt-${version}-${os}-${arch}.${ext}");
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(
    manifest.build.mac.signIgnore,
    ["[/\\\\]Contents[/\\\\]Resources[/\\\\]runtime[/\\\\]runtime[/\\\\]bun$"],
  );
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.equal(manifest.build.win.icon, "assets/icon.ico");
  assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
  assert.ok(manifest.build.files.includes("assets/icon.png"));
  assert.ok(manifest.build.files.includes("assets/linux-appimage-runner.sh"));
  assert.ok(manifest.build.asarUnpack.includes("assets/linux-appimage-runner.sh"));
  assert.equal(manifest.build.afterPack, undefined);
  assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.ico")));
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.runAfterFinish, true);
  assert.match(manifest.build.nsis.guid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
});

test("release installers resolve checksummed native launcher assets", () => {
  const shellInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.sh"), "utf8");
  const windowsInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.ps1"), "utf8");
  const devProfile = fs.readFileSync(path.join(repositoryRoot, "src", "dev-chat", "profile.ts"), "utf8");
  const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
  for (const installer of [shellInstaller, windowsInstaller]) {
    assert.match(installer, /checksums\.txt/);
    assert.match(installer, /SHA-?256/i);
    assert.match(installer, /releases\/download/);
  }
  assert.match(shellInstaller, /PLATFORM="mac"/);
  assert.match(shellInstaller, /PLATFORM="linux"/);
  assert.match(shellInstaller, /codex-web-gpt\.desktop/);
  assert.match(shellInstaller, /--appimage-extract/);
  assert.match(packager, /-linux-x86_64\(\?=\\\.\).*?-linux-x64/);
  assert.match(packager, /const executable = "node"/);
  assert.doesNotMatch(packager, /process\.execPath/);
  assert.match(packager, /electron-builder\/out\/cli\/cli\.js/);
  assert.match(packager, /target === "--mac" && !env\.CSC_LINK && !env\.CSC_NAME/);
  assert.match(packager, /--config\.mac\.identity=-/);
  assert.match(packager, /verifySignedMacArchive\(\)/);
  assert.match(packager, /codesign[\s\S]*--verify[\s\S]*--deep[\s\S]*--strict/);
  assert.match(packager, /validateRuntimeBundle/);
  assert.doesNotMatch(packager, /electron-builder\.cmd/);
  assert.match(shellInstaller, /shell_quote\(\)/);
  assert.match(shellInstaller, /RUNNER_SOURCE/);
  assert.match(shellInstaller, /exec %s %s "\$@"/);
  assert.doesNotMatch(shellInstaller, /APPIMAGE_EXTRACT_AND_RUN=.*1/);
  assert.ok(
    shellInstaller.indexOf('chmod 0755 "$TEMP_DIR/$ASSET"')
      < shellInstaller.indexOf('"$TEMP_DIR/$ASSET" --appimage-extract'),
    "the downloaded AppImage must be executable before it is inspected",
  );
  assert.match(windowsInstaller, /codex-web-gpt-\$Version-win-\$Arch\.exe/);
  assert.match(windowsInstaller, /\[Environment\]::Is64BitOperatingSystem/);
  assert.doesNotMatch(windowsInstaller, /RuntimeInformation/);
  assert.match(windowsInstaller, /function Test-IsFullyQualifiedWindowsPath/);
  assert.match(windowsInstaller, /Test-IsFullyQualifiedWindowsPath \$InstallLocation/);
  assert.doesNotMatch(windowsInstaller, /IsPathFullyQualified/);
  const windowsPathPattern = windowsInstaller.match(/return \$Path -match '([^']+)'/)?.[1];
  assert.ok(windowsPathPattern, "the Windows installer must expose its absolute-path contract");
  const fullyQualifiedWindowsPath = new RegExp(windowsPathPattern);
  assert.equal(fullyQualifiedWindowsPath.test("C:\\Users\\tester\\Codex Web GPT"), true);
  assert.equal(fullyQualifiedWindowsPath.test("\\\\server\\share\\Codex Web GPT"), true);
  assert.equal(fullyQualifiedWindowsPath.test("C:Codex Web GPT"), false);
  assert.equal(fullyQualifiedWindowsPath.test("\\Codex Web GPT"), false);
  assert.equal(fullyQualifiedWindowsPath.test("Codex Web GPT"), false);
  assert.ok(windowsInstaller.includes(`HKCU:\\Software\\${manifest.build.nsis.guid}`));
  assert.ok(devProfile.includes(`WINDOWS_LAUNCHER_GUID = "${manifest.build.nsis.guid}"`));
  assert.match(windowsInstaller, /Get-ItemPropertyValue[\s\S]*InstallLocation/);
  assert.ok(windowsInstaller.includes(`Join-Path $InstallLocation "${manifest.build.productName}.exe"`));
  assert.match(windowsInstaller, /-ArgumentList "\/S", "\/currentuser"/);
  const packageSmoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(packageSmoke, /run\(installer, \["\/S", "\/currentuser"\]/);
  assert.match(packageSmoke, /reg\.exe[\s\S]*InstallLocation/);
});

test("packaged launcher owns a detached checksummed updater for every release platform", () => {
  const updater = fs.readFileSync(path.join(launcherRoot, "electron", "update.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(launcherRoot, "electron", "update-worker.cjs"), "utf8");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.match(updater, new RegExp(`platform === "${platform}"`));
    assert.match(worker, new RegExp(`job\\.platform === "${platform}"`));
  }
  assert.match(updater, /expectedChecksum/);
  assert.match(updater, /SHA-256 verification failed/);
  assert.match(updater, /detached:\s*true/);
  assert.match(worker, /waitForParent/);
  assert.doesNotMatch(worker, /backup/i);
});

test("Linux installer selects native assets and rejects unsupported architectures or bad checksums", {
  skip: process.platform === "win32" ? "POSIX installer" : false,
}, () => {
  if (process.platform === "win32") return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-installer-"));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  script("uname", 'case "$1" in -s) echo Linux ;; -m) echo "$TEST_MACHINE" ;; esac');
  script("pgrep", "exit 1");
  script("nohup", 'printf started > "$TEST_ROOT/started"');
  script("update-desktop-database", "exit 0");
  script("curl", `
while [ "$#" -gt 0 ]; do
  case "$1" in https:*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
printf '%s\\n' "$url" >> "$TEST_ROOT/downloads"
case "$url" in
  */checksums.txt) cp "$TEST_ROOT/checksums.txt" "$output" ;;
  *) cp "$TEST_ROOT/fixture.AppImage" "$output" ;;
esac`);
  const appImage = Buffer.from(`#!/bin/sh
set -eu
test "$1" = --appimage-extract
printf extracted > "$TEST_ROOT/extracted"
mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps squashfs-root/resources/app.asar.unpacked/assets
printf icon > squashfs-root/usr/share/icons/hicolor/512x512/apps/test.png
printf '#!/bin/sh\\nexit 0\\n' > squashfs-root/resources/app.asar.unpacked/assets/linux-appimage-runner.sh
`);
  // Use Node's real SHA-256 implementation on macOS as well as Linux.
  fs.writeFileSync(path.join(bin, "sha256sum"), `#!${process.execPath}\nconst fs = require('node:fs'); const c = require('node:crypto'); console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex') + '  ' + process.argv[2]);\n`, { mode: 0o755 });
  try {
    for (const [machine, arch, valid] of [
      ["x86_64", "x64", true], ["amd64", "x64", true],
      ["aarch64", "arm64", true], ["arm64", "arm64", true],
      ["aarch64", "arm64", false], ["armv7l", null, true],
    ]) {
      const root = path.join(scratch, `${machine}-${valid}`);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "fixture.AppImage"), appImage);
      const asset = `codex-web-gpt-1.2.3-linux-${arch}.AppImage`;
      const checksum = valid ? createHash("sha256").update(appImage).digest("hex") : "0".repeat(64);
      fs.writeFileSync(path.join(root, "checksums.txt"), `${checksum}  ${asset}\n`);
      const result = spawnSync("/bin/sh", [path.join(repositoryRoot, "scripts", "install-launcher.sh")], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TEST_MACHINE: machine, TEST_ROOT: root, CODEX_WEB_GPT_VERSION: "1.2.3",
          CODEX_WEB_GPT_LIB_DIR: path.join(root, "lib"), CODEX_WEB_GPT_BIN_DIR: path.join(root, "installed-bin"),
          CODEX_CHATGPT_WEB_HOME: path.join(root, "core"), XDG_DATA_HOME: path.join(root, "data"),
        },
      });
      if (!arch) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unsupported Linux architecture/);
        assert.equal(fs.existsSync(path.join(root, "downloads")), false);
      } else {
        assert.match(fs.readFileSync(path.join(root, "downloads"), "utf8"), new RegExp(`${asset.replaceAll(".", "\\.")}$`, "m"));
        if (valid) {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(fs.readFileSync(path.join(root, "lib", "1.2.3", "Codex Web GPT.AppImage")), appImage);
          assert.ok(fs.existsSync(path.join(root, "data", "applications", "codex-web-gpt.desktop")));
        } else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /SHA-256 verification failed/);
          assert.equal(fs.existsSync(path.join(root, "lib")), false);
          assert.equal(fs.existsSync(path.join(root, "extracted")), false);
        }
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("CI packages and smoke-launches on macOS, Windows, and Linux", () => {
  const ci = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(ci, /macos-15, ubuntu-latest, windows-latest/);
  assert.match(ci, /bun run app:package/);
  assert.match(ci, /bun run app:smoke/);
  assert.match(ci, /prepare-linux-libnotify\.sh/);
  assert.match(ci, /prepare-linux-appimage-tools\.cjs/);
  assert.match(ci, /archlinux:base/);
  assert.match(ci, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.0/);
  for (const runner of ["macos-15", "macos-15-intel", "ubuntu-latest", "ubuntu-24.04-arm", "windows-latest"]) {
    assert.match(release, new RegExp(runner));
  }
  assert.match(release, /launcher\/build\/runtime/);
  assert.match(release, /bun run app:smoke/);
  assert.match(release, /prepare-linux-libnotify\.sh/);
  assert.match(release, /prepare-linux-appimage-tools\.cjs/);
  assert.match(release, /archlinux:base/);
  assert.match(release, /runner: ubuntu-24\.04-arm\s+runtime_asset: codex-chatgpt-web-linux-arm64\.tar\.gz/);
  assert.match(release, /Verify Linux AppImage ABI on current Arch\s+if: runner\.os == 'Linux' && runner\.arch == 'X64'/);
  assert.match(release, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.0/);
  assert.match(release, /codesign --verify --deep --strict --verbose=2/);
  assert.match(release, /Codex Web GPT\.app/);
  assert.doesNotMatch(release, /gh release create[\s\S]*?--draft/);
});

test("Linux AppImage fallback uses one owned extraction and removes it on exit", {
  skip: process.platform !== "linux" ? "AppImage process identity is Linux-specific" : false,
}, () => {
  // node:test honours the `skip` option above and reports this as skipped. Bun's shim ignores that
  // option and runs the body anyway, and implements neither t.skip(), so the test read /proc on
  // macOS and failed for everyone running `bun test` locally. Returning early is the one form both
  // runners agree on.
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-appimage-runner-"));
  const runtime = path.join(root, "runtime");
  const appImage = path.join(root, "Codex Web GPT.AppImage");
  const appRunSource = path.join(root, "AppRun");
  const marker = path.join(root, "launched");
  const runner = path.join(launcherRoot, "assets", "linux-appimage-runner.sh");
  fs.mkdirSync(runtime);
  fs.writeFileSync(appRunSource, [
    "#!/bin/sh",
    `printf '%s|%s' \"$APPIMAGE\" \"$1\" > ${JSON.stringify(marker)}`,
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(appImage, [
    "#!/bin/sh",
    "if [ \"$1\" != \"--appimage-extract\" ]; then exit 99; fi",
    "mkdir -p squashfs-root",
    "cp \"$FAKE_APPRUN_SOURCE\" squashfs-root/AppRun",
    "chmod 0755 squashfs-root/AppRun",
    "",
  ].join("\n"), { mode: 0o755 });
  const fallbackRoot = path.join(runtime, `codex-web-gpt-appimage-${process.getuid?.() ?? 0}`);
  const stale = path.join(fallbackRoot, "run.stale");
  const active = path.join(fallbackRoot, "run.active");
  const ownerStart = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8")
    .replace(/^[^)]*\) /, "")
    .split(/\s+/)[19];
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "owner.pid"), `${process.pid} ${Number(ownerStart) + 1}\n`);
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, "owner.pid"), `${process.pid} ${ownerStart}\n`);
  try {
    const result = spawnSync(runner, [appImage, "hello"], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: "1",
        FAKE_APPRUN_SOURCE: appRunSource,
        XDG_RUNTIME_DIR: runtime,
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), `${appImage}|hello`);
    assert.deepEqual(fs.readdirSync(fallbackRoot), ["run.active"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux packaging stages native libnotify in an owned AppImage toolset before assembly", async () => {
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "prepare-linux-appimage-tools.cjs"), "utf8");
  const prepare = fs.readFileSync(path.join(repositoryRoot, "scripts", "prepare-linux-libnotify.sh"), "utf8");
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-linux-appimage-symbols.sh"), "utf8");
  const license = fs.readFileSync(
    path.join(repositoryRoot, "LICENSES", "libnotify-0.8.7-LGPL-2.1.md"),
    "utf8",
  );
  for (const contract of [source, prepare, smoke]) {
    assert.match(contract, /notify_notification_get_activation_app_launch_context/);
  }
  assert.match(prepare, /4be15202ec4184fce1ac15997ece5530d2be32fe9573875aeb10e3b573858748/);
  assert.match(source, /getAppImageTools\("0\.0\.0", Arch\[process\.arch\]\)/);
  assert.match(source, /APPIMAGE_TOOLS_PATH/);
  assert.match(source, /must not replace the shared download cache/);
  assert.match(smoke, /cp "\$APPIMAGE_PATH" "\$SMOKE_APPIMAGE"/);
  assert.doesNotMatch(smoke, /chmod 0755 "\$APPIMAGE_PATH"/);
  assert.match(license, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(license, /libnotify-0\.8\.7\.tar\.xz/);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-toolset-"));
  const scriptRequire = createRequire(path.join(launcherRoot, "scripts", "prepare-linux-appimage-tools.cjs"));
  const module = { exports: {} };
  let symbols = "00000100 T notify_notification_get_activation_app_launch_context\n";
  vm.runInNewContext(source, {
    module, Buffer, process,
    require: (name) => name === "node:child_process"
      ? { spawnSync: () => ({ status: 0, stdout: symbols, stderr: "" }) } : scriptRequire(name),
  });
  const { replaceToolsetLibnotify, requireLibnotifySymbol } = module.exports;
  try {
    for (const [arch, machine] of [["x64", 62], ["arm64", 183]]) {
      const library = path.join(scratch, `${arch}.so`);
      const bytes = Buffer.alloc(64);
      Buffer.from("7f454c460201", "hex").copy(bytes);
      bytes.writeUInt16LE(3, 16);
      bytes.writeUInt16LE(machine, 18);
      fs.writeFileSync(library, bytes);
      const toolsRoot = path.join(scratch, arch);
      if (arch === "x64") {
        const libDir = path.join(toolsRoot, "lib", "x64");
        fs.mkdirSync(libDir, { recursive: true });
        fs.writeFileSync(path.join(libDir, "libnotify.so.4"), "old x64 library");
      }
      const staged = replaceToolsetLibnotify(toolsRoot, library, arch);
      assert.deepEqual(fs.readFileSync(staged), bytes);
      assert.throws(() => requireLibnotifySymbol(library, arch === "arm64" ? "x64" : "arm64"), /ELF shared library/);
      symbols = "00000100 T unrelated_symbol\n";
      assert.throws(() => requireLibnotifySymbol(library, arch), /does not export/);
      symbols = "00000100 T notify_notification_get_activation_app_launch_context\n";

      if (arch === "arm64") {
        // Exercise the pinned builder's actual CLI parser, schema and file copier.
        const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
        assert.match(packager, /--config\.linux\.extraFiles\.from=\$\{library\}/);
        assert.match(packager, /--config\.linux\.extraFiles\.to=usr\/lib\/libnotify\.so\.4/);
        const parsed = scriptRequire("yargs/yargs")([
          `--config.linux.extraFiles.from=${staged}`,
          "--config.linux.extraFiles.to=usr/lib/libnotify.so.4",
        ]).parse();
        await scriptRequire("app-builder-lib/out/util/config/config.js").validateConfiguration(parsed.config, { isEnabled: false });
        const { getFileMatchers, copyFiles } = scriptRequire("app-builder-lib/out/fileMatcher.js");
        const appDir = path.join(scratch, "app");
        const matchers = getFileMatchers(parsed.config, "extraFiles", appDir, {
          macroExpander: value => value, customBuildOptions: parsed.config.linux,
          defaultSrc: scratch, globalOutDir: appDir,
        });
        await copyFiles(matchers);
        assert.deepEqual(fs.readFileSync(path.join(appDir, "usr", "lib", "libnotify.so.4")), bytes);
        assert.equal(fs.existsSync(path.join(toolsRoot, "lib", "x64")), false);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("macOS package smoke unregisters its staged app from LaunchServices", () => {
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(smoke, /Frameworks\/LaunchServices\.framework\/Support\/lsregister/);
  assert.match(smoke, /\["-u", macAppBundle\]/);
  assert.ok(
    smoke.indexOf('["-u", macAppBundle]') < smoke.indexOf("fs.rmSync(scratch"),
    "the staged app must be unregistered before its bundle is deleted",
  );
});

test("release does not publish demo or screenshot assets", () => {
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.doesNotMatch(release, /assets\/demo\.gif/);
  assert.doesNotMatch(release, /release-assets\/[^\n]*(?:demo|screenshot)/i);
});

test("Windows packages embed the checksummed Bun baseline runtime for CPUs without AVX2", () => {
  const builder = fs.readFileSync(path.join(repositoryRoot, "scripts", "build-runtime-bundle.ts"), "utf8");
  const baseline = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "prepare-windows-baseline-bun.ps1"),
    "utf8",
  );
  const mainSource = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  const supervisorSource = fs.readFileSync(path.join(launcherRoot, "electron", "runtime-supervisor.cjs"), "utf8");
  const runtimeSource = fs.readFileSync(path.join(launcherRoot, "electron", "runtime.cjs"), "utf8");
  assert.match(builder, /CODEX_CHATGPT_WEB_EMBEDDED_BUN/);
  assert.match(builder, /Embedded Bun must be/);
  assert.match(builder, /if not defined NODE_USE_SYSTEM_CA set "NODE_USE_SYSTEM_CA=1"/);
  assert.match(mainSource, /process\.env\.NODE_USE_SYSTEM_CA \?\?= "1"/);
  assert.match(supervisorSource, /NODE_USE_SYSTEM_CA: "1"/);
  assert.match(runtimeSource, /environment\.NODE_USE_SYSTEM_CA = "1"/);
  assert.match(baseline, /bun-windows-x64-baseline\.zip/);
  assert.match(baseline, /SHASUMS256\.txt/);
  assert.match(baseline, /Get-FileHash[^\n]+SHA256/);
  assert.match(baseline, /CODEX_CHATGPT_WEB_EMBEDDED_BUN=/);
});
