import { Hono } from "hono";
import { hikoutei, User, shutdown } from "./shared.js";

const app = new Hono();

// Honojs middleware: one fork per request.
app.use("*", async (c, next) => {
  (c as any).em = hikoutei.em.fork();
  await next();
});

app.get("/users/:id", async (c) => {
  const user = await (c as any).em.findOne(User, { id: c.req.param("id") });
  if (user === null) return c.json({ error: "not found" }, 404);
  return c.json(user);
});

app.post("/users", async (c) => {
  const em = (c as any).em;
  const body = await c.req.json<{ id: string; name: string }>();
  em.persist(em.create(User, body));
  await em.flush();
  return c.json({ id: body.id }, 201);
});

export default app;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
