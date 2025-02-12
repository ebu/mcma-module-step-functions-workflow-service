import { Context } from "aws-lambda";
import { captureAWSv3Client } from "aws-xray-sdk-core";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

import { McmaException, McmaTracker } from "@mcma/core";
import { AwsCloudWatchLoggerProvider, getLogGroupName } from "@mcma/aws-logger";
import { S3Locator } from "@mcma/aws-s3";
import { default as axios } from "axios";

const cloudWatchLogsClient = captureAWSv3Client(new CloudWatchLogsClient({}));

const loggerProvider = new AwsCloudWatchLoggerProvider("test1-workflow-step1", getLogGroupName(), cloudWatchLogsClient);

type InputEvent = {
    input?: {
        inputFile?: S3Locator
    }
    tracker?: McmaTracker
}

export async function handler(event: InputEvent, context: Context) {
    const logger = await loggerProvider.get(context.awsRequestId, event.tracker);
    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        // check the input and return mediaFileLocator which service as input for the AI workflows
        if (!event?.input) {
            throw new McmaException("Missing workflow input");
        }

        if (!event.input.inputFile) {
            throw new McmaException("Missing inputFile parameter in workflow input");
        }

        const { inputFile } = event.input;

        try {
            const result = await axios.get(inputFile.url, { headers: { Range: "bytes=0-0" } });

            logger.info(result);
        } catch (error) {
            throw new McmaException("Input file is not retrievable due to error: " + error.message);
        }
    } catch (error) {
        logger.error("Failed to validate workflow input");
        logger.error(error);
        throw new McmaException("Failed to validate workflow input", error);
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}
