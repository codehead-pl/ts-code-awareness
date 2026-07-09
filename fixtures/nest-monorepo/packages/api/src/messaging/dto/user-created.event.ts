/** Event payload DTO — the `@Payload()` of the `user.created` @EventPattern
 *  handler. Linked from the messaging handler's `dto` refs. */
export class UserCreatedEvent {
  userId!: string;
}
