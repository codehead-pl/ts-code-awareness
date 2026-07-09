import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@fixture/core';

/** Request body DTO validated by the global ValidationPipe. */
export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsEnum(Role)
  role!: Role;
}
