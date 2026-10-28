import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export class SqsGateway {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(private readonly config: AppConfig['sqs']) {
    this.client = new SQSClient({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
    });
  }

  async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const res = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!res.QueueUrl) throw new Error(`Queue ${name} not found`);
    this.urls.set(name, res.QueueUrl);
    return res.QueueUrl;
  }

  inputQueueUrl() {
    return this.queueUrl(this.config.inputQueue);
  }
  dlqUrl() {
    return this.queueUrl(this.config.dlqQueue);
  }
  eventsQueueUrl() {
    return this.queueUrl(this.config.eventsQueue);
  }

  /** Readiness probe: the input queue is reachable and answers within the timeout. */
  async ping(timeoutMs = 2_000): Promise<void> {
    const url = await withTimeout(this.inputQueueUrl(), timeoutMs);
    await withTimeout(
      this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })),
      timeoutMs,
    );
  }

  destroy() {
    this.client.destroy();
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
