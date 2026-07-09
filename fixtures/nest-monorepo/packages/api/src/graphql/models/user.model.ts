import { Field, Int, ObjectType } from '@nestjs/graphql';

/** GraphQL object type for a user. Kept distinct from the Prisma `User` model
 *  and the `@fixture/core` `User` DTO so each layer's mapping is unambiguous. */
@ObjectType()
export class UserModel {
  @Field(() => Int)
  id!: number;

  @Field()
  email!: string;
}

@ObjectType()
export class PostModel {
  @Field(() => Int)
  id!: number;

  @Field()
  title!: string;
}
