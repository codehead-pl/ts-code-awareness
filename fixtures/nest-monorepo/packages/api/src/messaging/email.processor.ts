import { Process, Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EmailJob } from './dto/email-job.dto';

/** A BullMQ consumer. `@Processor('email')` binds the class to the `email`
 *  queue; each `@Process('send')` handles a named job, receiving the typed
 *  `Job<EmailJob>` payload (the adapter unwraps `Job<T>` → `T`). */
@Processor('email')
export class EmailProcessor {
  @Process('send')
  async sendEmail(job: Job<EmailJob>): Promise<void> {
    void job.data.to;
  }
}
