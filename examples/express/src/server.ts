import express from "express";
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const app = express();
app.use(express.json());

// Request-scoped EntityManager: fork per request, never share one across
// concurrent requests.
app.use((req, _res, next) => {
  (req as any).em = hikoutei.em.fork();
  next();
});

app.post("/users", async (req, res) => {
  const em = (req as any).em;
  em.persist(em.create(User, { id: req.body.id, name: req.body.name }));
  await em.flush();
  res.status(201).json({ id: req.body.id });
});

app.get("/users/:id", async (req, res) => {
  const user = await (req as any).em.findOne(User, { id: req.params.id });
  if (user === null) return res.status(404).json({ error: "not found" });
  res.json(user);
});

app.patch("/users/:id", async (req, res) => {
  const em = (req as any).em;
  const user = await em.findOne(User, { id: req.params.id });
  if (user === null) return res.status(404).json({ error: "not found" });
  user.name = req.body.name;
  await em.flush();
  res.json(user);
});

app.delete("/users/:id", async (req, res) => {
  const em = (req as any).em;
  const user = await em.findOne(User, { id: req.params.id });
  if (user === null) return res.status(404).json({ error: "not found" });
  em.remove(user);
  await em.flush();
  res.status(204).end();
});

const server = app.listen(3000, () => {
  console.log("listening on http://localhost:3000");
});

async function shutdown() {
  server.close();
  await hikoutei.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
