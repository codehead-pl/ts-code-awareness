import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { User } from '@fixture/core';
import { AuthGuard } from '../common/guards/auth.guard';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

/** REST controller. Controller-level guard applies to every route. */
@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async findAll(): Promise<User[]> {
    // A route handler that ALSO touches the DB directly: this makes `findAll`
    // both a route handler and a prisma:access caller (exercises W6 roles).
    await this.prisma.post.count();
    return this.usersService.findAll();
  }

  // Param-level pipe: ParseIntPipe runs on `id` after any global/controller/
  // method pipes (exercises W5 param-pipe composition).
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  // Method-level guard stacks on top of the controller-level one. The body is
  // validated by an inline `new ValidationPipe()` param pipe (manual, no DI).
  @Post()
  @UseGuards(AuthGuard)
  create(@Body(new ValidationPipe()) dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }
}
