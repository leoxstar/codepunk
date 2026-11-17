import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * A fake search binary has to be executable on the host. A `#!/bin/sh`
 * script works on POSIX but Windows has no shebang handling, and a `.cmd`
 * shim cannot be spawned without a shell. On Windows this helper compiles a
 * tiny native stub once (with the .NET Framework compiler shipped by the OS)
 * and copies it into each fixture directory.
 *
 * Every stub writes the argv it received and an `executed` marker next to
 * itself, then prints `<name>.stdout.txt` byte-for-byte. That covers the
 * argument and output assertions without a shell.
 */

const STUB_SOURCE = String.raw`
using System;
using System.IO;
using System.Reflection;
using System.Text;

internal static class FakeExecutable
{
    private static int Main(string[] args)
    {
        string executable = Assembly.GetExecutingAssembly().Location;
        string directory = Path.GetDirectoryName(executable);
        string name = Path.GetFileNameWithoutExtension(executable);

        File.WriteAllText(Path.Combine(directory, name + ".executed"), "1");
        StringBuilder captured = new StringBuilder();
        foreach (string argument in args)
        {
            captured.Append(argument);
            captured.Append('\n');
        }
        File.WriteAllText(
            Path.Combine(directory, name + ".args.txt"),
            captured.ToString(),
            new UTF8Encoding(false));

        string stdoutPath = Path.Combine(directory, name + ".stdout.txt");
        byte[] output = File.Exists(stdoutPath)
            ? File.ReadAllBytes(stdoutPath)
            : new byte[0];
        using (Stream stdout = Console.OpenStandardOutput())
        {
            stdout.Write(output, 0, output.Length);
        }

        string exitPath = Path.Combine(directory, name + ".exit.txt");
        string environmentPath = Path.Combine(directory, name + ".envname.txt");
        if (File.Exists(environmentPath))
        {
            string environmentName = File.ReadAllText(environmentPath).Trim();
            string environmentValue =
                Environment.GetEnvironmentVariable(environmentName);
            File.WriteAllText(
                Path.Combine(directory, name + ".env-value.txt"),
                environmentValue ?? "unset",
                new UTF8Encoding(false));
        }
        return File.Exists(exitPath)
            ? int.Parse(File.ReadAllText(exitPath).Trim())
            : 0;
    }
}
`;

let stubPromise;

function compilerPath() {
  const windows = process.env["SystemRoot"] ?? "C:\\Windows";
  return path.join(
    windows,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
}

async function compileStub() {
  const directory = path.join(os.tmpdir(), "codepunk-fake-executable-v2");
  const executable = path.join(directory, "stub.exe");
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(os.tmpdir(), "codepunk-fake-executable-v2.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.mkdir(lock);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    try {
      await fs.access(executable);
      return executable;
    } catch {
      // Compile below.
    }
    const compiler = compilerPath();
    try {
      await fs.access(compiler);
    } catch {
      throw new Error(
        `the Windows fake-executable fixture needs ${compiler}; install the .NET Framework compiler`,
      );
    }
    const source = path.join(directory, "stub.cs");
    await fs.writeFile(source, STUB_SOURCE);
    execFileSync(
      compiler,
      ["/nologo", "/optimize+", "/target:exe", `/out:${executable}`, source],
      { stdio: "pipe" },
    );
    return executable;
  } finally {
    if (acquired) {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
}

function nativeStub() {
  stubPromise ??= compileStub();
  return stubPromise;
}

/**
 * Create `name` in `directory` with a fixed stdout and optional exit code.
 * Returns the path the product should resolve from PATH.
 */
export async function writeFakeExecutable(directory, name, options = {}) {
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, name);
  if (process.platform === "win32") {
    await fs.copyFile(await nativeStub(), `${executable}.exe`);
  } else {
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        'directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        `printf '%s\\n' "$@" > "$directory/${name}.args.txt"`,
        `printf '1' > "$directory/${name}.executed"`,
        ...(options.captureEnv === undefined
          ? []
          : [
              `printf '%s' "\${${options.captureEnv}-unset}" > "$directory/${name}.env-value.txt"`,
            ]),
        `[ -f "$directory/${name}.stdout.txt" ] && cat "$directory/${name}.stdout.txt"`,
        `[ -f "$directory/${name}.exit.txt" ] && exit "$(cat "$directory/${name}.exit.txt")"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  await fs.writeFile(
    path.join(directory, `${name}.stdout.txt`),
    options.stdout ?? "",
  );
  if (options.exitCode !== undefined) {
    await fs.writeFile(
      path.join(directory, `${name}.exit.txt`),
      `${options.exitCode}`,
    );
  }
  if (options.captureEnv !== undefined) {
    await fs.writeFile(
      path.join(directory, `${name}.envname.txt`),
      options.captureEnv,
    );
  }
  return process.platform === "win32" ? `${executable}.exe` : executable;
}

export async function readFakeArgs(directory, name) {
  const content = await fs.readFile(
    path.join(directory, `${name}.args.txt`),
    "utf8",
  );
  return content.trim().split("\n");
}

export async function fakeExecuted(directory, name) {
  try {
    await fs.access(path.join(directory, `${name}.executed`));
    return true;
  } catch {
    return false;
  }
}

export async function readFakeEnv(directory, name) {
  return fs.readFile(path.join(directory, `${name}.env-value.txt`), "utf8");
}
