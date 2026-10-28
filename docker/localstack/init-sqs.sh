#!/bin/bash
# Runs inside LocalStack once it is ready. Idempotent: create-queue returns the existing URL.
set -euo pipefail
REGION=${AWS_DEFAULT_REGION:-us-east-1}

awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" \
  --queue-url "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# maxReceiveCount must match SQS_MAX_RECEIVE_COUNT in the app.
awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue --region "$REGION" --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready"
