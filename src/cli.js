import { exportHelpText, runExport } from "./export.js";
import { runValidate, validateHelpText } from "./validate.js";

const VERSION = "0.1.0";

function printRootHelp() {
  console.log(`datafast-to-rybbit v${VERSION}

Export DataFast analytics to Umami-format CSV for Rybbit import.

Usage:
  datafast-to-rybbit export [options]
  datafast-to-rybbit validate [options]

Commands:
  export    Fetch visitors from DataFast and write Umami CSV files
  validate  Check CSV headers and date formats

Run \`datafast-to-rybbit <command> --help\` for command options.
`);
}

export async function runCli(argv) {
  const [, , command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printRootHelp();
    return;
  }

  if (command === "export") {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(exportHelpText());
      return;
    }

    await runExport(rest);
    return;
  }

  if (command === "validate") {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(validateHelpText());
      return;
    }

    await runValidate(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}. Run datafast-to-rybbit --help`);
}
