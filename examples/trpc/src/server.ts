import express from "express";
import * as trpcExpress from "@trpc/server/adapters/express";
import { hikoutei } from "./runtime.js";
import { createContext } from "./context.js";
import { appRouter } from "./router.js";

const app = express();

app.use(
  "/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext: ({}) => createContext(hikoutei, true),
  }),
);

app.listen(3000, () => console.log("tRPC on http://localhost:3000/trpc"));

process.on("SIGINT", () => void hikoutei.close());
process.on("SIGTERM", () => void hikoutei.close());
