import { runConsumerSmoke } from "./consumer-smoke.mjs";

const result = await runConsumerSmoke();

console.log(`unipls consumer: ${result.checks} checks passed`);
