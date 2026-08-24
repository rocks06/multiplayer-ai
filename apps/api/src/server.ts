import { buildApp } from "./app.js";
const app=buildApp();
const port=Number(process.env.PORT??4100); const host=process.env.HOST??'127.0.0.1';
await app.listen({port,host});
console.log(`Room Engine API listening on http://${host}:${port}`);
