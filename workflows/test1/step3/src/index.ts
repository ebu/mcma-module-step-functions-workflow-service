import { Context } from "aws-lambda";
import { captureAWSv3Client } from "aws-xray-sdk-core";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

import { AmeJob, McmaException, McmaTracker, NotificationEndpointProperties } from "@mcma/core";
import { AwsCloudWatchLoggerProvider, getLogGroupName } from "@mcma/aws-logger";
import { S3Locator } from "@mcma/aws-s3";
import { AuthProvider, getResourceManagerConfig, ResourceManager } from "@mcma/client";
import { awsV4Auth } from "@mcma/aws-client";

const cloudWatchLogsClient = captureAWSv3Client(new CloudWatchLogsClient({}));

const loggerProvider = new AwsCloudWatchLoggerProvider("test1-workflow-step1", getLogGroupName(), cloudWatchLogsClient);
const resourceManager = new ResourceManager(getResourceManagerConfig(), new AuthProvider().add(awsV4Auth()));

type InputEvent = {
    input?: {
        inputFile?: S3Locator
    }
    data?: {
        jobId?: string
    }
    tracker?: McmaTracker
    notificationEndpoint?: NotificationEndpointProperties
}

export async function handler(event: InputEvent, context: Context) {
    const logger = await loggerProvider.get(context.awsRequestId, event.tracker);
    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        const job = await resourceManager.get<AmeJob>(event.data.jobId);

        return job.jobOutput
    } catch (error) {
        logger.error("Failed to validate workflow input");
        logger.error(error);
        throw new McmaException("Failed to validate workflow input", error);
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}
