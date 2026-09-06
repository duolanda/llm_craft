import { runRecordCompression } from "../src/RecordCompression";

runRecordCompression(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
