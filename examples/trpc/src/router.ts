import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { User } from "./runtime.js";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
  createUser: t.procedure
    .input(z.object({ id: z.string(), name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      ctx.em.persist(ctx.em.create(User, input));
      await ctx.em.flush();
      return { id: input.id };
    }),
  getUser: t.procedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => ctx.em.findOne(User, { id: input.id })),
});

export type AppRouter = typeof appRouter;
