import { repairStuckSpecRounds } from "../services/spec-battle-repair-service";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const execute = process.argv.includes("--execute");
const changeId = argValue("--change-id") ?? argValue("--change");
const minAgeMinutesText = argValue("--min-age-minutes");
const minAgeMs = minAgeMinutesText ? Number(minAgeMinutesText) * 60 * 1000 : undefined;

const results = repairStuckSpecRounds({
  changeId,
  execute,
  minAgeMs,
});

console.log(JSON.stringify({
  mode: execute ? "execute" : "dry-run",
  results,
}, null, 2));
