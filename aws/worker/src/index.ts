import { Context } from "aws-lambda";
import { captureAWSv3Client } from "aws-xray-sdk-core";
import { CloudWatchEventsClient } from "@aws-sdk/client-cloudwatch-events";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient} from "@aws-sdk/client-sfn";

import { AuthProvider, ResourceManagerProvider } from "@mcma/client";
import { ProviderCollection, Worker, WorkerRequest, WorkerRequestProperties } from "@mcma/worker";
import { DynamoDbTableProvider } from "@mcma/aws-dynamodb";
import { AwsCloudWatchLoggerProvider, getLogGroupName } from "@mcma/aws-logger";
import { awsV4Auth } from "@mcma/aws-client";
import { processCancel, processJobAssignment, processNotification } from "./operations";

const cloudWatchLogsClient = captureAWSv3Client(new CloudWatchLogsClient({}));
const cloudWatchEventsClient = captureAWSv3Client(new CloudWatchEventsClient({}));
const dynamoDBClient = captureAWSv3Client(new DynamoDBClient({}));
const sfnClient = captureAWSv3Client(new SFNClient({}));

const authProvider = new AuthProvider().add(awsV4Auth());
const dbTableProvider = new DynamoDbTableProvider({}, dynamoDBClient);
const loggerProvider = new AwsCloudWatchLoggerProvider("workflow-service-worker", getLogGroupName(), cloudWatchLogsClient);
const resourceManagerProvider = new ResourceManagerProvider(authProvider);

const providerCollection = new ProviderCollection({
    authProvider,
    dbTableProvider,
    loggerProvider,
    resourceManagerProvider
});

const worker =
    new Worker(providerCollection)
        .addOperation("ProcessCancel", processCancel)
        .addOperation("ProcessJobAssignment", processJobAssignment)
        .addOperation("ProcessNotification", processNotification);

export async function handler(event: WorkerRequestProperties, context: Context) {
    const logger = await loggerProvider.get(context.awsRequestId, event.tracker);

    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        await worker.doWork(new WorkerRequest(event, logger), {
            awsRequestId: context.awsRequestId,
            sfnClient,
            cloudWatchEventsClient,
        });
    } catch (error) {
        logger.error("Error occurred when handling operation '" + event.operationName + "'");
        logger.error(error);
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}
