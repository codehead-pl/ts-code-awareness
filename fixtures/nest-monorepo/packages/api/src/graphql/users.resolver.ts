import {
  Args,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { ParseIntPipe, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { UsersService } from '../users/users.service';
import { CreateUserInput } from './dto/create-user.input';
import { PostModel, UserModel } from './models/user.model';

/** GraphQL resolver for the `UserModel` object type. The class-level guard
 *  applies to every operation (it stacks under the global pipeline exactly like a
 *  REST controller's @UseGuards — exercises nest_pipeline_for on a resolver). */
@Resolver(() => UserModel)
@UseGuards(AuthGuard)
export class UsersResolver {
  constructor(private readonly usersService: UsersService) {}

  // A list query: return type is `[UserModel]`, handler symbol is `users`.
  @Query(() => [UserModel], { name: 'users' })
  async users(): Promise<UserModel[]> {
    const all = await this.usersService.findAll();
    return all.map((u, i) => ({ id: i + 1, email: u.email }));
  }

  // A single-item query with an @Args param carrying a pipe.
  @Query(() => UserModel, { nullable: true })
  async user(@Args('id', ParseIntPipe) id: number): Promise<UserModel | null> {
    const u = await this.usersService.findOne(String(id));
    return u ? { id, email: u.email } : null;
  }

  // A mutation whose @Args('input') payload links to the CreateUserInput DTO.
  @Mutation(() => UserModel)
  async createUser(@Args('input') input: CreateUserInput): Promise<UserModel> {
    const u = await this.usersService.create({ email: input.email } as never);
    return { id: 0, email: u.email };
  }

  // A field resolver: resolves the `posts` field of the parent UserModel.
  @ResolveField(() => [PostModel])
  posts(@Parent() user: UserModel, @Args('take', { type: () => Int, nullable: true }) take?: number): PostModel[] {
    return [{ id: user.id, title: `post-${take ?? 0}` }];
  }
}
