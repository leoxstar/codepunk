import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  EXPECTED_PACKAGE_MANAGER,
  EXPECTED_ROOT_SCRIPTS,
  EXPECTED_WORKSPACE_GLOB,
  NODE_ENGINE,
  PACKAGE_BY_NAME,
  PACKAGE_SPECS,
  PROHIBITED_LIFECYCLE_SCRIPTS,
  PROHIBITED_ROOT_KEYS,
  REVIEWED_CATALOG,
  REVIEWED_INSTALL_SCRIPTS,
  ROOT_DEV_DEPENDENCIES,
  isExactVersion,
  isInside,
  npmExecutable,
  ownKeys,
  parseCatalogSpec,
  projectPath,
  sameSet,
  sameStringArrayMap,
} from "./shared.mjs";

const execFileAsync = promisify(execFile);

export function checkExports(root, spec, manifest, add) {
  const relativeManifest = `${spec.dir}/package.json`;
  const exportsValue = manifest.exports;
  if (!exportsValue || typeof exportsValue !== "object") {
    add("pkg.exports", relativeManifest, "missing exports map");
    return;
  }
  const exportKeys = ownKeys(exportsValue);
  if (!sameSet(exportKeys, ["."])) {
    add(
      "pkg.exports",
      relativeManifest,
      "only the package root export is permitted",
    );
  }
  const rootExport = exportsValue["."];
  if (
    !rootExport ||
    typeof rootExport !== "object" ||
    !sameSet(ownKeys(rootExport), ["import", "types"])
  ) {
    add(
      "pkg.exports",
      relativeManifest,
      "root export must declare exactly import and types",
    );
    return;
  }

  const importTarget = rootExport.import;
  const typesTarget = rootExport.types;
  if (
    typeof importTarget !== "string" ||
    !importTarget.startsWith("./dist/") ||
    !importTarget.endsWith(".js") ||
    importTarget.includes("*") ||
    importTarget.split("/").includes("..")
  ) {
    add("pkg.exports", relativeManifest, "invalid ESM import target");
  }
  if (
    typeof typesTarget !== "string" ||
    !typesTarget.startsWith("./dist/") ||
    !typesTarget.endsWith(".d.ts") ||
    typesTarget.includes("*") ||
    typesTarget.split("/").includes("..")
  ) {
    add(
      "pkg.exports",
      relativeManifest,
      "invalid TypeScript declaration target",
    );
  }

  const sourceEntry = path.join(root, spec.dir, "src", "index.ts");
  if (!existsSync(sourceEntry)) {
    add("pkg.exports", relativeManifest, "missing src/index.ts entry source");
  }
}

export function checkPackageManifest(
  root,
  spec,
  manifest,
  add,
  workspaceVersion,
) {
  const relativeManifest = `${spec.dir}/package.json`;
  if (manifest.name !== spec.name) {
    add("pkg.manifest", relativeManifest, `expected package name ${spec.name}`);
  }
  if (!isExactVersion(manifest.version)) {
    add(
      "pkg.manifest",
      relativeManifest,
      "package version must be an exact semantic version",
    );
  } else if (
    typeof workspaceVersion === "string" &&
    manifest.version !== workspaceVersion
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      `package version must match the workspace version ${workspaceVersion}`,
    );
  }
  if (manifest.license !== "MIT") {
    add("pkg.manifest", relativeManifest, "package license must be MIT");
  }
  if (
    manifest.repository?.url !== "git+https://github.com/leoxstar/codepunk.git"
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      "repository.url must be git+https://github.com/leoxstar/codepunk.git",
    );
  }
  if (manifest.type !== "module") {
    add("pkg.manifest", relativeManifest, "package must be ESM");
  }
  if (spec.publishable) {
    if (manifest.publishConfig?.access !== "public") {
      add(
        "pkg.manifest",
        relativeManifest,
        "publishConfig.access must be public",
      );
    }
    if (manifest.private === true) {
      add(
        "pkg.manifest",
        relativeManifest,
        "product package must be publishable",
      );
    }
    if (
      JSON.stringify(manifest.files) !== JSON.stringify(["dist", "README.md"])
    ) {
      add(
        "pkg.manifest",
        relativeManifest,
        'published files must be exactly ["dist", "README.md"]',
      );
    }
  } else {
    if (manifest.private !== true) {
      add(
        "pkg.manifest",
        relativeManifest,
        "internal workspace package must set private: true",
      );
    }
    if (manifest.publishConfig !== undefined) {
      add(
        "pkg.manifest",
        relativeManifest,
        "private workspace package must not declare publishConfig",
      );
    }
    if (manifest.files !== undefined) {
      add(
        "pkg.manifest",
        relativeManifest,
        "private workspace package must not declare files",
      );
    }
  }
  if (manifest.engines?.node !== NODE_ENGINE) {
    add("pkg.manifest", relativeManifest, `Node engine must be ${NODE_ENGINE}`);
  }
  if (manifest.scripts?.build !== spec.buildScript) {
    add(
      "pkg.manifest",
      relativeManifest,
      `missing canonical build script (${spec.buildScript})`,
    );
  }
  if (spec.dir === "packages/cli") {
    const buildScriptPath = path.join(root, spec.dir, "build.mjs");
    if (existsSync(buildScriptPath)) {
      const buildSource = readFileSync(buildScriptPath, "utf8");
      const extraExternalsMatch = buildSource.match(
        /const\s+EXTRA_EXTERNALS\s*=\s*\[([\s\S]*?)\];/u,
      );
      if (extraExternalsMatch === null) {
        add(
          "pkg.manifest",
          `${spec.dir}/build.mjs`,
          "missing EXTRA_EXTERNALS declaration",
        );
      } else {
        const extraBlock = extraExternalsMatch[1];
        for (const requiredExternal of [
          "node-pty",
          "@earendil-works/pi-agent-core",
          "@earendil-works/pi-codemode",
          "@earendil-works/pi-schema",
          "@earendil-works/pi-telemetry",
        ]) {
          if (!extraBlock.includes(`"${requiredExternal}"`)) {
            add(
              "pkg.manifest",
              `${spec.dir}/build.mjs`,
              `missing required esbuild external ${requiredExternal}`,
            );
          }
        }
      }
    }
  }
  if (
    manifest.scripts?.typecheck !== "tsc -p tsconfig.typecheck.json --noEmit"
  ) {
    add(
      "pkg.manifest",
      relativeManifest,
      "missing clean-tree typecheck script",
    );
  }
  if (!sameSet(ownKeys(manifest.scripts), ["build", "typecheck"])) {
    add(
      "pkg.manifest",
      relativeManifest,
      "package scripts must be exactly build and typecheck",
    );
  }

  const relativeTypecheck = `${spec.dir}/tsconfig.typecheck.json`;
  const typecheckPath = path.join(root, relativeTypecheck);
  if (!existsSync(typecheckPath)) {
    add(
      "pkg.manifest",
      relativeTypecheck,
      "missing clean-tree typecheck config",
    );
  } else {
    try {
      const config = JSON.parse(readFileSync(typecheckPath, "utf8"));
      if (config.extends !== "./tsconfig.json") {
        add(
          "pkg.manifest",
          relativeTypecheck,
          "typecheck config must extend the build config",
        );
      }
      if (config.compilerOptions?.noEmit !== true) {
        add(
          "pkg.manifest",
          relativeTypecheck,
          "typecheck config must disable emit",
        );
      }
      if (
        !sameStringArrayMap(
          config.compilerOptions?.paths ?? {},
          spec.typecheckPaths,
        )
      ) {
        add(
          "pkg.manifest",
          relativeTypecheck,
          "typecheck paths must resolve internal packages to source",
        );
      }
    } catch (error) {
      add(
        "pkg.manifest",
        relativeTypecheck,
        `cannot read typecheck config: ${error.message}`,
      );
    }
  }

  checkExports(root, spec, manifest, add);

  const dependencies = manifest.dependencies ?? {};
  const bundledInternalNames = spec.publishable ? spec.internal : [];
  const runtimeInternalNames = spec.publishable ? [] : spec.internal;
  const expectedDependencies = {
    ...Object.fromEntries(spec.external.map((name) => [name, "catalog:"])),
    ...Object.fromEntries(
      runtimeInternalNames.map((name) => [name, "workspace:*"]),
    ),
  };
  const expectedNames = Object.keys(expectedDependencies);
  const actualNames = Object.keys(dependencies);
  const internalPrefix = "codepunk-";

  for (const name of actualNames) {
    if (!(name in expectedDependencies)) {
      if (bundledInternalNames.includes(name)) {
        add(
          "deps.direction",
          relativeManifest,
          `bundled internal dependency ${name} must be in devDependencies, not runtime dependencies`,
        );
      } else if (name.startsWith(internalPrefix)) {
        add(
          "deps.direction",
          relativeManifest,
          `internal dependency ${name} is not allowed for ${spec.name}`,
        );
      } else {
        add(
          "deps.review",
          relativeManifest,
          `unreviewed runtime dependency ${name}`,
        );
      }
    }
  }

  for (const name of expectedNames) {
    if (!(name in dependencies)) {
      add("deps.pin", relativeManifest, `missing reviewed dependency ${name}`);
      continue;
    }
    const actualVersion = dependencies[name];
    if (actualVersion !== expectedDependencies[name]) {
      add(
        "deps.pin",
        relativeManifest,
        `${name} must use ${expectedDependencies[name]}`,
      );
    }
  }

  for (const name of runtimeInternalNames) {
    if (!(name in dependencies)) {
      add(
        "deps.direction",
        relativeManifest,
        `missing internal dependency ${name}`,
      );
    }
  }

  for (const section of ["optionalDependencies", "peerDependencies"]) {
    if (ownKeys(manifest[section]).length > 0) {
      add(
        "deps.review",
        relativeManifest,
        `${section} is not approved for product packages`,
      );
    }
  }

  const allowedBuildDevDependencies = new Set(spec.buildDevDependencies ?? []);
  const buildDevDependencies = manifest.devDependencies ?? {};
  for (const name of bundledInternalNames) {
    if (!(name in buildDevDependencies)) {
      add(
        "deps.direction",
        relativeManifest,
        `missing bundled internal devDependency ${name}`,
      );
      continue;
    }
    if (buildDevDependencies[name] !== "workspace:*") {
      add("deps.pin", relativeManifest, `${name} must use workspace:*`);
    }
  }
  for (const name of Object.keys(buildDevDependencies)) {
    if (bundledInternalNames.includes(name)) {
      continue;
    }
    if (!allowedBuildDevDependencies.has(name)) {
      add(
        "deps.review",
        relativeManifest,
        `unreviewed build-only dependency ${name}`,
      );
      continue;
    }
    if (buildDevDependencies[name] !== "catalog:") {
      add(
        "deps.review",
        relativeManifest,
        `build-only dependency ${name} must use catalog:`,
      );
    }
  }

  for (const prohibitedKey of PROHIBITED_ROOT_KEYS) {
    if (manifest[prohibitedKey] !== undefined) {
      add(
        "deps.review",
        relativeManifest,
        `manifest field ${prohibitedKey} is not approved`,
      );
    }
  }
}

export function checkRootManifest(manifest, add) {
  if (manifest.name !== "codepunk") {
    add("pkg.manifest", "package.json", "root package name must be codepunk");
  }
  if (!isExactVersion(manifest.version)) {
    add(
      "pkg.manifest",
      "package.json",
      "root version must be an exact semantic version",
    );
  }
  if (manifest.private !== true) {
    add("pkg.manifest", "package.json", "root package must be private");
  }
  if (manifest.type !== "module") {
    add("pkg.manifest", "package.json", "root package must be ESM");
  }
  if (manifest.engines?.node !== NODE_ENGINE) {
    add("pkg.manifest", "package.json", `Node engine must be ${NODE_ENGINE}`);
  }
  if (manifest.packageManager !== EXPECTED_PACKAGE_MANAGER) {
    add(
      "pkg.manifest",
      "package.json",
      `package manager must be ${EXPECTED_PACKAGE_MANAGER}`,
    );
  }
  if (manifest.workspaces !== undefined) {
    add(
      "pkg.manifest",
      "package.json",
      "workspace definitions belong in pnpm-workspace.yaml",
    );
  }
  const scripts = manifest.scripts ?? {};
  if (!sameSet(ownKeys(scripts), Object.keys(EXPECTED_ROOT_SCRIPTS))) {
    add(
      "pkg.manifest",
      "package.json",
      "root script set is not the approved gate set",
    );
  }
  for (const [script, command] of Object.entries(EXPECTED_ROOT_SCRIPTS)) {
    if (scripts[script] !== command) {
      add(
        "pkg.manifest",
        "package.json",
        `script ${script} must be exactly: ${command}`,
      );
    }
  }

  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (ownKeys(manifest[section]).length > 0) {
      add("deps.review", "package.json", `root ${section} is not allowed`);
    }
  }

  const devDependencies = manifest.devDependencies ?? {};
  if (!sameSet(Object.keys(devDependencies), ROOT_DEV_DEPENDENCIES)) {
    add(
      "deps.review",
      "package.json",
      "root development dependency set is not approved",
    );
  }
  for (const name of ROOT_DEV_DEPENDENCIES) {
    if (devDependencies[name] !== "catalog:") {
      add("deps.pin", "package.json", `${name} must use catalog:`);
    }
  }

  for (const prohibitedKey of PROHIBITED_ROOT_KEYS) {
    if (manifest[prohibitedKey] !== undefined) {
      add(
        "deps.review",
        "package.json",
        `root manifest field ${prohibitedKey} is not approved`,
      );
    }
  }

  for (const script of Object.keys(scripts)) {
    if (PROHIBITED_LIFECYCLE_SCRIPTS.has(script)) {
      add(
        "deps.review",
        "package.json",
        `lifecycle script ${script} is not approved`,
      );
    }
  }
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseWorkspaceCatalog(content) {
  const entries = {};
  const lines = content.split(/\r?\n/u);
  let inCatalog = false;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inCatalog = line.trim() === "catalog:";
      continue;
    }
    if (!inCatalog) {
      continue;
    }
    const trimmed = line.trim();
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = yamlScalar(trimmed.slice(0, separator));
    const value = yamlScalar(trimmed.slice(separator + 1));
    entries[key] = value;
  }
  return entries;
}

export async function checkPnpmWorkspace(root, add) {
  const relativePath = "pnpm-workspace.yaml";
  let content;
  try {
    content = await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    add(
      "pkg.manifest",
      relativePath,
      `cannot read pnpm workspace: ${error.message}`,
    );
    return;
  }
  const listValues = (key) => {
    const block = new RegExp(
      `^${key}:[^\\n]*\\n((?:[ \\t]+-[^\\n]*(?:\\n|$))+)`,
      "mu",
    ).exec(content)?.[1];
    return block === undefined
      ? []
      : [
          ...block.matchAll(
            /^[ \t]+-\s+["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/gmu,
          ),
        ].map((match) => match[1]);
  };
  const packagePatterns = listValues("packages");
  if (
    packagePatterns.length !== 1 ||
    packagePatterns[0] !== EXPECTED_WORKSPACE_GLOB
  ) {
    add(
      "pkg.manifest",
      relativePath,
      `workspace glob must be ${EXPECTED_WORKSPACE_GLOB}`,
    );
  }
  if (!/^linkWorkspacePackages:\s*true\s*$/mu.test(content)) {
    add(
      "pkg.manifest",
      relativePath,
      "workspace packages must be linked locally",
    );
  }
  if (
    listValues("ignoredBuiltDependencies").join("\n") !==
    ["@google/genai", "koffi", "node-pty", "protobufjs"].join("\n")
  ) {
    add(
      "pkg.manifest",
      relativePath,
      "ignored dependency build scripts differ from the reviewed set",
    );
  }
  if (!/^strictDepBuilds:\s*false\s*$/mu.test(content)) {
    add(
      "pkg.manifest",
      relativePath,
      "strict dependency build checks must stay disabled with explicit denials",
    );
  }

  const catalog = parseWorkspaceCatalog(content);
  if (!sameSet(Object.keys(catalog), Object.keys(REVIEWED_CATALOG))) {
    add(
      "deps.review",
      relativePath,
      "catalog dependency set differs from the reviewed set",
    );
  }
  for (const [name, expectedSpec] of Object.entries(REVIEWED_CATALOG)) {
    const actualSpec = catalog[name];
    if (actualSpec === undefined) {
      add("deps.pin", relativePath, `missing catalog pin for ${name}`);
      continue;
    }
    if (parseCatalogSpec(name, actualSpec) === null) {
      add(
        "deps.pin",
        relativePath,
        `catalog entry ${name} must use an exact version`,
      );
    } else if (actualSpec !== expectedSpec) {
      add(
        "deps.pin",
        relativePath,
        `catalog entry ${name} must be pinned to ${expectedSpec}`,
      );
    }
  }
}

function parsePackageIdentity(value) {
  const key = yamlScalar(value.endsWith(":") ? value.slice(0, -1) : value);
  const withoutPeers = key.replace(/\([^)]*\)$/u, "");
  const separator = withoutPeers.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  const name = withoutPeers.slice(0, separator);
  const version = withoutPeers.slice(separator + 1);
  return isExactVersion(version) ? { name, version } : undefined;
}

function parsePnpmLockDocument(documentContent) {
  const lines = documentContent.split(/\r?\n/u);
  const catalogs = new Map();
  const importers = new Map();
  const packages = new Map();
  const dependencySections = new Set([
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]);
  let lockfileVersion;
  let section;
  let catalogName;
  let catalogDep;
  let importer;
  let dependencySection;
  let dependencyName;
  let packageEntry;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      const separator = trimmed.indexOf(":");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1).trim();
      if (key === "lockfileVersion") {
        lockfileVersion = yamlScalar(value);
      }
      section = value === "" ? key : undefined;
      catalogName = undefined;
      catalogDep = undefined;
      importer = undefined;
      dependencySection = undefined;
      dependencyName = undefined;
      packageEntry = undefined;
      continue;
    }

    if (section === "catalogs") {
      if (indent === 2 && trimmed.endsWith(":")) {
        catalogName = yamlScalar(trimmed.slice(0, -1));
        catalogs.set(catalogName, {});
        catalogDep = undefined;
        continue;
      }
      if (indent === 4 && trimmed.endsWith(":") && catalogName) {
        catalogDep = yamlScalar(trimmed.slice(0, -1));
        catalogs.get(catalogName)[catalogDep] = {};
        continue;
      }
      if (indent === 6 && catalogName && catalogDep) {
        const separator = trimmed.indexOf(":");
        if (separator !== -1) {
          const key = trimmed.slice(0, separator);
          catalogs.get(catalogName)[catalogDep][key] = yamlScalar(
            trimmed.slice(separator + 1),
          );
        }
      }
      continue;
    }

    if (section === "importers") {
      if (indent === 2 && trimmed.endsWith(":")) {
        const importerPath = yamlScalar(trimmed.slice(0, -1));
        importer = {
          dependencies: {},
          devDependencies: {},
          optionalDependencies: {},
        };
        importers.set(importerPath, importer);
        dependencySection = undefined;
        dependencyName = undefined;
        continue;
      }
      if (!importer) {
        continue;
      }
      if (indent === 4 && trimmed.endsWith(":")) {
        const key = yamlScalar(trimmed.slice(0, -1));
        dependencySection = dependencySections.has(key) ? key : undefined;
        dependencyName = undefined;
        continue;
      }
      if (indent === 6 && trimmed.endsWith(":") && dependencySection) {
        dependencyName = yamlScalar(trimmed.slice(0, -1));
        importer[dependencySection][dependencyName] = {};
        continue;
      }
      if (indent === 8 && dependencyName && dependencySection) {
        const separator = trimmed.indexOf(":");
        if (separator !== -1) {
          const key = trimmed.slice(0, separator);
          importer[dependencySection][dependencyName][key] = yamlScalar(
            trimmed.slice(separator + 1),
          );
        }
      }
      continue;
    }

    if (section === "packages") {
      if (indent === 2 && trimmed.endsWith(":")) {
        const identity = parsePackageIdentity(trimmed);
        if (!identity) {
          packageEntry = undefined;
          continue;
        }
        packageEntry = { ...identity, integrity: undefined };
        if (!packages.has(identity.name)) {
          packages.set(identity.name, new Map());
        }
        packages.get(identity.name).set(identity.version, packageEntry);
        continue;
      }
      if (indent >= 4 && packageEntry) {
        const inline = trimmed.match(
          /^resolution:.*\bintegrity:\s*([^,}\s]+)/u,
        );
        const multiline = trimmed.match(/^integrity:\s*([^,}\s]+)/u);
        const integrity = inline?.[1] ?? multiline?.[1];
        if (integrity) {
          packageEntry.integrity = integrity;
        }
      }
    }
  }

  return { lockfileVersion, catalogs, importers, packages };
}

export function parsePnpmLock(content) {
  const rawDocuments = content
    .split(/(?:^|\n)---\r?\n/u)
    .filter((doc) => doc.trim().length > 0);
  const documents = rawDocuments.map(parsePnpmLockDocument);
  const workspaceDoc = documents.at(-1) ?? {
    lockfileVersion: undefined,
    catalogs: new Map(),
    importers: new Map(),
    packages: new Map(),
  };
  const allPackages = new Map();
  for (const doc of documents) {
    for (const [name, versions] of doc.packages) {
      if (!allPackages.has(name)) {
        allPackages.set(name, new Map());
      }
      for (const [ver, entry] of versions) {
        allPackages.get(name).set(ver, entry);
      }
    }
  }
  return {
    lockfileVersion: workspaceDoc.lockfileVersion,
    lockfileVersions: documents.map((doc) => doc.lockfileVersion),
    catalogs: workspaceDoc.catalogs,
    importers: workspaceDoc.importers,
    packages: workspaceDoc.packages,
    allPackages,
  };
}

function lockedDependency(lock, importerPath, section, packageName) {
  return lock.importers.get(importerPath)?.[section]?.[packageName];
}

function relativeWorkspaceLink(fromDirectory, toDirectory) {
  return `link:${path.posix.relative(fromDirectory, toDirectory)}`;
}

function lockVersionMatchesCatalog(actualVersion, name, catalogSpec) {
  const parsed = parseCatalogSpec(name, catalogSpec);
  if (parsed === null || typeof actualVersion !== "string") {
    return false;
  }
  const expectedPrefix = parsed.isAlias
    ? `${parsed.packageName}@${parsed.version}`
    : parsed.version;
  return (
    actualVersion === expectedPrefix ||
    actualVersion.startsWith(`${expectedPrefix}(`)
  );
}

/**
 * D84 structural lockfile check: validates lockfile version, exact catalog
 * entries, workspace importer links, SHA-512 integrity on every locked
 * package, and reviewed install-script entries without pinning a brittle
 * whole-file SHA-256.
 */
export function checkLockfile(lock, add) {
  const relativeLock = "pnpm-lock.yaml";
  const versions = lock.lockfileVersions ?? [lock.lockfileVersion];
  if (versions.length === 0 || versions.some((version) => version !== "9.0")) {
    add("deps.lock", relativeLock, "lockfileVersion must be 9.0");
  }

  const defaultCatalog = lock.catalogs.get("default") ?? {};
  for (const [name, expectedSpec] of Object.entries(REVIEWED_CATALOG)) {
    const lockedCatalog = defaultCatalog[name];
    const parsed = parseCatalogSpec(name, expectedSpec);
    if (!lockedCatalog || !parsed) {
      add("deps.lock", relativeLock, `missing locked catalog entry ${name}`);
      continue;
    }
    if (
      lockedCatalog.specifier !== expectedSpec ||
      lockedCatalog.version !== parsed.version
    ) {
      add(
        "deps.lock",
        relativeLock,
        `locked catalog entry ${name} does not match ${expectedSpec}`,
      );
    }
  }

  for (const name of ROOT_DEV_DEPENDENCIES) {
    const dependency = lockedDependency(lock, ".", "devDependencies", name);
    const expectedSpec = REVIEWED_CATALOG[name];
    if (!dependency) {
      add("deps.lock", relativeLock, `missing root dependency ${name}`);
      continue;
    }
    if (
      dependency.specifier !== "catalog:" ||
      !lockVersionMatchesCatalog(dependency.version, name, expectedSpec)
    ) {
      add(
        "deps.lock",
        relativeLock,
        `${name} root lock entry does not match ${expectedSpec}`,
      );
    }
  }

  for (const spec of PACKAGE_SPECS) {
    const importer = lock.importers.get(spec.dir);
    if (!importer) {
      add("deps.lock", relativeLock, `missing lock entry for ${spec.dir}`);
      continue;
    }
    for (const name of spec.external) {
      const expectedSpec = REVIEWED_CATALOG[name];
      const dependency = lockedDependency(lock, spec.dir, "dependencies", name);
      if (!dependency) {
        add(
          "deps.lock",
          relativeLock,
          `missing locked dependency ${name} for ${spec.dir}`,
        );
        continue;
      }
      if (
        dependency.specifier !== "catalog:" ||
        !lockVersionMatchesCatalog(dependency.version, name, expectedSpec)
      ) {
        add(
          "deps.lock",
          relativeLock,
          `${name} lock entry for ${spec.dir} does not match ${expectedSpec}`,
        );
      }
    }
    for (const name of spec.internal) {
      const internalSpec = PACKAGE_BY_NAME.get(name);
      if (!internalSpec) {
        continue;
      }
      const internalSection = spec.publishable
        ? "devDependencies"
        : "dependencies";
      const dependency = lockedDependency(
        lock,
        spec.dir,
        internalSection,
        name,
      );
      const expectedLink = relativeWorkspaceLink(spec.dir, internalSpec.dir);
      if (!dependency) {
        add(
          "deps.lock",
          relativeLock,
          `missing workspace dependency ${name} for ${spec.dir}`,
        );
        continue;
      }
      if (
        dependency.specifier !== "workspace:*" ||
        dependency.version !== expectedLink
      ) {
        add(
          "deps.lock",
          relativeLock,
          `${name} must link through ${expectedLink} for ${spec.dir}`,
        );
      }
    }
  }

  for (const [name, expectedSpec] of Object.entries(REVIEWED_CATALOG)) {
    const parsed = parseCatalogSpec(name, expectedSpec);
    if (!parsed) {
      continue;
    }
    const installed = lock.packages
      .get(parsed.packageName)
      ?.get(parsed.version);
    if (!installed) {
      add(
        "deps.lock",
        relativeLock,
        `missing locked package ${parsed.packageName}@${parsed.version}`,
      );
      continue;
    }
    if (
      typeof installed.integrity !== "string" ||
      !installed.integrity.startsWith("sha512-")
    ) {
      add(
        "deps.lock",
        relativeLock,
        `${parsed.packageName} is missing a SHA-512 integrity value`,
      );
    }
  }

  for (const [pkgName, versions] of lock.allPackages ?? lock.packages) {
    for (const [ver, entry] of versions) {
      if (
        typeof entry.integrity !== "string" ||
        !entry.integrity.startsWith("sha512-")
      ) {
        add(
          "deps.lock",
          relativeLock,
          `${pkgName}@${ver} is missing a SHA-512 integrity value`,
        );
      }
    }
  }

  for (const identity of REVIEWED_INSTALL_SCRIPTS.keys()) {
    const parsed = parsePackageIdentity(identity);
    if (!parsed || !lock.packages.get(parsed.name)?.has(parsed.version)) {
      add(
        "deps.review",
        relativeLock,
        `reviewed install-script package ${identity} is missing`,
      );
    }
  }
}

export async function checkPackagePackaging(
  root,
  spec,
  rootLicense,
  requireBuilt,
  add,
  { skipPack = false } = {},
) {
  const packTimeoutMs = process.platform === "win32" ? 60_000 : 10_000;
  const relativeLicense = `${spec.dir}/LICENSE`;
  try {
    const license = await readFile(path.join(root, relativeLicense));
    if (rootLicense && !license.equals(rootLicense)) {
      add(
        "pkg.license",
        relativeLicense,
        "package LICENSE must be byte-for-byte identical to root LICENSE",
      );
    }
  } catch (error) {
    add(
      "pkg.license",
      relativeLicense,
      `cannot read package LICENSE: ${error.message}`,
    );
  }

  if (!spec.publishable || skipPack) {
    return;
  }

  let output;
  try {
    const npm = npmExecutable();
    const result = await execFileAsync(
      npm.command,
      [
        ...npm.prefixArgs,
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--offline",
      ],
      {
        cwd: path.join(root, spec.dir),
        encoding: "utf8",
        timeout: packTimeoutMs,
        maxBuffer: 1_048_576,
        shell: npm.command === "npm" && process.platform === "win32",
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    );
    output = result.stdout;
  } catch (error) {
    const reason = error.killed
      ? `timed out after ${packTimeoutMs} ms`
      : `${error.code ?? "unknown"}: ${(error.stderr?.trim() || error.message).slice(0, 1_000)}`;
    add("pkg.pack", spec.dir, `npm pack --dry-run failed (${reason})`);
    return;
  }

  let packages;
  try {
    packages = JSON.parse(output);
  } catch {
    add("pkg.pack", spec.dir, "npm pack did not return valid JSON");
    return;
  }
  if (
    !Array.isArray(packages) ||
    packages.length !== 1 ||
    !Array.isArray(packages[0]?.files) ||
    !packages[0].files.every((file) => typeof file?.path === "string")
  ) {
    add(
      "pkg.pack",
      spec.dir,
      "npm pack must return one package with a file path list",
    );
    return;
  }
  const packedPaths = packages[0].files.map((file) => file.path);
  const requiredPaths = ["README.md", "LICENSE", "package.json"];
  for (const packedPath of packedPaths) {
    if (
      !packedPath.startsWith("dist/") &&
      !requiredPaths.includes(packedPath)
    ) {
      add(
        "pkg.pack",
        spec.dir,
        `tarball contains unreviewed path ${packedPath}`,
      );
    }
  }
  for (const requiredPath of requiredPaths) {
    if (!packedPaths.includes(requiredPath)) {
      add("pkg.pack", spec.dir, `tarball is missing ${requiredPath}`);
    }
  }
  if (
    requireBuilt &&
    !packedPaths.some((packedPath) => packedPath.startsWith("dist/"))
  ) {
    add(
      "pkg.pack",
      spec.dir,
      "tarball is missing dist output; run pnpm run build",
    );
  }
  if (requireBuilt && Array.isArray(spec.bundledExtras)) {
    for (const extra of spec.bundledExtras) {
      if (!packedPaths.includes(extra.output)) {
        add(
          "pkg.pack",
          spec.dir,
          `tarball is missing ${extra.output}; run pnpm run build`,
        );
      }
    }
  }
}

export async function checkBuiltEntries(root, files, add) {
  for (const spec of PACKAGE_SPECS) {
    const manifestPath = path.join(root, spec.dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const rootExport = manifest.exports?.["."];
    if (!rootExport || typeof rootExport !== "object") {
      continue;
    }
    const sourceCandidates = files.filter(
      (relativePath) =>
        relativePath.startsWith(`${spec.dir}/src/`) ||
        relativePath === `${spec.dir}/package.json` ||
        relativePath === `${spec.dir}/tsconfig.json` ||
        relativePath === `${spec.dir}/build.mjs`,
    );
    const sourceTimes = await Promise.all(
      sourceCandidates.map(async (relativePath) => {
        return (await stat(path.join(root, relativePath))).mtimeMs;
      }),
    );
    const newestSourceTime = Math.max(0, ...sourceTimes);
    const entrySourcePath = path.join(root, spec.dir, "src", "index.ts");
    const entrySourceTime = existsSync(entrySourcePath)
      ? (await stat(entrySourcePath)).mtimeMs
      : 0;
    const buildInfoPath = path.join(root, spec.dir, ".tsbuildinfo");
    const buildInfoTime = existsSync(buildInfoPath)
      ? (await stat(buildInfoPath)).mtimeMs
      : 0;
    for (const field of ["types", "import"]) {
      const target = rootExport[field];
      if (typeof target !== "string") {
        continue;
      }
      const absoluteTarget = path.resolve(path.dirname(manifestPath), target);
      if (!isInside(path.join(root, spec.dir), absoluteTarget)) {
        add(
          "pkg.built",
          `${spec.dir}/package.json`,
          `${field} target escapes the package`,
        );
      } else if (!existsSync(absoluteTarget)) {
        add(
          "pkg.built",
          projectPath(root, absoluteTarget),
          `${field} target is missing; run pnpm run build`,
        );
      } else {
        const targetTime = (await stat(absoluteTarget)).mtimeMs;
        if (
          targetTime < entrySourceTime ||
          Math.max(targetTime, buildInfoTime) < newestSourceTime
        ) {
          add(
            "pkg.built",
            projectPath(root, absoluteTarget),
            `${field} target is older than its source; run pnpm run build`,
          );
        }
      }
    }
    if (Array.isArray(spec.bundledExtras)) {
      for (const extra of spec.bundledExtras) {
        const extraTarget = path.resolve(
          path.dirname(manifestPath),
          extra.output,
        );
        const extraSource = path.join(root, extra.source);
        if (!existsSync(extraTarget)) {
          add(
            "pkg.built",
            projectPath(root, extraTarget),
            `bundled entry ${extra.output} is missing; run pnpm run build`,
          );
        } else if (
          existsSync(extraSource) &&
          (await stat(extraTarget)).mtimeMs < (await stat(extraSource)).mtimeMs
        ) {
          add(
            "pkg.built",
            projectPath(root, extraTarget),
            `bundled entry ${extra.output} is older than ${extra.source}; run pnpm run build`,
          );
        }
      }
    }
  }
}
