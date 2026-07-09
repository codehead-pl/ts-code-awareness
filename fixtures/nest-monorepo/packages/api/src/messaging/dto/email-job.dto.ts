/** BullMQ job payload DTO — the `T` of the `Job<T>` consumed by the `send`
 *  @Process handler. The adapter unwraps `Job<EmailJob>` → `EmailJob` and links
 *  it under the messaging handler's `dto` refs. */
export class EmailJob {
  to!: string;
  subject!: string;
}
