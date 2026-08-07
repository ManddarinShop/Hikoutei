import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { UsersService } from "./users.service.js";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  async create(@Body() body: { id: string; name: string }) {
    await this.users.create(body.id, body.name);
    return { id: body.id };
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }
}
