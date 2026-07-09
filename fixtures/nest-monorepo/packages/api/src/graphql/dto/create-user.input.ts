import { Field, InputType } from '@nestjs/graphql';

/** GraphQL input DTO — the `@Args('input')` payload of the createUser mutation.
 *  Linked from the resolver op's `dto` refs (args → DTO type). */
@InputType()
export class CreateUserInput {
  @Field()
  email!: string;
}
