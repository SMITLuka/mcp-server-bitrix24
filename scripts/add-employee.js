import { config } from "../src/config.js";
import { createEmployee } from "../src/db.js";

const name = process.argv[2];
if (!name) {
  console.error("Usage: npm run add-employee -- \"Ime Prezime\"");
  process.exit(1);
}

const apiKey = createEmployee(name);

console.log(`Employee "${name}" created.`);
console.log(`\nSend them these two things:`);
console.log(`1) API key for their Claude Code MCP config: ${apiKey}`);
console.log(`2) One-time Bitrix24 login link: ${config.baseUrl}/oauth/start?key=${apiKey}`);
