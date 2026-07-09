/** RPC payload DTO — the `@Payload()` of the `sum` @MessagePattern handler.
 *  Linked from the messaging handler's `dto` refs (payload → DTO type). */
export class SumPayload {
  numbers!: number[];
}
