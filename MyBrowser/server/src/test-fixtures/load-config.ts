import { loadOrCreateConfig } from "../auth.js";

process.stdout.write(JSON.stringify(loadOrCreateConfig({ port: Number(process.argv[2]) })));
