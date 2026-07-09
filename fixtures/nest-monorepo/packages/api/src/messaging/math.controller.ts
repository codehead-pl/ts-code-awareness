import { Controller, UseGuards } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
} from '@nestjs/microservices';
import { AuthGuard } from '../common/guards/auth.guard';
import { SumPayload } from './dto/sum.payload';
import { UserCreatedEvent } from './dto/user-created.event';

/** A microservices controller. `@MessagePattern` is request/response (RPC);
 *  `@EventPattern` is fire-and-forget. The class-level guard applies to every
 *  handler — it stacks under the global pipeline exactly like a REST controller's
 *  `@UseGuards`, exercising nest_pipeline_for on a message handler via the RPC
 *  execution context. */
@Controller()
@UseGuards(AuthGuard)
export class MathController {
  // Request/response message pattern over TCP; payload links to SumPayload.
  @MessagePattern('sum', Transport.TCP)
  accumulate(@Payload() payload: SumPayload): number {
    return payload.numbers.reduce((a, b) => a + b, 0);
  }

  // Fire-and-forget event; payload links to UserCreatedEvent.
  @EventPattern('user.created')
  handleUserCreated(@Payload() event: UserCreatedEvent): void {
    void event.userId;
  }
}
