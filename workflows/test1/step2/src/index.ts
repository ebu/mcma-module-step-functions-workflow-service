import { Context } from "aws-lambda";

import { AmeJob, JobParameterBag, JobProfile, McmaException, McmaTracker, NotificationEndpoint, NotificationEndpointProperties } from "@mcma/core";
import { AwsCloudWatchLoggerProvider } from "@mcma/aws-logger";
import { S3Locator } from "@mcma/aws-s3";
import * as AWS from "aws-sdk";
import { awsV4Auth } from "@mcma/aws-client";
import { AuthProvider, getResourceManagerConfig, ResourceManager } from "@mcma/client";

const loggerProvider = new AwsCloudWatchLoggerProvider("test1-workflow-step2", process.env.LogGroupName);
const resourceManager = new ResourceManager(getResourceManagerConfig(), new AuthProvider().add(awsV4Auth(AWS)));

const stepFunctions = new AWS.StepFunctions();

const { ActivityArn } = process.env;

type InputEvent = {
    input?: {
        inputFile?: S3Locator
    }
    tracker?: McmaTracker
    notificationEndpoint?: NotificationEndpointProperties
}

export async function handler(event: InputEvent, context: Context) {
    const logger = loggerProvider.get(context.awsRequestId, event.tracker);
    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        const data = await stepFunctions.getActivityTask({ activityArn: ActivityArn }).promise();

        const taskToken = data.taskToken;
        if (!taskToken) {
            throw new McmaException("Failed to obtain activity task");
        }

        // using input from activity task to ensure we don't have race conditions if two workflows execute simultaneously.
        event = JSON.parse(data.input);

        const notificationUrl = event.notificationEndpoint.httpEndpoint + "?taskToken=" + encodeURIComponent(taskToken);
        logger.info("NotificationUrl:", notificationUrl);

        const [jobProfile] = await resourceManager.query(JobProfile, { name: "ExtractTechnicalMetadata" });

        // creating ame job
        let ameJob = new AmeJob({
            jobProfileId: jobProfile.id,
            jobInput: new JobParameterBag({
                inputFile: event.input.inputFile
            }),
            notificationEndpoint: new NotificationEndpoint({
                httpEndpoint: notificationUrl
            }),
            tracker: event.tracker
        });

        logger.info("Sending AmeJob:", JSON.stringify(ameJob, null, 2));

        ameJob = await resourceManager.create(ameJob);

        return ameJob.id;
    } catch (error) {
        logger.error("Failed to create job");
        logger.error(error.toString());
        throw new McmaException("Failed to create job", error);
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}
