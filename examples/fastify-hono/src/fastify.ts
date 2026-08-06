import Fastify from "fastify";
import { hikoutei, User, shutdown } from "./shared.js";

const app = Fastify({ logger: true });

app.addHook("onRequest", async (request) => {
  (request as any).em = hikoutei.em.fork();
});

app.get("/users/:id", async (request, reply) => {
  const user = await (request as any).em.findOne(User, { id: (request.params as any).id });
  if (user === null) return reply.code(404).send({ error: "not found" });
  return user;
});

app.post("/users", async (request, reply) => {
  const em = (request as any).em;
  const body = request.body as { id: string; name: string };
  em.persist(em.create(User, body));
  await em.flush();
  return reply.code(201).send({ id: body.id });
});

await app.listen({ port: 3000 });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
