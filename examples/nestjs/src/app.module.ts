import { Module } from "@nestjs/common";
import { HikouteiModule } from "./hikoutei.module.js";
import { UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

@Module({
  imports: [HikouteiModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class AppModule {}
