import { Context } from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk-core";

import { AuthProvider, ResourceManagerProvider } from "@mcma/client";
import { ProviderCollection, Worker, WorkerRequest, WorkerRequestProperties } from "@mcma/worker";
import { DynamoDbTableProvider } from "@mcma/aws-dynamodb";
import { AwsCloudWatchLoggerProvider } from "@mcma/aws-logger";
import { awsV4Auth } from "@mcma/aws-client";
import { processCancel, processJobAssignment, processNotification } from "./operations";

const { LogGroupName } = process.env;

const AWS = AWSXRay.captureAWS(require("aws-sdk"));

const authProvider = new AuthProvider().add(awsV4Auth(AWS));
const dbTableProvider = new DynamoDbTableProvider();
const loggerProvider = new AwsCloudWatchLoggerProvider("workflow-service-worker", LogGroupName);
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
    const logger = loggerProvider.get(context.awsRequestId, event.tracker);

    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        await worker.doWork(new WorkerRequest(event, logger), {
            awsRequestId: context.awsRequestId,
            stepFunctions: new AWS.StepFunctions(),
            cloudWatchEvents: new AWS.CloudWatchEvents(),
        });
    } catch (error) {
        logger.error("Error occurred when handling operation '" + event.operationName + "'");
        logger.error(error.toString());
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}
