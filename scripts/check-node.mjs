const minimum = { major: 22, minor: 13 };
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > minimum.major || (major === minimum.major && minor >= minimum.minor);

if (!supported) {
  console.error([
    `[environment] Node ${minimum.major}.${minimum.minor} or newer is required; found ${process.versions.node}.`,
    "Activate the version in .nvmrc (currently Node 24) before running project commands.",
    "The SQLite-backed tests use the built-in node:sqlite module and cannot run on Node 20.",
  ].join("\n"));
  process.exitCode = 1;
}
