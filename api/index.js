// Vercel serverless entry — re-exports the main handler from index.js.
// The real routing + logic lives in index.js so the same file also runs
// standalone (`node index.js` / `npm start`).
export { default } from "../index.js";
