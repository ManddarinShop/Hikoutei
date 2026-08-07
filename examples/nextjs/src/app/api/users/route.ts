import { NextResponse } from "next/server";
import { getHikoutei, User } from "../../../lib/hikoutei";

export async function POST(request: Request) {
  const body = (await request.json()) as { id: string; name: string };
  const hikoutei = await getHikoutei();
  const em = hikoutei.em.fork();
  em.persist(em.create(User, body));
  await em.flush();
  return NextResponse.json({ id: body.id }, { status: 201 });
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (id === null) return NextResponse.json({ error: "id required" }, { status: 400 });
  const hikoutei = await getHikoutei();
  const user = await hikoutei.em.fork().findOne(User, { id });
  if (user === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(user);
}
