// Lambda looks for a handler in a .js, .mjs or .cjs file. Node strips the
// types from the TypeScript it imports, so the code runs as written.
export { handler } from "./handler.ts";
